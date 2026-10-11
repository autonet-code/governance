const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Comprehensive Arbitration Tests
 *
 * Tests all arbitration scenarios:
 * - All ruling percentages (0, 1, 25, 33, 50, 67, 75, 99, 100)
 * - Fund distribution after ruling
 * - Arbiter fee payment
 * - Zero balance invariant
 */
describe("Comprehensive Arbitration Tests", function () {
    let economy, nativeProjectImpl, erc20ProjectImpl, testToken, mockRepToken, mockGovernor;
    let deployer, timelock, registry, author, contractor, arbiter, backer1, backer2, backer3;

    const ARBITRATION_FEE_BPS = 100; // 1%
    const PLATFORM_FEE_BPS = 250;
    const AUTHOR_FEE_BPS = 500;
    const PROJECT_THRESHOLD = ethers.parseEther("1000");

    async function createERC20Project() {
        const tx = await economy.connect(author).createERC20Project(
            "Test Project", contractor.address, arbiter.address, "terms", "repo", "desc",
            await testToken.getAddress()
        );
        const receipt = await tx.wait();
        const projectAddress = receipt.logs.find(log => log.eventName === 'NewProject').args.contractAddress;
        return ethers.getContractAt("ERC20Project", projectAddress);
    }

    async function createNativeProject() {
        const tx = await economy.connect(author).createProject(
            "Test Project", contractor.address, arbiter.address, "terms", "repo", "desc"
        );
        const receipt = await tx.wait();
        const projectAddress = receipt.logs.find(log => log.eventName === 'NewProject').args.contractAddress;
        return ethers.getContractAt("NativeProject", projectAddress);
    }

    async function setupAndSign(project, amount, immediateBps = 0n) {
        await testToken.connect(backer1).approve(await project.getAddress(), amount);
        if (immediateBps > 0) {
            await project.connect(backer1).sendFundsWithImmediate(amount, immediateBps);
        } else {
            await project.connect(backer1).sendFunds(amount);
        }

        const immediate = (amount * immediateBps) / 10000n;
        const locked = amount - immediate;
        const arbitrationFee = (locked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
        const contractorStake = arbitrationFee / 2n;

        await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

        const coolingOff = await economy.coolingOffPeriod();
        await time.increase(coolingOff + 1n);
        await project.connect(contractor).signContract();

        return { immediate, locked, arbitrationFee };
    }

    async function disputeAndArbitrate(project, percent) {
        await project.connect(contractor).disputeAsContractor();
        await project.connect(arbiter).arbitrate(percent, "ruling_hash");

        const appealPeriod = await economy.appealPeriod();
        await time.increase(appealPeriod + 1n);
        await project.finalizeArbitration();
    }

    beforeEach(async function () {
        [deployer, timelock, registry, author, contractor, arbiter, backer1, backer2, backer3] = await ethers.getSigners();

        const NativeProjectImpl = await ethers.getContractFactory("NativeProject");
        nativeProjectImpl = await NativeProjectImpl.deploy();
        const ERC20ProjectImpl = await ethers.getContractFactory("ERC20Project");
        erc20ProjectImpl = await ERC20ProjectImpl.deploy();
        const Economy = await ethers.getContractFactory("Economy");
        economy = await Economy.deploy(ARBITRATION_FEE_BPS);
        const TestToken = await ethers.getContractFactory("TestToken");
        testToken = await TestToken.deploy();
        const MockRepToken = await ethers.getContractFactory("MockRepToken");
        mockRepToken = await MockRepToken.deploy();
        const MockGovernor = await ethers.getContractFactory("MockGovernor");
        mockGovernor = await MockGovernor.deploy();

        await economy.connect(deployer).setImplementations(
            await nativeProjectImpl.getAddress(),
            await erc20ProjectImpl.getAddress()
        );
        await economy.connect(deployer).setDaoAddresses(
            timelock.address, registry.address, await mockGovernor.getAddress(), await mockRepToken.getAddress()
        );

        await economy.connect(timelock).setProjectThreshold(PROJECT_THRESHOLD);
        await economy.connect(timelock).setPlatformFee(PLATFORM_FEE_BPS);
        await economy.connect(timelock).setAuthorFee(AUTHOR_FEE_BPS);

        await mockRepToken.mint(author.address, PROJECT_THRESHOLD);

        await testToken.connect(deployer).transfer(backer1.address, ethers.parseEther("100000"));
        await testToken.connect(deployer).transfer(backer2.address, ethers.parseEther("100000"));
        await testToken.connect(deployer).transfer(backer3.address, ethers.parseEther("100000"));
        await testToken.connect(deployer).transfer(contractor.address, ethers.parseEther("100000"));
    });

    describe("All Ruling Percentages", function() {

        const rulingPercentages = [0, 1, 25, 33, 50, 67, 75, 99, 100];

        rulingPercentages.forEach(percent => {
            it(`should correctly handle ${percent}% ruling with zero balance after`, async function() {
                const project = await createERC20Project();
                const amount = ethers.parseEther("1000");

                const { locked, arbitrationFee } = await setupAndSign(project, amount);
                await disputeAndArbitrate(project, percent);

                // Calculate expected distributions
                const backersArbShare = arbitrationFee - (arbitrationFee / 2n);
                const pool = locked - backersArbShare;
                const contractorPool = (pool * BigInt(percent)) / 100n;
                const backersPool = pool - contractorPool;

                // Contractor withdraws (only if they have something)
                if (percent > 0) {
                    const contractorBalanceBefore = await testToken.balanceOf(contractor.address);
                    await project.connect(contractor).withdrawAsContractor();
                    const contractorBalanceAfter = await testToken.balanceOf(contractor.address);

                    const platformFee = (contractorPool * BigInt(PLATFORM_FEE_BPS)) / 10000n;
                    const remainder = contractorPool - platformFee;
                    const authorFee = (remainder * BigInt(AUTHOR_FEE_BPS)) / 10000n;
                    const expectedContractor = remainder - authorFee;
                    expect(contractorBalanceAfter - contractorBalanceBefore).to.equal(expectedContractor);
                }

                // Backer withdraws
                const backerBalanceBefore = await testToken.balanceOf(backer1.address);
                await project.connect(backer1).withdrawAsContributor();
                const backerBalanceAfter = await testToken.balanceOf(backer1.address);

                expect(backerBalanceAfter - backerBalanceBefore).to.equal(backersPool);

                // KEY INVARIANT: Zero balance
                const finalBalance = await testToken.balanceOf(await project.getAddress());
                console.log(`${percent}% ruling - Final balance: ${finalBalance.toString()}`);
                expect(finalBalance).to.equal(0);
            });
        });
    });

    describe("Arbitration with Immediate Release", function() {

        it("should correctly handle arbitration when immediate was released", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");
            const immediateBps = 2000n; // 20%

            const { immediate, locked, arbitrationFee } = await setupAndSign(project, amount, immediateBps);

            // Verify immediate was released
            expect(await project.immediateReleased()).to.equal(immediate);

            await disputeAndArbitrate(project, 50);

            // Contractor and backer withdraw
            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();

            // Zero balance
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should correctly calculate shares based on locked (not total contribution)", async function() {
            const project = await createERC20Project();

            // Backer1: 1000 at 0% = 1000 locked
            // Backer2: 1000 at 20% = 800 locked
            const amount = ethers.parseEther("1000");
            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await testToken.connect(backer2).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);
            await project.connect(backer2).sendFundsWithImmediate(amount, 2000n);

            const locked1 = amount;
            const locked2 = amount - (amount * 2000n) / 10000n;
            const totalLocked = locked1 + locked2;

            // Sign
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await project.connect(contractor).signContract();

            // 0% ruling - all to backers
            await disputeAndArbitrate(project, 0);

            const backersArbShare = arbitrationFee - (arbitrationFee / 2n);
            const pool = totalLocked - backersArbShare;

            // Backer1 should get locked1/totalLocked * pool
            const expected1 = (pool * locked1) / totalLocked;
            const expected2 = (pool * locked2) / totalLocked;

            const balance1Before = await testToken.balanceOf(backer1.address);
            const balance2Before = await testToken.balanceOf(backer2.address);

            await project.connect(backer1).withdrawAsContributor();
            await project.connect(backer2).withdrawAsContributor();

            const balance1After = await testToken.balanceOf(backer1.address);
            const balance2After = await testToken.balanceOf(backer2.address);

            // Backer1 should get more than backer2 (1000/1800 vs 800/1800)
            expect(balance1After - balance1Before).to.equal(expected1);
            expect(balance2After - balance2Before).to.equal(expected2);
            expect(balance1After - balance1Before).to.be.gt(balance2After - balance2Before);

            // Zero balance (0% ruling = contractor gets nothing, so no withdraw needed)
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });
    });

    describe("Arbiter Fee Payment", function() {

        it("should pay arbiter the arbitration fee minus the platform fee", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            const { arbitrationFee } = await setupAndSign(project, amount);

            const arbiterBalanceBefore = await testToken.balanceOf(arbiter.address);

            await disputeAndArbitrate(project, 50);

            const arbiterBalanceAfter = await testToken.balanceOf(arbiter.address);

            const arbiterNet = arbitrationFee - (arbitrationFee * (await economy.platformFeeBps())) / 10000n;
            expect(arbiterBalanceAfter - arbiterBalanceBefore).to.equal(arbiterNet);
        });

        it("should mark arbitrationFeePaidOut as true after ruling", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await setupAndSign(project, amount);
            await disputeAndArbitrate(project, 50);

            expect(await project.arbitrationFeePaidOut()).to.equal(true);
        });
    });

    describe("Arbitration Timeout", function() {

        it("should allow closing project after arbitration timeout", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await setupAndSign(project, amount);

            // Enter dispute
            await project.connect(contractor).disputeAsContractor();

            // Wait for arbitration timeout (150 days)
            const ARBITRATION_TIMEOUT = 150n * 24n * 60n * 60n;
            await time.increase(ARBITRATION_TIMEOUT + 1n);

            // Anyone can call arbitrationPeriodExpired
            await project.arbitrationPeriodExpired();

            expect(await project.stage()).to.equal(6); // Closed
        });

        it("should NOT allow arbitration after project closed via timeout", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await setupAndSign(project, amount);
            await project.connect(contractor).disputeAsContractor();

            const ARBITRATION_TIMEOUT = 150n * 24n * 60n * 60n;
            await time.increase(ARBITRATION_TIMEOUT + 1n);
            await project.arbitrationPeriodExpired();

            await expect(
                project.connect(arbiter).arbitrate(50, "ruling_hash")
            ).to.be.revertedWith("Arbitration can only occur if the project is in dispute.");
        });
    });

    describe("Native Project Arbitration", function() {

        it("should correctly handle native project arbitration with zero balance", async function() {
            const project = await createNativeProject();
            const amount = ethers.parseEther("1");

            await project.connect(backer1).sendFunds({ value: amount });

            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await project.connect(contractor).signContract({ value: contractorStake });

            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(50, "ruling_hash");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();

            expect(await ethers.provider.getBalance(await project.getAddress())).to.equal(0);
        });
    });

    describe("Multiple Backers Arbitration", function() {

        it("should distribute to 3 backers proportionally after 33% ruling", async function() {
            const project = await createERC20Project();

            const amount1 = ethers.parseEther("300");
            const amount2 = ethers.parseEther("300");
            const amount3 = ethers.parseEther("400");
            const totalLocked = amount1 + amount2 + amount3;

            await testToken.connect(backer1).approve(await project.getAddress(), amount1);
            await testToken.connect(backer2).approve(await project.getAddress(), amount2);
            await testToken.connect(backer3).approve(await project.getAddress(), amount3);

            await project.connect(backer1).sendFunds(amount1);
            await project.connect(backer2).sendFunds(amount2);
            await project.connect(backer3).sendFunds(amount3);

            // Sign
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await project.connect(contractor).signContract();

            // 33% ruling
            await disputeAndArbitrate(project, 33);

            // All withdraw
            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();
            await project.connect(backer2).withdrawAsContributor();
            await project.connect(backer3).withdrawAsContributor();

            const finalBalance = await testToken.balanceOf(await project.getAddress());
            console.log("3 backers, 33% ruling - Final balance:", finalBalance.toString());
            expect(finalBalance).to.equal(0);
        });

        it("should handle 5 backers with varying amounts and 67% ruling", async function() {
            const project = await createERC20Project();

            const amounts = [
                ethers.parseEther("100"),
                ethers.parseEther("200"),
                ethers.parseEther("300"),
                ethers.parseEther("150"),
                ethers.parseEther("250"),
            ];
            const signers = [backer1, backer2, backer3, deployer, timelock];
            const totalLocked = amounts.reduce((a, b) => a + b, 0n);

            // Give tokens to all backers
            for (let i = 0; i < 5; i++) {
                await testToken.connect(deployer).transfer(signers[i].address, amounts[i] * 2n);
                await testToken.connect(signers[i]).approve(await project.getAddress(), amounts[i]);
                await project.connect(signers[i]).sendFunds(amounts[i]);
            }

            // Sign
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await project.connect(contractor).signContract();

            // 67% ruling
            await disputeAndArbitrate(project, 67);

            // All withdraw
            await project.connect(contractor).withdrawAsContractor();
            for (let i = 0; i < 5; i++) {
                await project.connect(signers[i]).withdrawAsContributor();
            }

            const finalBalance = await testToken.balanceOf(await project.getAddress());
            console.log("5 backers, 67% ruling - Final balance:", finalBalance.toString());
            expect(finalBalance).to.equal(0);
        });
    });
});
