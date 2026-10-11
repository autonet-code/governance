const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Comprehensive Contribution & Withdrawal Tests
 *
 * These tests exhaustively cover all contribution and withdrawal scenarios,
 * especially edge cases around:
 * - Multiple contributions from same backer
 * - Mixed immediate release percentages
 * - Rounding errors
 * - Pre-signing vs post-signing withdrawals
 */
describe("Comprehensive Contribution & Withdrawal Tests", function () {
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
        await economy.setCoolingOffPeriod(0); // no governance lifecycle to wait for in this fixture
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

    describe("Multiple Contributions from Same Backer (ERC20)", function() {

        it("BUG-001: should allow withdrawal after multiple contributions with MIXED immediate release", async function() {
            // This is the bug you found - multiple contributions with different immediate %
            const project = await createERC20Project();

            // First contribution: 1000 tokens with 0% immediate
            const contrib1 = ethers.parseEther("1000");
            await testToken.connect(backer1).approve(await project.getAddress(), contrib1);
            await project.connect(backer1).sendFunds(contrib1);

            // Second contribution: 500 tokens with 20% immediate (max allowed)
            const contrib2 = ethers.parseEther("500");
            const immediate2Bps = 2000n; // 20%
            await testToken.connect(backer1).approve(await project.getAddress(), contrib2);
            await project.connect(backer1).sendFundsWithImmediate(contrib2, immediate2Bps);

            // Verify state after contributions
            const contribData = await project.contributions(backer1.address);
            const totalContrib = contrib1 + contrib2; // 1500
            expect(contribData.total).to.equal(totalContrib);

            // Contrib1: 1000 at 0% immediate = 0 immediate, 1000 locked
            // Contrib2: 500 at 20% immediate = 100 immediate, 400 locked
            // Total immediate = 100, locked = 1400
            const expectedImmediate = (contrib2 * immediate2Bps) / 10000n; // 100
            const expectedLocked = contrib1 + contrib2 - expectedImmediate; // 1400

            console.log("Contribution data:", {
                total: contribData.total.toString(),
                immediate: contribData.immediate.toString(),
                locked: contribData.locked.toString(),
                expectedImmediate: expectedImmediate.toString(),
                expectedLocked: expectedLocked.toString()
            });

            expect(contribData.immediate).to.equal(expectedImmediate);
            expect(contribData.locked).to.equal(expectedLocked);

            // Now try to withdraw BEFORE signing
            const balanceBefore = await testToken.balanceOf(backer1.address);

            // This should NOT revert
            await project.connect(backer1).withdrawAsContributor();

            const balanceAfter = await testToken.balanceOf(backer1.address);

            // Should get full amount back (pre-signing)
            expect(balanceAfter - balanceBefore).to.equal(totalContrib);

            // Contract should have zero balance
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should handle multiple contributions ALL with 0% immediate", async function() {
            const project = await createERC20Project();

            const contrib1 = ethers.parseEther("500");
            const contrib2 = ethers.parseEther("300");
            const contrib3 = ethers.parseEther("200");
            const total = contrib1 + contrib2 + contrib3;

            await testToken.connect(backer1).approve(await project.getAddress(), total);
            await project.connect(backer1).sendFunds(contrib1);
            await project.connect(backer1).sendFunds(contrib2);
            await project.connect(backer1).sendFunds(contrib3);

            // Verify totals
            expect(await project.projectValue()).to.equal(total);
            expect(await project.totalLocked()).to.equal(total);
            expect(await project.totalImmediate()).to.equal(0);

            const contribData = await project.contributions(backer1.address);
            expect(contribData.total).to.equal(total);
            expect(contribData.immediate).to.equal(0);
            expect(contribData.locked).to.equal(total);

            // Withdraw
            const balanceBefore = await testToken.balanceOf(backer1.address);
            await project.connect(backer1).withdrawAsContributor();
            const balanceAfter = await testToken.balanceOf(backer1.address);

            expect(balanceAfter - balanceBefore).to.equal(total);
        });

        it("should handle multiple contributions ALL with max immediate (20%)", async function() {
            const project = await createERC20Project();

            const maxImmediateBps = 2000n; // 20%
            const contrib1 = ethers.parseEther("500");
            const contrib2 = ethers.parseEther("300");
            const total = contrib1 + contrib2;
            const expectedImmediate = (total * maxImmediateBps) / 10000n;
            const expectedLocked = total - expectedImmediate;

            await testToken.connect(backer1).approve(await project.getAddress(), total);
            await project.connect(backer1).sendFundsWithImmediate(contrib1, maxImmediateBps);
            await project.connect(backer1).sendFundsWithImmediate(contrib2, maxImmediateBps);

            // Verify totals
            expect(await project.projectValue()).to.equal(total);
            expect(await project.totalImmediate()).to.equal(expectedImmediate);
            expect(await project.totalLocked()).to.equal(expectedLocked);

            const contribData = await project.contributions(backer1.address);
            expect(contribData.total).to.equal(total);
            expect(contribData.immediate).to.equal(expectedImmediate);
            expect(contribData.locked).to.equal(expectedLocked);

            // Withdraw
            await project.connect(backer1).withdrawAsContributor();
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should handle contributions: first 20% immediate, second 0%", async function() {
            const project = await createERC20Project();

            // First: 1000 with 20% immediate = 200 immediate, 800 locked
            const contrib1 = ethers.parseEther("1000");
            const immediate1Bps = 2000n;

            // Second: 1000 with 0% immediate = 0 immediate, 1000 locked
            const contrib2 = ethers.parseEther("1000");

            const total = contrib1 + contrib2; // 2000
            const immediate1 = (contrib1 * immediate1Bps) / 10000n; // 200
            // Total immediate = 200, locked = 1800
            // Weighted bps = 200 * 10000 / 2000 = 1000 (10%)

            await testToken.connect(backer1).approve(await project.getAddress(), total);
            await project.connect(backer1).sendFundsWithImmediate(contrib1, immediate1Bps);
            await project.connect(backer1).sendFunds(contrib2);

            expect(await project.totalImmediate()).to.equal(immediate1);
            expect(await project.totalLocked()).to.equal(total - immediate1);

            // Withdraw pre-signing
            await project.connect(backer1).withdrawAsContributor();
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should handle contributions: first 0%, second 20% immediate", async function() {
            const project = await createERC20Project();

            // First: 1000 with 0% immediate = 0 immediate, 1000 locked
            const contrib1 = ethers.parseEther("1000");

            // Second: 1000 with 20% immediate = 200 immediate, 800 locked
            const contrib2 = ethers.parseEther("1000");
            const immediate2Bps = 2000n;

            const total = contrib1 + contrib2; // 2000
            const immediate2 = (contrib2 * immediate2Bps) / 10000n; // 200

            await testToken.connect(backer1).approve(await project.getAddress(), total);
            await project.connect(backer1).sendFunds(contrib1);
            await project.connect(backer1).sendFundsWithImmediate(contrib2, immediate2Bps);

            expect(await project.totalImmediate()).to.equal(immediate2);
            expect(await project.totalLocked()).to.equal(total - immediate2);

            // Withdraw pre-signing
            await project.connect(backer1).withdrawAsContributor();
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });
    });

    describe("Withdrawal After Signing with Mixed Immediates", function() {

        it("should correctly withdraw after signing - single backer, mixed immediates", async function() {
            const project = await createERC20Project();

            // Two contributions with different immediates
            const contrib1 = ethers.parseEther("1000"); // 0% immediate
            const contrib2 = ethers.parseEther("500");  // 20% immediate
            const immediate2 = (contrib2 * 2000n) / 10000n; // 100
            const total = contrib1 + contrib2; // 1500
            const totalImmediate = immediate2; // 100
            const totalLocked = total - totalImmediate; // 1400

            await testToken.connect(backer1).approve(await project.getAddress(), total);
            await project.connect(backer1).sendFunds(contrib1);
            await project.connect(backer1).sendFundsWithImmediate(contrib2, 2000n);

            // Sign contract
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await project.connect(contractor).signContract();

            // Immediate released to contractor
            expect(await project.immediateReleased()).to.equal(totalImmediate);

            // Now reimburse (project closed with 0% to contractor)
            await project.connect(contractor).reimburse();

            // Backer withdraws - should get only locked portion back
            const balanceBefore = await testToken.balanceOf(backer1.address);
            await project.connect(backer1).withdrawAsContributor();
            const balanceAfter = await testToken.balanceOf(backer1.address);

            // Should get full locked amount back (reimburse = 0% to contractor)
            expect(balanceAfter - balanceBefore).to.equal(totalLocked);

            // Contractor reclaims stake
            await project.connect(contractor).reclaimArbitrationStake();

            // Zero balance
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should correctly handle arbitration with multiple contributions from same backer", async function() {
            const project = await createERC20Project();

            // Multiple contributions with mixed immediates
            const contrib1 = ethers.parseEther("600");  // 0% immediate -> 600 locked
            const contrib2 = ethers.parseEther("400");  // 20% immediate -> 320 locked, 80 immediate
            const immediate2 = (contrib2 * 2000n) / 10000n; // 80
            const total = contrib1 + contrib2; // 1000
            const totalImmediate = immediate2; // 80
            const totalLocked = total - totalImmediate; // 920

            await testToken.connect(backer1).approve(await project.getAddress(), total);
            await project.connect(backer1).sendFunds(contrib1);
            await project.connect(backer1).sendFundsWithImmediate(contrib2, 2000n);

            // Sign
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await project.connect(contractor).signContract();

            // Dispute and arbitrate at 50%
            await project.connect(backer1).voteToDispute();
            await project.connect(arbiter).arbitrate(50, "ruling_hash");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // Calculate expected amounts
            const backersArbShare = arbitrationFee - contractorStake;
            const pool = totalLocked - backersArbShare;
            const backerRefund = (pool * 50n) / 100n; // 50% of pool to backer

            // Withdraw
            const balanceBefore = await testToken.balanceOf(backer1.address);
            await project.connect(backer1).withdrawAsContributor();
            const balanceAfter = await testToken.balanceOf(backer1.address);

            expect(balanceAfter - balanceBefore).to.equal(backerRefund);

            // Contractor withdraws
            await project.connect(contractor).withdrawAsContractor();

            // Zero balance
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });
    });

    describe("Rounding Edge Cases", function() {

        it("should handle small amounts (1 wei contribution)", async function() {
            const project = await createERC20Project();

            // This is probably too small to be practical, but shouldn't break
            const smallAmount = 1n;
            await testToken.connect(backer1).approve(await project.getAddress(), smallAmount);
            await project.connect(backer1).sendFunds(smallAmount);

            expect(await project.projectValue()).to.equal(smallAmount);

            await project.connect(backer1).withdrawAsContributor();
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should handle odd amounts that don't divide evenly", async function() {
            const project = await createERC20Project();

            // 1000000000000000001 wei (1 ether + 1 wei) with 33% immediate
            // This should create rounding
            const oddAmount = ethers.parseEther("1") + 1n;
            const immediateBps = 1000n; // 10%

            await testToken.connect(backer1).approve(await project.getAddress(), oddAmount);
            await project.connect(backer1).sendFundsWithImmediate(oddAmount, immediateBps);

            const immediateAmount = (oddAmount * immediateBps) / 10000n;
            const lockedAmount = oddAmount - immediateAmount;

            expect(await project.totalImmediate()).to.equal(immediateAmount);
            expect(await project.totalLocked()).to.equal(lockedAmount);

            // Withdraw
            await project.connect(backer1).withdrawAsContributor();

            // Should have zero balance (no dust)
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should handle 3 backers with amounts not divisible by 3", async function() {
            const project = await createERC20Project();

            // 100 total, not divisible by 3 evenly
            const contrib1 = ethers.parseEther("33");
            const contrib2 = ethers.parseEther("33");
            const contrib3 = ethers.parseEther("34");
            const total = contrib1 + contrib2 + contrib3;

            await testToken.connect(backer1).approve(await project.getAddress(), contrib1);
            await testToken.connect(backer2).approve(await project.getAddress(), contrib2);
            await testToken.connect(backer3).approve(await project.getAddress(), contrib3);

            await project.connect(backer1).sendFunds(contrib1);
            await project.connect(backer2).sendFunds(contrib2);
            await project.connect(backer3).sendFunds(contrib3);

            // Sign
            const arbitrationFee = (total * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await project.connect(contractor).signContract();

            // Dispute with 33% ruling (creates more rounding)
            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(33, "ruling_hash");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // All withdraw
            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();
            await project.connect(backer2).withdrawAsContributor();
            await project.connect(backer3).withdrawAsContributor();

            // Zero balance (key invariant)
            const finalBalance = await testToken.balanceOf(await project.getAddress());
            console.log("Final balance after 33/33/34 split with 33% ruling:", finalBalance.toString());
            expect(finalBalance).to.equal(0);
        });
    });

    describe("Voting Power with Multiple Contributions", function() {

        it("should correctly calculate voting power based on locked amounts", async function() {
            const project = await createERC20Project();

            // Backer1: 1000 at 0% immediate -> 1000 locked, 1000 voting power
            // Backer2: 1000 at 20% immediate -> 800 locked, 800 voting power
            const contrib1 = ethers.parseEther("1000");
            const contrib2 = ethers.parseEther("1000");
            const immediate2 = (contrib2 * 2000n) / 10000n; // 200
            const locked2 = contrib2 - immediate2; // 800

            await testToken.connect(backer1).approve(await project.getAddress(), contrib1);
            await testToken.connect(backer2).approve(await project.getAddress(), contrib2);

            await project.connect(backer1).sendFunds(contrib1);
            await project.connect(backer2).sendFundsWithImmediate(contrib2, 2000n);

            // Sign
            const totalLocked = contrib1 + locked2; // 1800
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await project.connect(contractor).signContract();

            // Backer1 votes to dispute - has 1000 voting power (55.5% of 1800)
            await project.connect(backer1).voteToDispute();
            expect(await project.totalVotesForDispute()).to.equal(contrib1);

            // Project should NOT be in dispute yet (default quorum is 70%)
            expect(await project.stage()).to.equal(2); // Ongoing

            // Backer2 votes to dispute - has 800 voting power (44.5% of 1800)
            await project.connect(backer2).voteToDispute();
            expect(await project.totalVotesForDispute()).to.equal(contrib1 + locked2);

            // Now should be in dispute (100% > 70% quorum)
            expect(await project.stage()).to.equal(3); // Dispute
        });

        it("should correctly calculate voting power after multiple contributions", async function() {
            const project = await createERC20Project();

            // Same backer makes multiple contributions
            // Contrib1: 600 at 0% -> 600 locked
            // Contrib2: 400 at 20% -> 320 locked
            // Total locked = 920, that's voting power

            const contrib1 = ethers.parseEther("600");
            const contrib2 = ethers.parseEther("400");
            const immediate2 = (contrib2 * 2000n) / 10000n; // 80
            const locked2 = contrib2 - immediate2; // 320
            const totalLocked = contrib1 + locked2; // 920

            await testToken.connect(backer1).approve(await project.getAddress(), contrib1 + contrib2);
            await project.connect(backer1).sendFunds(contrib1);
            await project.connect(backer1).sendFundsWithImmediate(contrib2, 2000n);

            // Sign
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await project.connect(contractor).signContract();

            // Vote to release - voting power should be totalLocked (920)
            await project.connect(backer1).voteToReleasePayment();
            expect(await project.totalVotesForRelease()).to.equal(totalLocked);

            // With 70% quorum, 920/920 = 100% > 70%, should close
            expect(await project.stage()).to.equal(6); // Closed
        });
    });

    describe("Native Project Multi-Contribution Scenarios", function() {

        it("should handle multiple native contributions with mixed immediates", async function() {
            const project = await createNativeProject();

            // First: 1 ETH at 0% immediate
            const contrib1 = ethers.parseEther("1");
            await project.connect(backer1).sendFunds({ value: contrib1 });

            // Second: 0.5 ETH at 20% immediate
            const contrib2 = ethers.parseEther("0.5");
            const immediate2 = (contrib2 * 2000n) / 10000n;
            await project.connect(backer1).sendFundsWithImmediate(2000, { value: contrib2 });

            const total = contrib1 + contrib2;
            expect(await project.projectValue()).to.equal(total);

            // Withdraw pre-signing
            await project.connect(backer1).withdrawAsContributor();
            expect(await ethers.provider.getBalance(await project.getAddress())).to.equal(0);
        });

        it("should handle native project arbitration with mixed immediates", async function() {
            const project = await createNativeProject();

            const contrib1 = ethers.parseEther("0.6");  // 0% immediate
            const contrib2 = ethers.parseEther("0.4");  // 20% immediate
            const immediate2 = (contrib2 * 2000n) / 10000n;
            const totalLocked = contrib1 + contrib2 - immediate2;

            await project.connect(backer1).sendFunds({ value: contrib1 });
            await project.connect(backer1).sendFundsWithImmediate(2000, { value: contrib2 });

            // Sign
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await project.connect(contractor).signContract({ value: contractorStake });

            // Dispute and arbitrate
            await project.connect(backer1).voteToDispute();
            await project.connect(arbiter).arbitrate(60, "ruling_hash");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // Withdraw all
            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();

            // Zero balance
            expect(await ethers.provider.getBalance(await project.getAddress())).to.equal(0);
        });
    });

    describe("Pre-signing Withdrawal Edge Cases", function() {

        it("should allow full withdrawal in Open stage (no parties set)", async function() {
            // Create project without setting parties (stage = Open)
            const tx = await economy.connect(author).createERC20Project(
                "Test", ethers.ZeroAddress, ethers.ZeroAddress, "", "", "",
                await testToken.getAddress()
            );
            const receipt = await tx.wait();
            const projectAddress = receipt.logs.find(log => log.eventName === 'NewProject').args.contractAddress;
            const project = await ethers.getContractAt("ERC20Project", projectAddress);

            expect(await project.stage()).to.equal(0); // Open

            const amount = ethers.parseEther("100");
            await testToken.connect(backer1).approve(projectAddress, amount);
            await project.connect(backer1).sendFunds(amount);

            // Withdraw in Open stage
            const balanceBefore = await testToken.balanceOf(backer1.address);
            await project.connect(backer1).withdrawAsContributor();
            const balanceAfter = await testToken.balanceOf(backer1.address);

            expect(balanceAfter - balanceBefore).to.equal(amount);
        });

        it("should allow full withdrawal in Pending stage (after parties set)", async function() {
            const project = await createERC20Project();
            expect(await project.stage()).to.equal(1); // Pending

            const amount = ethers.parseEther("100");
            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFundsWithImmediate(amount, 1500n); // 15% immediate

            // Withdraw in Pending stage (before signing)
            const balanceBefore = await testToken.balanceOf(backer1.address);
            await project.connect(backer1).withdrawAsContributor();
            const balanceAfter = await testToken.balanceOf(backer1.address);

            // Should get FULL amount back (not just locked portion)
            expect(balanceAfter - balanceBefore).to.equal(amount);
        });

        it("should NOT allow withdrawal in Ongoing stage", async function() {
            const project = await createERC20Project();

            const amount = ethers.parseEther("100");
            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            // Sign to move to Ongoing
            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            await testToken.connect(contractor).approve(await project.getAddress(), arbitrationFee / 2n);
            await project.connect(contractor).signContract();

            expect(await project.stage()).to.equal(2); // Ongoing

            // Try to withdraw - should fail
            await expect(
                project.connect(backer1).withdrawAsContributor()
            ).to.be.revertedWith("Withdrawals only allowed when the project is open, pending or closed.");
        });

        it("should NOT allow withdrawal in Dispute stage", async function() {
            const project = await createERC20Project();

            const amount = ethers.parseEther("100");
            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            await testToken.connect(contractor).approve(await project.getAddress(), arbitrationFee / 2n);
            await project.connect(contractor).signContract();

            // Move to Dispute
            await project.connect(backer1).voteToDispute();
            expect(await project.stage()).to.equal(3); // Dispute

            // Try to withdraw - should fail
            await expect(
                project.connect(backer1).withdrawAsContributor()
            ).to.be.revertedWith("Withdrawals only allowed when the project is open, pending or closed.");
        });
    });

    describe("Actual Amount Storage (replaces weighted average)", function() {

        it("should correctly store actual amounts for equal contributions", async function() {
            const project = await createERC20Project();

            // 500 at 0% + 500 at 20%
            // Immediate: 0 + 100 = 100
            // Locked: 500 + 400 = 900
            const contrib = ethers.parseEther("500");
            const immediateFrom2nd = (contrib * 2000n) / 10000n; // 100 ether

            await testToken.connect(backer1).approve(await project.getAddress(), contrib * 2n);
            await project.connect(backer1).sendFunds(contrib); // 0%
            await project.connect(backer1).sendFundsWithImmediate(contrib, 2000n); // 20%

            const contribData = await project.contributions(backer1.address);

            // Now stores actual amounts, not bps
            expect(contribData.total).to.equal(contrib * 2n);
            expect(contribData.immediate).to.equal(immediateFrom2nd); // 100 ether
            expect(contribData.locked).to.equal(contrib * 2n - immediateFrom2nd); // 900 ether

            expect(await project.totalImmediate()).to.equal(ethers.parseEther("100"));
            expect(await project.totalLocked()).to.equal(ethers.parseEther("900"));
        });

        it("should correctly store actual amounts for unequal contributions", async function() {
            const project = await createERC20Project();

            // 100 at 10% + 900 at 20%
            // Immediate: 10 + 180 = 190
            // Locked: 90 + 720 = 810
            const contrib1 = ethers.parseEther("100");
            const contrib2 = ethers.parseEther("900");
            const immediate1 = (contrib1 * 1000n) / 10000n; // 10 ether
            const immediate2 = (contrib2 * 2000n) / 10000n; // 180 ether
            const totalImmediate = immediate1 + immediate2; // 190 ether
            const totalLocked = contrib1 + contrib2 - totalImmediate; // 810 ether

            await testToken.connect(backer1).approve(await project.getAddress(), contrib1 + contrib2);
            await project.connect(backer1).sendFundsWithImmediate(contrib1, 1000n); // 10%
            await project.connect(backer1).sendFundsWithImmediate(contrib2, 2000n); // 20%

            const contribData = await project.contributions(backer1.address);
            expect(contribData.total).to.equal(contrib1 + contrib2);
            expect(contribData.immediate).to.equal(totalImmediate);
            expect(contribData.locked).to.equal(totalLocked);

            expect(await project.totalImmediate()).to.equal(ethers.parseEther("190"));
            expect(await project.totalLocked()).to.equal(ethers.parseEther("810"));
        });
    });
});
