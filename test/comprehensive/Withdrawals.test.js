const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { passCoolingOff } = require("../helpers/coolingOff");

/**
 * Comprehensive Withdrawal Tests
 *
 * Tests all withdrawal scenarios:
 * - Pre-signing (Open/Pending stages)
 * - Post-signing (after immediate released)
 * - Post-arbitration
 * - Multiple backers withdrawing
 */
describe("Comprehensive Withdrawal Tests", function () {
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

    describe("Pre-Signing Withdrawals (Full Refund)", function() {

        it("should allow full withdrawal with 0% immediate before signing", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            const balanceBefore = await testToken.balanceOf(backer1.address);
            await project.connect(backer1).withdrawAsContributor();
            const balanceAfter = await testToken.balanceOf(backer1.address);

            expect(balanceAfter - balanceBefore).to.equal(amount);
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should allow full withdrawal with 20% immediate before signing", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFundsWithImmediate(amount, 2000n);

            const balanceBefore = await testToken.balanceOf(backer1.address);
            await project.connect(backer1).withdrawAsContributor();
            const balanceAfter = await testToken.balanceOf(backer1.address);

            // Should get full amount back since not signed yet
            expect(balanceAfter - balanceBefore).to.equal(amount);
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should update projectValue and totals correctly on withdrawal", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFundsWithImmediate(amount, 2000n);

            expect(await project.projectValue()).to.equal(amount);
            expect(await project.totalImmediate()).to.equal(ethers.parseEther("200"));
            expect(await project.totalLocked()).to.equal(ethers.parseEther("800"));

            await project.connect(backer1).withdrawAsContributor();

            expect(await project.projectValue()).to.equal(0);
            expect(await project.totalImmediate()).to.equal(0);
            expect(await project.totalLocked()).to.equal(0);
        });

        it("should allow one of multiple backers to withdraw without affecting others", async function() {
            const project = await createERC20Project();
            const amount1 = ethers.parseEther("1000");
            const amount2 = ethers.parseEther("500");

            await testToken.connect(backer1).approve(await project.getAddress(), amount1);
            await testToken.connect(backer2).approve(await project.getAddress(), amount2);
            await project.connect(backer1).sendFunds(amount1);
            await project.connect(backer2).sendFunds(amount2);

            expect(await project.projectValue()).to.equal(amount1 + amount2);

            // Backer1 withdraws
            await project.connect(backer1).withdrawAsContributor();

            // Verify backer2's contribution unaffected
            const contrib2 = await project.contributions(backer2.address);
            expect(contrib2.total).to.equal(amount2);
            expect(await project.projectValue()).to.equal(amount2);
        });

        it("should NOT allow double withdrawal", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            await project.connect(backer1).withdrawAsContributor();

            await expect(
                project.connect(backer1).withdrawAsContributor()
            ).to.be.revertedWith("No contributions to withdraw.");
        });
    });

    describe("Post-Signing Withdrawals (Immediate Lost)", function() {

        it("should reimburse only locked portion after signing (reimburse flow)", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");
            const immediateBps = 2000n; // 20%
            const immediate = (amount * immediateBps) / 10000n;
            const locked = amount - immediate;

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFundsWithImmediate(amount, immediateBps);

            // Sign contract
            const arbitrationFee = (locked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            // Reimburse (contractor cancels)
            await project.connect(contractor).reimburse();

            // Backer withdraws - should only get locked portion
            const balanceBefore = await testToken.balanceOf(backer1.address);
            await project.connect(backer1).withdrawAsContributor();
            const balanceAfter = await testToken.balanceOf(backer1.address);

            expect(balanceAfter - balanceBefore).to.equal(locked);
        });

        it("should correctly handle post-signing withdrawal with 0% immediate", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount); // 0% immediate

            // Sign
            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            // Reimburse
            await project.connect(contractor).reimburse();

            // Should get full amount since 0% immediate
            const balanceBefore = await testToken.balanceOf(backer1.address);
            await project.connect(backer1).withdrawAsContributor();
            const balanceAfter = await testToken.balanceOf(backer1.address);

            expect(balanceAfter - balanceBefore).to.equal(amount);
        });
    });

    describe("Post-Arbitration Withdrawals", function() {

        it("should correctly distribute 0% ruling (all to backers)", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            // Sign
            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            // Dispute
            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(0, "ruling_hash");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // Pool = totalLocked - backersArbShare
            const backersArbShare = arbitrationFee - (arbitrationFee / 2n);
            const pool = amount - backersArbShare;

            // 0% to contractor means 100% to backers
            const balanceBefore = await testToken.balanceOf(backer1.address);
            await project.connect(backer1).withdrawAsContributor();
            const balanceAfter = await testToken.balanceOf(backer1.address);

            expect(balanceAfter - balanceBefore).to.equal(pool);
        });

        it("should correctly distribute 100% ruling (all to contractor)", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            // Sign
            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            // Dispute
            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(100, "ruling_hash");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // Backer gets 0% of pool
            const balanceBefore = await testToken.balanceOf(backer1.address);
            await project.connect(backer1).withdrawAsContributor();
            const balanceAfter = await testToken.balanceOf(backer1.address);

            expect(balanceAfter - balanceBefore).to.equal(0);
        });

        it("should correctly distribute 50% ruling (split)", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            // Sign
            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            // Dispute
            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(50, "ruling_hash");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // Pool = totalLocked - backersArbShare
            const backersArbShare = arbitrationFee - (arbitrationFee / 2n);
            const pool = amount - backersArbShare;
            const backerShare = (pool * 50n) / 100n; // 50% to backers

            const balanceBefore = await testToken.balanceOf(backer1.address);
            await project.connect(backer1).withdrawAsContributor();
            const balanceAfter = await testToken.balanceOf(backer1.address);

            expect(balanceAfter - balanceBefore).to.equal(backerShare);
        });

        it("should proportionally distribute to multiple backers based on locked amounts", async function() {
            const project = await createERC20Project();

            // Backer1: 1000 at 0% immediate = 1000 locked
            // Backer2: 1000 at 20% immediate = 800 locked
            const amount1 = ethers.parseEther("1000");
            const amount2 = ethers.parseEther("1000");
            const locked1 = amount1;
            const locked2 = amount2 - (amount2 * 2000n) / 10000n; // 800
            const totalLocked = locked1 + locked2; // 1800

            await testToken.connect(backer1).approve(await project.getAddress(), amount1);
            await testToken.connect(backer2).approve(await project.getAddress(), amount2);
            await project.connect(backer1).sendFunds(amount1);
            await project.connect(backer2).sendFundsWithImmediate(amount2, 2000n);

            // Sign
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            // Dispute with 50% ruling
            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(50, "ruling_hash");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // Pool and distribution
            const backersArbShare = arbitrationFee - (arbitrationFee / 2n);
            const pool = totalLocked - backersArbShare;
            const backersPool = (pool * 50n) / 100n;

            // Backer1 gets locked1/totalLocked of backers' share
            const expected1 = (backersPool * locked1) / totalLocked;
            // Backer2 gets locked2/totalLocked of backers' share
            const expected2 = (backersPool * locked2) / totalLocked;

            const balance1Before = await testToken.balanceOf(backer1.address);
            const balance2Before = await testToken.balanceOf(backer2.address);

            await project.connect(backer1).withdrawAsContributor();
            await project.connect(backer2).withdrawAsContributor();

            const balance1After = await testToken.balanceOf(backer1.address);
            const balance2After = await testToken.balanceOf(backer2.address);

            expect(balance1After - balance1Before).to.equal(expected1);
            expect(balance2After - balance2Before).to.equal(expected2);

            // Contractor also needs to withdraw their portion
            await project.connect(contractor).withdrawAsContractor();

            // Zero balance check
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });
    });

    describe("Native Project Withdrawals", function() {

        it("should allow full withdrawal before signing (native)", async function() {
            const project = await createNativeProject();
            const amount = ethers.parseEther("1");

            await project.connect(backer1).sendFunds({ value: amount });

            const balanceBefore = await ethers.provider.getBalance(backer1.address);
            const tx = await project.connect(backer1).withdrawAsContributor();
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed * receipt.gasPrice;
            const balanceAfter = await ethers.provider.getBalance(backer1.address);

            expect(balanceAfter - balanceBefore + gasUsed).to.equal(amount);
        });

        it("should handle post-arbitration withdrawal (native)", async function() {
            const project = await createNativeProject();
            const amount = ethers.parseEther("1");

            await project.connect(backer1).sendFunds({ value: amount });

            // Sign
            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract({ value: contractorStake });

            // Dispute with 60% ruling
            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(60, "ruling_hash");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // Contractor and backer withdraw
            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();

            expect(await ethers.provider.getBalance(await project.getAddress())).to.equal(0);
        });
    });
});
