const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { passCoolingOff } = require("../helpers/coolingOff");

/**
 * Contribution Pattern Tests
 *
 * Tests complex contribution patterns:
 * - Add -> withdraw -> add again
 * - Multiple contributions with different immediate percentages
 * - Add -> withdraw -> add -> add with immediate
 * - Multiple backers with interleaved operations
 */
describe("Contribution Pattern Tests", function () {
    let economy, nativeProjectImpl, erc20ProjectImpl, testToken, mockRepToken, mockGovernor;
    let deployer, timelock, registry, author, contractor, arbiter, backer1, backer2, backer3;

    const ARBITRATION_FEE_BPS = 100;
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

    describe("Add -> Withdraw -> Add Again Patterns", function() {

        it("should handle add -> withdraw -> add again (before signing)", async function() {
            const project = await createERC20Project();

            const amount1 = ethers.parseEther("500");
            const amount2 = ethers.parseEther("700");

            // Step 1: Add funds
            await testToken.connect(backer1).approve(await project.getAddress(), amount1);
            await project.connect(backer1).sendFunds(amount1);
            expect(await project.totalLocked()).to.equal(amount1);

            // Step 2: Withdraw completely
            await project.connect(backer1).withdrawAsContributor();
            expect(await project.totalLocked()).to.equal(0);
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);

            // Step 3: Add again
            await testToken.connect(backer1).approve(await project.getAddress(), amount2);
            await project.connect(backer1).sendFunds(amount2);
            expect(await project.totalLocked()).to.equal(amount2);

            // Withdraw again
            await project.connect(backer1).withdrawAsContributor();
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should handle add -> withdraw -> add again -> add with immediate (before signing)", async function() {
            const project = await createERC20Project();

            const amount1 = ethers.parseEther("500");
            const amount2 = ethers.parseEther("700");
            const amount3 = ethers.parseEther("300");
            const immediateBps3 = 1500n; // 15%

            // Step 1: Add funds
            await testToken.connect(backer1).approve(await project.getAddress(), amount1);
            await project.connect(backer1).sendFunds(amount1);

            // Step 2: Withdraw completely
            await project.connect(backer1).withdrawAsContributor();

            // Step 3: Add again (0% immediate)
            await testToken.connect(backer1).approve(await project.getAddress(), amount2);
            await project.connect(backer1).sendFunds(amount2);

            // Step 4: Add on top with immediate release
            await testToken.connect(backer1).approve(await project.getAddress(), amount3);
            await project.connect(backer1).sendFundsWithImmediate(amount3, immediateBps3);

            const expectedImmediate = (amount3 * immediateBps3) / 10000n;
            const expectedLocked = amount2 + amount3 - expectedImmediate;

            expect(await project.totalLocked()).to.equal(expectedLocked);
            expect(await project.totalImmediate()).to.equal(expectedImmediate);

            // Withdraw - before signing, backer gets FULL contribution back (not just locked)
            const backerBalanceBefore = await testToken.balanceOf(backer1.address);
            await project.connect(backer1).withdrawAsContributor();
            const backerBalanceAfter = await testToken.balanceOf(backer1.address);

            // Before signing: backer gets full contribution back (amount2 + amount3)
            expect(backerBalanceAfter - backerBalanceBefore).to.equal(amount2 + amount3);

            // Contract should be empty
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should handle add -> withdraw -> add -> add with immediate through FULL lifecycle (arbitration)", async function() {
            const project = await createERC20Project();

            const amount1 = ethers.parseEther("500");
            const amount2 = ethers.parseEther("700");
            const amount3 = ethers.parseEther("300");
            const immediateBps3 = 1500n; // 15%

            // Add -> withdraw -> add -> add with immediate
            await testToken.connect(backer1).approve(await project.getAddress(), amount1);
            await project.connect(backer1).sendFunds(amount1);
            await project.connect(backer1).withdrawAsContributor();

            await testToken.connect(backer1).approve(await project.getAddress(), amount2 + amount3);
            await project.connect(backer1).sendFunds(amount2);
            await project.connect(backer1).sendFundsWithImmediate(amount3, immediateBps3);

            const expectedImmediate = (amount3 * immediateBps3) / 10000n;
            const expectedLocked = amount2 + amount3 - expectedImmediate;

            // Sign contract
            const arbitrationFee = (expectedLocked * BigInt(100)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            // Dispute and arbitrate at 50%
            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(50, "ruling");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // Both parties withdraw
            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();

            // Zero balance invariant
            const finalBalance = await testToken.balanceOf(await project.getAddress());
            console.log("Add->withdraw->add->add with immediate (50% ruling) - Final balance:", finalBalance.toString());
            expect(finalBalance).to.equal(0);
        });

        it("should handle add -> withdraw -> add -> add with immediate through FULL lifecycle (0% ruling)", async function() {
            const project = await createERC20Project();

            await testToken.connect(backer1).approve(await project.getAddress(), ethers.parseEther("2000"));
            await project.connect(backer1).sendFunds(ethers.parseEther("500"));
            await project.connect(backer1).withdrawAsContributor();

            await project.connect(backer1).sendFunds(ethers.parseEther("700"));
            await project.connect(backer1).sendFundsWithImmediate(ethers.parseEther("300"), 1500n);

            const totalLocked = await project.totalLocked();
            const arbitrationFee = (totalLocked * BigInt(100)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(0, "ruling"); // 0% to contractor

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // Contractor should have nothing
            await expect(
                project.connect(contractor).withdrawAsContractor()
            ).to.be.revertedWith("Nothing to withdraw");

            await project.connect(backer1).withdrawAsContributor();

            const finalBalance = await testToken.balanceOf(await project.getAddress());
            console.log("Add->withdraw->add->add with immediate (0% ruling) - Final balance:", finalBalance.toString());
            expect(finalBalance).to.equal(0);
        });

        it("should handle add -> withdraw -> add -> add with immediate through FULL lifecycle (100% ruling)", async function() {
            const project = await createERC20Project();

            await testToken.connect(backer1).approve(await project.getAddress(), ethers.parseEther("2000"));
            await project.connect(backer1).sendFunds(ethers.parseEther("500"));
            await project.connect(backer1).withdrawAsContributor();

            await project.connect(backer1).sendFunds(ethers.parseEther("700"));
            await project.connect(backer1).sendFundsWithImmediate(ethers.parseEther("300"), 1500n);

            const totalLocked = await project.totalLocked();
            const arbitrationFee = (totalLocked * BigInt(100)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(100, "ruling"); // 100% to contractor

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();

            const finalBalance = await testToken.balanceOf(await project.getAddress());
            console.log("Add->withdraw->add->add with immediate (100% ruling) - Final balance:", finalBalance.toString());
            expect(finalBalance).to.equal(0);
        });
    });

    describe("Multiple Backers with Complex Patterns", function() {

        it("should handle multiple backers with add/withdraw/add patterns through arbitration", async function() {
            const project = await createERC20Project();

            // Backer1: add 1000, withdraw, add 500
            await testToken.connect(backer1).approve(await project.getAddress(), ethers.parseEther("1500"));
            await project.connect(backer1).sendFunds(ethers.parseEther("1000"));
            await project.connect(backer1).withdrawAsContributor();
            await project.connect(backer1).sendFunds(ethers.parseEther("500"));

            // Backer2: add 300 with 20% immediate, add 200 with 0%
            await testToken.connect(backer2).approve(await project.getAddress(), ethers.parseEther("500"));
            await project.connect(backer2).sendFundsWithImmediate(ethers.parseEther("300"), 2000n);
            await project.connect(backer2).sendFunds(ethers.parseEther("200"));

            // Backer3: add 400, withdraw, add 600 with 10% immediate
            await testToken.connect(backer3).approve(await project.getAddress(), ethers.parseEther("1000"));
            await project.connect(backer3).sendFunds(ethers.parseEther("400"));
            await project.connect(backer3).withdrawAsContributor();
            await project.connect(backer3).sendFundsWithImmediate(ethers.parseEther("600"), 1000n);

            // Calculate expected locked amounts
            // Backer1: 500 locked
            // Backer2: 300 - 60 (20%) + 200 = 440 locked
            // Backer3: 600 - 60 (10%) = 540 locked
            const totalLocked = await project.totalLocked();
            expect(totalLocked).to.equal(ethers.parseEther("1480"));

            // Sign
            const arbitrationFee = (totalLocked * BigInt(100)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            // 67% ruling
            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(67, "ruling");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // All withdraw
            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();
            await project.connect(backer2).withdrawAsContributor();
            await project.connect(backer3).withdrawAsContributor();

            const finalBalance = await testToken.balanceOf(await project.getAddress());
            console.log("Complex multi-backer patterns (67% ruling) - Final balance:", finalBalance.toString());
            expect(finalBalance).to.equal(0);
        });

        it("should handle interleaved operations between backers through 33% ruling", async function() {
            const project = await createERC20Project();

            // Backer1 adds
            await testToken.connect(backer1).approve(await project.getAddress(), ethers.parseEther("1000"));
            await project.connect(backer1).sendFunds(ethers.parseEther("1000"));

            // Backer2 adds
            await testToken.connect(backer2).approve(await project.getAddress(), ethers.parseEther("500"));
            await project.connect(backer2).sendFunds(ethers.parseEther("500"));

            // Backer1 withdraws
            await project.connect(backer1).withdrawAsContributor();

            // Backer1 re-adds with immediate
            await testToken.connect(backer1).approve(await project.getAddress(), ethers.parseEther("800"));
            await project.connect(backer1).sendFundsWithImmediate(ethers.parseEther("800"), 2000n);

            // Backer3 adds
            await testToken.connect(backer3).approve(await project.getAddress(), ethers.parseEther("300"));
            await project.connect(backer3).sendFundsWithImmediate(ethers.parseEther("300"), 1000n);

            // Expected: Backer1 has 640 locked, Backer2 has 500 locked, Backer3 has 270 locked
            const totalLocked = await project.totalLocked();
            expect(totalLocked).to.equal(ethers.parseEther("1410"));

            // Sign and arbitrate
            const arbitrationFee = (totalLocked * BigInt(100)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(33, "ruling");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();
            await project.connect(backer2).withdrawAsContributor();
            await project.connect(backer3).withdrawAsContributor();

            const finalBalance = await testToken.balanceOf(await project.getAddress());
            console.log("Interleaved operations (33% ruling) - Final balance:", finalBalance.toString());
            expect(finalBalance).to.equal(0);
        });

        it("should handle backer withdrawing after others have added", async function() {
            const project = await createERC20Project();

            // All three backers add
            await testToken.connect(backer1).approve(await project.getAddress(), ethers.parseEther("500"));
            await testToken.connect(backer2).approve(await project.getAddress(), ethers.parseEther("500"));
            await testToken.connect(backer3).approve(await project.getAddress(), ethers.parseEther("500"));

            await project.connect(backer1).sendFunds(ethers.parseEther("500"));
            await project.connect(backer2).sendFundsWithImmediate(ethers.parseEther("500"), 1000n);
            await project.connect(backer3).sendFunds(ethers.parseEther("500"));

            // Backer2 withdraws (they had immediate)
            await project.connect(backer2).withdrawAsContributor();

            // Backer2 re-adds with different immediate
            await testToken.connect(backer2).approve(await project.getAddress(), ethers.parseEther("400"));
            await project.connect(backer2).sendFundsWithImmediate(ethers.parseEther("400"), 2000n);

            // Expected: B1=500, B2=320 (400-80), B3=500
            expect(await project.totalLocked()).to.equal(ethers.parseEther("1320"));

            // Sign and arbitrate
            const totalLocked = await project.totalLocked();
            const arbitrationFee = (totalLocked * BigInt(100)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(75, "ruling");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();
            await project.connect(backer2).withdrawAsContributor();
            await project.connect(backer3).withdrawAsContributor();

            const finalBalance = await testToken.balanceOf(await project.getAddress());
            console.log("Backer withdraw after others added (75% ruling) - Final balance:", finalBalance.toString());
            expect(finalBalance).to.equal(0);
        });
    });

    describe("Multiple Add/Withdraw Cycles", function() {

        it("should handle multiple add/withdraw cycles for same backer", async function() {
            const project = await createERC20Project();

            // Cycle 1
            await testToken.connect(backer1).approve(await project.getAddress(), ethers.parseEther("100"));
            await project.connect(backer1).sendFunds(ethers.parseEther("100"));
            await project.connect(backer1).withdrawAsContributor();

            // Cycle 2
            await testToken.connect(backer1).approve(await project.getAddress(), ethers.parseEther("200"));
            await project.connect(backer1).sendFunds(ethers.parseEther("200"));
            await project.connect(backer1).withdrawAsContributor();

            // Cycle 3
            await testToken.connect(backer1).approve(await project.getAddress(), ethers.parseEther("300"));
            await project.connect(backer1).sendFundsWithImmediate(ethers.parseEther("300"), 1000n);
            await project.connect(backer1).withdrawAsContributor();

            // Cycle 4 - final contribution that stays
            await testToken.connect(backer1).approve(await project.getAddress(), ethers.parseEther("1000"));
            await project.connect(backer1).sendFundsWithImmediate(ethers.parseEther("1000"), 2000n);

            const totalLocked = await project.totalLocked();
            expect(totalLocked).to.equal(ethers.parseEther("800")); // 1000 - 200

            // Complete the project
            const arbitrationFee = (totalLocked * BigInt(100)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(50, "ruling");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();

            const finalBalance = await testToken.balanceOf(await project.getAddress());
            console.log("Multiple add/withdraw cycles (50% ruling) - Final balance:", finalBalance.toString());
            expect(finalBalance).to.equal(0);
        });

        it("should handle 5 add/withdraw cycles with varying immediates then arbitration", async function() {
            const project = await createERC20Project();

            // 5 cycles with varying amounts and immediates
            const cycles = [
                { amount: ethers.parseEther("100"), immediate: 0n },
                { amount: ethers.parseEther("200"), immediate: 500n },
                { amount: ethers.parseEther("150"), immediate: 1000n },
                { amount: ethers.parseEther("300"), immediate: 1500n },
                { amount: ethers.parseEther("250"), immediate: 2000n },
            ];

            for (let i = 0; i < 4; i++) {
                await testToken.connect(backer1).approve(await project.getAddress(), cycles[i].amount);
                if (cycles[i].immediate > 0) {
                    await project.connect(backer1).sendFundsWithImmediate(cycles[i].amount, cycles[i].immediate);
                } else {
                    await project.connect(backer1).sendFunds(cycles[i].amount);
                }
                await project.connect(backer1).withdrawAsContributor();
            }

            // Final contribution stays
            const finalCycle = cycles[4];
            await testToken.connect(backer1).approve(await project.getAddress(), finalCycle.amount);
            await project.connect(backer1).sendFundsWithImmediate(finalCycle.amount, finalCycle.immediate);

            const expectedLocked = finalCycle.amount - (finalCycle.amount * finalCycle.immediate) / 10000n;
            expect(await project.totalLocked()).to.equal(expectedLocked);

            // Arbitrate
            const arbitrationFee = (expectedLocked * BigInt(100)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(77, "ruling");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();

            const finalBalance = await testToken.balanceOf(await project.getAddress());
            console.log("5 cycles with varying immediates (77% ruling) - Final balance:", finalBalance.toString());
            expect(finalBalance).to.equal(0);
        });
    });

    describe("Edge Cases with Contribution Patterns", function() {

        it("should handle add with 0% immediate, withdraw, add with 20% immediate, complete", async function() {
            const project = await createERC20Project();

            // Add with 0%
            await testToken.connect(backer1).approve(await project.getAddress(), ethers.parseEther("1000"));
            await project.connect(backer1).sendFunds(ethers.parseEther("1000"));

            // Withdraw
            await project.connect(backer1).withdrawAsContributor();

            // Add with 20%
            await testToken.connect(backer1).approve(await project.getAddress(), ethers.parseEther("1000"));
            await project.connect(backer1).sendFundsWithImmediate(ethers.parseEther("1000"), 2000n);

            expect(await project.totalLocked()).to.equal(ethers.parseEther("800"));
            expect(await project.totalImmediate()).to.equal(ethers.parseEther("200"));

            // Complete through arbitration
            const totalLocked = await project.totalLocked();
            const arbitrationFee = (totalLocked * BigInt(100)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(100, "ruling");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();

            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should handle odd amounts through add/withdraw/add pattern", async function() {
            const project = await createERC20Project();

            // Odd amounts
            await testToken.connect(backer1).approve(await project.getAddress(), ethers.parseEther("123.456789"));
            await project.connect(backer1).sendFunds(ethers.parseEther("123.456789"));
            await project.connect(backer1).withdrawAsContributor();

            await testToken.connect(backer1).approve(await project.getAddress(), ethers.parseEther("987.654321"));
            await project.connect(backer1).sendFundsWithImmediate(ethers.parseEther("987.654321"), 1337n); // 13.37%

            const totalLocked = await project.totalLocked();

            // Arbitrate
            const arbitrationFee = (totalLocked * BigInt(100)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(47, "ruling"); // Prime percentage

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();

            const finalBalance = await testToken.balanceOf(await project.getAddress());
            console.log("Odd amounts through add/withdraw/add (47% ruling) - Final balance:", finalBalance.toString());
            expect(finalBalance).to.equal(0);
        });
    });
});
