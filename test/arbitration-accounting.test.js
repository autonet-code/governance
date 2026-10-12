const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { passCoolingOff } = require("./helpers/coolingOff");

/**
 * Arbitration Fund Accounting Tests
 *
 * These tests verify that ALL funds are properly accounted for after dispute resolution.
 * Key invariants:
 * 1. Total funds in = total funds out (no funds stuck in contract)
 * 2. Each party receives the mathematically correct amount per the requirements
 *
 * Requirements from ARBITRATION_REQUIREMENTS.md:
 * - pool = totalLocked - (arbitrationFee / 2)
 * - Contractor gets: (pool * X / 100) - platformFee - authorFee
 * - Backer gets: (pool * (100 - X) / 100) * lockedAmount / totalLocked
 * - Arbiter gets: full arbitrationFee (half from contractor stake, half from backer pool)
 */
describe("Arbitration Fund Accounting", function () {
    let economy, nativeProjectImpl, erc20ProjectImpl, testToken, mockRepToken, mockGovernor;
    let deployer, timelock, registry, author, contractor, arbiter, backer1, backer2, backer3;

    const NATIVE_CURRENCY = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    const ARBITRATION_FEE_BPS = 100; // 1% for easy math
    const PLATFORM_FEE_BPS = 250; // 2.5%
    const AUTHOR_FEE_BPS = 500; // 5%
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

        // Set DAO parameters
        await economy.connect(timelock).setProjectThreshold(PROJECT_THRESHOLD);
        await economy.connect(timelock).setPlatformFee(PLATFORM_FEE_BPS);
        await economy.connect(timelock).setAuthorFee(AUTHOR_FEE_BPS);

        // Mint reputation to author so they can create projects
        await mockRepToken.mint(author.address, PROJECT_THRESHOLD);

        // Fund test accounts
        await testToken.connect(deployer).transfer(backer1.address, ethers.parseEther("10000"));
        await testToken.connect(deployer).transfer(backer2.address, ethers.parseEther("10000"));
        await testToken.connect(deployer).transfer(backer3.address, ethers.parseEther("10000"));
        await testToken.connect(deployer).transfer(contractor.address, ethers.parseEther("10000"));
    });

    describe("No Dispute Scenarios", function() {
        it("should handle release vote: contractor gets totalLocked minus fees, reclaims stake", async function() {
            const project = await createERC20Project();
            const fundingAmount = ethers.parseEther("1000");
            const totalLocked = fundingAmount; // No immediate release
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;

            // Record initial balances
            const contractorBefore = await testToken.balanceOf(contractor.address);
            const authorBefore = await testToken.balanceOf(author.address);

            // Fund and sign
            await testToken.connect(backer1).approve(await project.getAddress(), fundingAmount);
            await project.connect(backer1).sendFunds(fundingAmount);
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            // Backer votes to release (not dispute)
            await project.connect(backer1).voteToReleasePayment();
            expect(await project.stage()).to.equal(6); // Closed

            // Contractor reclaims stake
            await project.connect(contractor).reclaimArbitrationStake();

            // Contractor withdraws
            await project.connect(contractor).withdrawAsContractor();

            // Calculate expected amounts
            const platformFee = (totalLocked * BigInt(PLATFORM_FEE_BPS)) / 10000n;
            const remainder = totalLocked - platformFee;
            const authorFee = (remainder * BigInt(AUTHOR_FEE_BPS)) / 10000n;
            const expectedContractorNet = remainder - authorFee;

            // Verify amounts
            const contractorAfter = await testToken.balanceOf(contractor.address);
            const authorAfter = await testToken.balanceOf(author.address);

            // Contractor should have: original - stake + stake (reclaimed) + net earnings
            expect(contractorAfter - contractorBefore).to.equal(expectedContractorNet);
            expect(authorAfter - authorBefore).to.equal(authorFee);

            // Backer can withdraw but gets nothing (release vote = 100% to contractor)
            await project.connect(backer1).withdrawAsContributor();

            // Zero balance
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should handle reimburse: backers get totalLocked back, contractor reclaims stake", async function() {
            const project = await createERC20Project();
            const fundingAmount = ethers.parseEther("1000");
            const totalLocked = fundingAmount;
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;

            const backer1Before = await testToken.balanceOf(backer1.address);
            const contractorBefore = await testToken.balanceOf(contractor.address);

            // Fund and sign
            await testToken.connect(backer1).approve(await project.getAddress(), fundingAmount);
            await project.connect(backer1).sendFunds(fundingAmount);
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            // Contractor reimburses
            await project.connect(contractor).reimburse();
            expect(await project.stage()).to.equal(6); // Closed

            // Contractor reclaims stake
            await project.connect(contractor).reclaimArbitrationStake();

            // Backer withdraws - should get full refund
            await project.connect(backer1).withdrawAsContributor();

            const backer1After = await testToken.balanceOf(backer1.address);
            const contractorAfter = await testToken.balanceOf(contractor.address);

            // Backer should get full locked amount back
            expect(backer1After - backer1Before).to.equal(0n); // Net zero: funded then refunded

            // Contractor should be net zero (stake deposited and reclaimed)
            expect(contractorAfter - contractorBefore).to.equal(0n);

            // Zero balance
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });
    });

    describe("Dispute Edge Cases", function() {
        it("should handle 0% ruling: backers get full pool, contractor gets nothing", async function() {
            const project = await createERC20Project();
            const fundingAmount = ethers.parseEther("1000");
            const totalLocked = fundingAmount;
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n; // 10
            const contractorStake = arbitrationFee / 2n; // 5
            const backersArbShare = arbitrationFee - contractorStake; // 5
            const pool = totalLocked - backersArbShare; // 995

            const backer1Before = await testToken.balanceOf(backer1.address);
            const contractorBefore = await testToken.balanceOf(contractor.address);
            const arbiterBefore = await testToken.balanceOf(arbiter.address);

            // Fund, sign, dispute
            await testToken.connect(backer1).approve(await project.getAddress(), fundingAmount);
            await project.connect(backer1).sendFunds(fundingAmount);
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();
            await project.connect(backer1).voteToDispute();

            // Arbiter rules 0% to contractor
            await project.connect(arbiter).arbitrate(0, "ruling_hash");

            // Finalize
            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // Withdrawals
            await project.connect(backer1).withdrawAsContributor();
            // Contractor has nothing to withdraw (0% ruling)

            const backer1After = await testToken.balanceOf(backer1.address);
            const arbiterAfter = await testToken.balanceOf(arbiter.address);

            // Backer gets full pool (100% of pool since contractor gets 0%)
            // pool = 995, backer proportion = 1000/1000 = 100%
            expect(backer1After - backer1Before).to.equal(-backersArbShare); // Lost only arb fee share

            // Arbiter gets full arb fee
            expect(arbiterAfter - arbiterBefore).to.equal(arbitrationFee - (arbitrationFee * BigInt(PLATFORM_FEE_BPS)) / 10000n);

            // Zero balance
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should handle 100% ruling: contractor gets full pool minus fees", async function() {
            const project = await createERC20Project();
            const fundingAmount = ethers.parseEther("1000");
            const totalLocked = fundingAmount;
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            const backersArbShare = arbitrationFee - contractorStake;
            const pool = totalLocked - backersArbShare;

            const contractorBefore = await testToken.balanceOf(contractor.address);
            const arbiterBefore = await testToken.balanceOf(arbiter.address);
            const authorBefore = await testToken.balanceOf(author.address);

            // Fund, sign, dispute
            await testToken.connect(backer1).approve(await project.getAddress(), fundingAmount);
            await project.connect(backer1).sendFunds(fundingAmount);
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();
            await project.connect(backer1).voteToDispute();

            // Arbiter rules 100% to contractor
            await project.connect(arbiter).arbitrate(100, "ruling_hash");

            // Finalize
            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // Contractor withdraws
            await project.connect(contractor).withdrawAsContractor();

            // Backer withdraws (gets nothing)
            await project.connect(backer1).withdrawAsContributor();

            const contractorAfter = await testToken.balanceOf(contractor.address);
            const arbiterAfter = await testToken.balanceOf(arbiter.address);
            const authorAfter = await testToken.balanceOf(author.address);

            // Contractor gets 100% of pool minus fees
            const platformFee = (pool * BigInt(PLATFORM_FEE_BPS)) / 10000n;
            const remainder = pool - platformFee;
            const authorFee = (remainder * BigInt(AUTHOR_FEE_BPS)) / 10000n;
            const expectedContractorNet = remainder - authorFee;

            // Net change for contractor: -stake + earnings
            expect(contractorAfter - contractorBefore).to.equal(expectedContractorNet - contractorStake);
            expect(arbiterAfter - arbiterBefore).to.equal(arbitrationFee - (arbitrationFee * BigInt(PLATFORM_FEE_BPS)) / 10000n);
            expect(authorAfter - authorBefore).to.equal(authorFee);

            // Zero balance
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });
    });

    describe("Immediate Release Scenarios", function() {
        it("should correctly handle dispute with immediate release (90% ruling)", async function() {
            const project = await createERC20Project();
            const fundingAmount = ethers.parseEther("1000");
            const immediateBps = 1000n; // 10% immediate
            const immediateAmount = (fundingAmount * immediateBps) / 10000n; // 100
            const totalLocked = fundingAmount - immediateAmount; // 900
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n; // 9
            const contractorStake = arbitrationFee / 2n; // 4 (integer division)
            const backersArbShare = arbitrationFee - contractorStake; // 5
            const pool = totalLocked - backersArbShare; // 895

            const contractorBefore = await testToken.balanceOf(contractor.address);
            const backer1Before = await testToken.balanceOf(backer1.address);
            const arbiterBefore = await testToken.balanceOf(arbiter.address);

            // Fund with immediate release
            await testToken.connect(backer1).approve(await project.getAddress(), fundingAmount);
            await project.connect(backer1).sendFundsWithImmediate(fundingAmount, immediateBps);

            // Sign - immediate is released here
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            // Verify immediate was released
            const contractorAfterSign = await testToken.balanceOf(contractor.address);
            // Immediate release is taxed like any other payout
            const immediatePlatformFee = (immediateAmount * BigInt(PLATFORM_FEE_BPS)) / 10000n;
            const immediateAuthorFee = ((immediateAmount - immediatePlatformFee) * BigInt(AUTHOR_FEE_BPS)) / 10000n;
            const immediateNet = immediateAmount - immediatePlatformFee - immediateAuthorFee;
            expect(contractorAfterSign - contractorBefore).to.equal(immediateNet - contractorStake);

            // Dispute
            await project.connect(backer1).voteToDispute();
            await project.connect(arbiter).arbitrate(90, "ruling_hash");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // Withdrawals
            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();

            const contractorAfter = await testToken.balanceOf(contractor.address);
            const backer1After = await testToken.balanceOf(backer1.address);
            const arbiterAfter = await testToken.balanceOf(arbiter.address);

            // Contractor: 90% of pool minus fees (plus already received immediate)
            const contractorEntitlement = (pool * 90n) / 100n;
            const platformFee = (contractorEntitlement * BigInt(PLATFORM_FEE_BPS)) / 10000n;
            const remainder = contractorEntitlement - platformFee;
            const authorFee = (remainder * BigInt(AUTHOR_FEE_BPS)) / 10000n;
            const contractorNet = remainder - authorFee;

            // Backer: 10% of pool proportional to locked amount
            const backerRefund = ((pool * 10n) / 100n) * totalLocked / totalLocked; // 89.5

            // Contractor total gain = immediate + contractorNet - stake
            expect(contractorAfter - contractorBefore).to.equal(immediateNet + contractorNet - contractorStake);

            // Backer loss = funding - refund
            expect(backer1Before - backer1After).to.equal(fundingAmount - backerRefund);

            // Arbiter gets the fee minus platform fee
            expect(arbiterAfter - arbiterBefore).to.equal(arbitrationFee - (arbitrationFee * BigInt(PLATFORM_FEE_BPS)) / 10000n);

            // Zero balance
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });
    });

    describe("Multiple Backers with Different Proportions", function() {
        it("should distribute refunds proportionally based on locked amounts", async function() {
            const project = await createERC20Project();
            const funding1 = ethers.parseEther("600"); // 60%
            const funding2 = ethers.parseEther("400"); // 40%
            const totalFunding = funding1 + funding2;
            const totalLocked = totalFunding; // No immediate
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            const backersArbShare = arbitrationFee - contractorStake;
            const pool = totalLocked - backersArbShare;

            const backer1Before = await testToken.balanceOf(backer1.address);
            const backer2Before = await testToken.balanceOf(backer2.address);

            // Both backers fund
            await testToken.connect(backer1).approve(await project.getAddress(), funding1);
            await project.connect(backer1).sendFunds(funding1);
            await testToken.connect(backer2).approve(await project.getAddress(), funding2);
            await project.connect(backer2).sendFunds(funding2);

            // Sign
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            // Dispute with 50% ruling
            await project.connect(backer1).voteToDispute();
            await project.connect(backer2).voteToDispute();
            await project.connect(arbiter).arbitrate(50, "ruling_hash");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // Withdrawals
            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();
            await project.connect(backer2).withdrawAsContributor();

            const backer1After = await testToken.balanceOf(backer1.address);
            const backer2After = await testToken.balanceOf(backer2.address);

            // Backers get 50% of pool, proportional to their locked amounts
            const backerPool = (pool * 50n) / 100n;
            const backer1Refund = (backerPool * funding1) / totalLocked;
            const backer2Refund = (backerPool * funding2) / totalLocked;

            expect(backer1Before - backer1After).to.equal(funding1 - backer1Refund);
            expect(backer2Before - backer2After).to.equal(funding2 - backer2Refund);

            // Zero balance
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should handle backers with different immediate release percentages", async function() {
            const project = await createERC20Project();

            // Backer1: 600 with 10% immediate (540 locked)
            // Backer2: 400 with 20% immediate (320 locked) - max allowed is 20%
            const funding1 = ethers.parseEther("600");
            const funding2 = ethers.parseEther("400");
            const immediate1Bps = 1000n; // 10%
            const immediate2Bps = 2000n; // 20% (max allowed)

            const immediate1 = (funding1 * immediate1Bps) / 10000n; // 60
            const immediate2 = (funding2 * immediate2Bps) / 10000n; // 80
            const locked1 = funding1 - immediate1; // 540
            const locked2 = funding2 - immediate2; // 320
            const totalLocked = locked1 + locked2; // 860

            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            const backersArbShare = arbitrationFee - contractorStake;
            const pool = totalLocked - backersArbShare;

            const backer1Before = await testToken.balanceOf(backer1.address);
            const backer2Before = await testToken.balanceOf(backer2.address);

            // Fund with different immediate percentages
            await testToken.connect(backer1).approve(await project.getAddress(), funding1);
            await project.connect(backer1).sendFundsWithImmediate(funding1, immediate1Bps);
            await testToken.connect(backer2).approve(await project.getAddress(), funding2);
            await project.connect(backer2).sendFundsWithImmediate(funding2, immediate2Bps);

            // Sign
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            // Dispute with 40% ruling
            await project.connect(backer1).voteToDispute();
            await project.connect(backer2).voteToDispute();
            await project.connect(arbiter).arbitrate(40, "ruling_hash");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // Withdrawals
            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();
            await project.connect(backer2).withdrawAsContributor();

            const backer1After = await testToken.balanceOf(backer1.address);
            const backer2After = await testToken.balanceOf(backer2.address);

            // Backers get 60% of pool (100-40), proportional to LOCKED amounts
            const backerPool = (pool * 60n) / 100n;
            const backer1Refund = (backerPool * locked1) / totalLocked;
            const backer2Refund = (backerPool * locked2) / totalLocked;

            // Backer loss = total funded - refund received
            expect(backer1Before - backer1After).to.equal(funding1 - backer1Refund);
            expect(backer2Before - backer2After).to.equal(funding2 - backer2Refund);

            // Zero balance
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });
    });

    describe("DAO Overrule", function() {
        it("should correctly distribute funds after DAO overrules arbiter", async function() {
            const project = await createERC20Project();
            const fundingAmount = ethers.parseEther("1000");
            const totalLocked = fundingAmount;
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            const backersArbShare = arbitrationFee - contractorStake;
            const pool = totalLocked - backersArbShare;

            const contractorBefore = await testToken.balanceOf(contractor.address);
            const backer1Before = await testToken.balanceOf(backer1.address);
            const arbiterBefore = await testToken.balanceOf(arbiter.address);

            // Fund and sign
            await testToken.connect(backer1).approve(await project.getAddress(), fundingAmount);
            await project.connect(backer1).sendFunds(fundingAmount);
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            // Dispute
            await project.connect(backer1).voteToDispute();

            // Arbiter rules 30%
            await project.connect(arbiter).arbitrate(30, "ruling_hash");

            // Setup mocks for appeal
            await mockRepToken.mint(backer1.address, PROJECT_THRESHOLD);
            await mockGovernor.setProposalState(1); // Active state

            // Appeal
            await project.connect(backer1).appeal(123, [await project.getAddress()]);

            // DAO overrules to 80%
            await project.connect(timelock).daoOverrule(80, "dao_ruling");

            // Withdrawals
            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();

            const contractorAfter = await testToken.balanceOf(contractor.address);
            const backer1After = await testToken.balanceOf(backer1.address);
            const arbiterAfter = await testToken.balanceOf(arbiter.address);

            // Calculate expected amounts based on 80% ruling (DAO's decision)
            const contractorEntitlement = (pool * 80n) / 100n;
            const platformFee = (contractorEntitlement * BigInt(PLATFORM_FEE_BPS)) / 10000n;
            const remainder = contractorEntitlement - platformFee;
            const authorFee = (remainder * BigInt(AUTHOR_FEE_BPS)) / 10000n;
            const contractorNet = remainder - authorFee;

            const backerRefund = (pool * 20n) / 100n;

            expect(contractorAfter - contractorBefore).to.equal(contractorNet - contractorStake);
            expect(backer1Before - backer1After).to.equal(fundingAmount - backerRefund);
            expect(arbiterAfter - arbiterBefore).to.equal(arbitrationFee - (arbitrationFee * BigInt(PLATFORM_FEE_BPS)) / 10000n);

            // Zero balance
            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });
    });

    describe("Native Project Scenarios", function() {
        it("should correctly handle native project dispute with zero balance after withdrawals", async function() {
            const project = await createNativeProject();
            const fundingAmount = ethers.parseEther("10");
            const totalLocked = fundingAmount;
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;

            // Fund
            await project.connect(backer1).sendFunds({ value: fundingAmount });

            // Sign
            await passCoolingOff(project);
            await project.connect(contractor).signContract({ value: contractorStake });

            // Dispute
            await project.connect(backer1).voteToDispute();
            await project.connect(arbiter).arbitrate(70, "ruling_hash");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            // Withdrawals
            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();

            // KEY ASSERTION: Zero balance (main invariant)
            expect(await ethers.provider.getBalance(await project.getAddress())).to.equal(0);
        });

        it("should handle native project release vote with zero balance after withdrawals", async function() {
            const project = await createNativeProject();
            const fundingAmount = ethers.parseEther("10");
            const totalLocked = fundingAmount;
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;

            // Fund and sign
            await project.connect(backer1).sendFunds({ value: fundingAmount });
            await passCoolingOff(project);
            await project.connect(contractor).signContract({ value: contractorStake });

            // Release vote
            await project.connect(backer1).voteToReleasePayment();

            // Contractor reclaims stake and withdraws
            await project.connect(contractor).reclaimArbitrationStake();
            await project.connect(contractor).withdrawAsContractor();

            // Backer withdraws (gets nothing on release)
            await project.connect(backer1).withdrawAsContributor();

            // KEY ASSERTION: Zero balance
            expect(await ethers.provider.getBalance(await project.getAddress())).to.equal(0);
        });
    });

    describe("Zero Balance Invariant (Original Tests)", function() {
        it("should have zero balance after all withdrawals (single backer, 90% ruling, WITH immediate release)", async function() {
            const project = await createERC20Project();
            const fundingAmount = ethers.parseEther("1000");
            const immediateBps = 1000n;
            const totalLocked = fundingAmount - (fundingAmount * immediateBps) / 10000n;
            const arbitrationFee = (totalLocked * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;

            await testToken.connect(backer1).approve(await project.getAddress(), fundingAmount);
            await project.connect(backer1).sendFundsWithImmediate(fundingAmount, immediateBps);
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();
            await project.connect(backer1).voteToDispute();
            await project.connect(arbiter).arbitrate(90, "ruling_hash");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.connect(backer1).finalizeArbitration();

            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();

            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should have zero balance after all withdrawals (multiple backers, 60% ruling)", async function() {
            const project = await createERC20Project();
            const funding1 = ethers.parseEther("600");
            const funding2 = ethers.parseEther("400");
            const totalFunding = funding1 + funding2;
            const arbitrationFee = (totalFunding * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;

            await testToken.connect(backer1).approve(await project.getAddress(), funding1);
            await project.connect(backer1).sendFunds(funding1);
            await testToken.connect(backer2).approve(await project.getAddress(), funding2);
            await project.connect(backer2).sendFunds(funding2);
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();
            await project.connect(backer1).voteToDispute();
            await project.connect(backer2).voteToDispute();
            await project.connect(arbiter).arbitrate(60, "ruling_hash");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();
            await project.connect(backer2).withdrawAsContributor();

            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });
    });
});
