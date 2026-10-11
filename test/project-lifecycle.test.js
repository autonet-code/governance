const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Project Lifecycle under DAO Governance", function () {
    let economy, nativeProjectImpl, erc20ProjectImpl, testToken, mockRepToken;
    let deployer, timelock, registry, governor, author, contractor, arbiter, user1, user2;

    const NATIVE_CURRENCY = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    const ARBITRATION_FEE_BPS = 500; // 5%

    // Helper function to create a new project
    async function createProject(isNative, parties = {}) {
        const _author = parties.author || author;
        const _contractor = parties.contractor || contractor;
        const _arbiter = parties.arbiter || arbiter;

        if (isNative) {
            const tx = await economy.connect(_author).createProject(
                "Native Project", _contractor.address, _arbiter.address, "terms", "repo", "desc"
            );
            const receipt = await tx.wait();
            const projectAddress = receipt.logs.find(log => log.eventName === 'NewProject').args.contractAddress;
            return ethers.getContractAt("NativeProject", projectAddress);
        } else {
            const tx = await economy.connect(_author).createERC20Project(
                "ERC20 Project", _contractor.address, _arbiter.address, "terms", "repo", "desc",
                await testToken.getAddress()
            );
            const receipt = await tx.wait();
            const projectAddress = receipt.logs.find(log => log.eventName === 'NewProject').args.contractAddress;
            return ethers.getContractAt("ERC20Project", projectAddress);
        }
    }

    beforeEach(async function () {
        [deployer, timelock, registry, governor, author, contractor, arbiter, user1, user2] = await ethers.getSigners();

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

        await economy.connect(deployer).setImplementations(await nativeProjectImpl.getAddress(), await erc20ProjectImpl.getAddress());
        await economy.connect(deployer).setDaoAddresses(timelock.address, registry.address, governor.address, await mockRepToken.getAddress());

        await testToken.connect(deployer).transfer(author.address, ethers.parseEther("10000"));
        await testToken.connect(deployer).transfer(contractor.address, ethers.parseEther("10000"));
        await testToken.connect(deployer).transfer(user1.address, ethers.parseEther("10000"));
        await testToken.connect(deployer).transfer(user2.address, ethers.parseEther("10000"));
    });

    describe("Happy Path Workflow (ERC20 Project)", function() {
        let project;
        const fundingAmount = ethers.parseEther("1000");

        it("should allow a project to proceed from creation to successful withdrawal", async function() {
            // 1. Create Project (Pending stage)
            project = await createProject(false); // ERC20
            expect(await project.stage()).to.equal(1); // Pending

            // 2. Fund Project
            await testToken.connect(user1).approve(await project.getAddress(), fundingAmount);
            await project.connect(user1).sendFunds(fundingAmount);
            expect(await project.projectValue()).to.equal(fundingAmount);

            // 3. Contractor signs and stakes half the arbitration fee (Ongoing stage)
            const arbitrationFee = (fundingAmount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            await testToken.connect(contractor).approve(await project.getAddress(), arbitrationFee / 2n);
            await project.connect(contractor).signContract();
            expect(await project.stage()).to.equal(2); // Ongoing

            // 4. Backers vote to release funds (Closed stage)
            await project.connect(user1).voteToReleasePayment();
            expect(await project.stage()).to.equal(6); // Closed
            expect(await project.fundsReleased()).to.be.true;
            expect(await project.disputeResolution()).to.equal(100); // 100% to contractor on release

            // 5. Contractor withdraws payment
            const contractorBalanceBefore = await testToken.balanceOf(contractor.address);
            const authorBalanceBefore = await testToken.balanceOf(author.address);

            await project.connect(contractor).withdrawAsContractor();

            const platformFee = fundingAmount / 100n; // 1%
            const authorFee = (fundingAmount - platformFee) / 100n; // 1% of remainder
            const expectedContractorPayout = fundingAmount - platformFee - authorFee;

            expect(await testToken.balanceOf(contractor.address)).to.equal(contractorBalanceBefore + expectedContractorPayout);
            expect(await testToken.balanceOf(author.address)).to.equal(authorBalanceBefore + authorFee);

            // 6. Verify earnings were recorded in Economy
            const contractorProfile = await economy.getUser(contractor.address);
            const authorProfile = await economy.getUser(author.address);
            const tokenAddr = await testToken.getAddress();

            expect(contractorProfile.earnedTokens[0]).to.equal(tokenAddr);
            expect(contractorProfile.earnedAmounts[0]).to.equal(expectedContractorPayout);
            expect(authorProfile.earnedTokens[0]).to.equal(tokenAddr);
            expect(authorProfile.earnedAmounts[0]).to.equal(authorFee);

            // 7. Contractor reclaims their arbitration stake (no dispute occurred)
            const contractorStakeBalanceBefore = await testToken.balanceOf(contractor.address);
            await project.connect(contractor).reclaimArbitrationStake();
            expect(await testToken.balanceOf(contractor.address)).to.equal(contractorStakeBalanceBefore + arbitrationFee / 2n);
        });
    });

    describe("Dispute Path Workflow (Native Project)", function() {
        let project;
        const fundingAmount = ethers.parseEther("10");
        const arbiterPayoutPercent = 60; // Arbiter rules 60% in favor of contractor

        it("should correctly handle a dispute, arbitration, and partial withdrawals", async function() {
            // 1. Create and fund project
            project = await createProject(true); // Native
            await project.connect(user1).sendFunds({ value: fundingAmount });

            // Calculate arbitration fee based on project value
            const arbitrationFee = (fundingAmount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;

            // Contractor signs and stakes half the arbitration fee
            await project.connect(contractor).signContract({ value: arbitrationFee / 2n });
            expect(await project.stage()).to.equal(2); // Ongoing

            // 2. Backers vote to dispute (Dispute stage)
            await project.connect(user1).voteToDispute();
            expect(await project.stage()).to.equal(3); // Dispute

            // 3. Arbiter makes a ruling (Appealable stage)
            const arbiterBalanceBefore = await ethers.provider.getBalance(arbiter.address);
            const arbitrateTx = await project.connect(arbiter).arbitrate(arbiterPayoutPercent, "ruling_hash");
            const arbitrateReceipt = await arbitrateTx.wait();
            const arbitrateGasUsed = arbitrateReceipt.gasUsed * arbitrateTx.gasPrice;

            expect(await project.stage()).to.equal(4); // Appealable
            expect(await project.originalDisputeResolution()).to.equal(arbiterPayoutPercent);

            // 4. Simulate appeal period ending without a DAO appeal, then finalize
            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.connect(user1).finalizeArbitration();

            // 5. Verify final state (Closed)
            expect(await project.stage()).to.equal(6); // Closed
            expect(await project.disputeResolution()).to.equal(arbiterPayoutPercent);
            // Arbiter gets the arbitration fee minus the platform fee
            const arbiterNet = arbitrationFee - (arbitrationFee * (await economy.platformFeeBps())) / 10000n;
            expect(await ethers.provider.getBalance(arbiter.address)).to.equal(arbiterBalanceBefore - arbitrateGasUsed + arbiterNet);

            // 6. Contractor withdraws their partial payment
            // The project value after arbitration fee deduction (half comes from project funds)
            const contributorShareOfArbFee = arbitrationFee - (arbitrationFee / 2n);
            const projectValueAfterFee = fundingAmount - contributorShareOfArbFee;
            const expectedContractorShare = (projectValueAfterFee * BigInt(arbiterPayoutPercent)) / 100n;
            const platformFee = expectedContractorShare / 100n;
            const authorFee = (expectedContractorShare - platformFee) / 100n;

            await project.connect(contractor).withdrawAsContractor();

            // 7. Contributor withdraws their remaining funds
            const userBalanceBefore = await ethers.provider.getBalance(user1.address);

            const withdrawTx = await project.connect(user1).withdrawAsContributor();
            const withdrawReceipt = await withdrawTx.wait();
            const withdrawGas = withdrawReceipt.gasUsed * withdrawTx.gasPrice;

            // User's refund accounts for arbitration fee share and dispute resolution
            const userArbFeeShare = contributorShareOfArbFee;
            const remainingAfterArbFee = fundingAmount - userArbFeeShare;
            const expectedUserRefund = (remainingAfterArbFee * BigInt(100 - arbiterPayoutPercent)) / 100n;

            expect(await ethers.provider.getBalance(user1.address)).to.equal(userBalanceBefore + expectedUserRefund - withdrawGas);

            // 8. Verify spendings were recorded in Economy
            const userProfile = await economy.getUser(user1.address);
            const expectedExpenditure = fundingAmount - expectedUserRefund;
            expect(userProfile.spentTokens[0]).to.equal(NATIVE_CURRENCY);
            expect(userProfile.spentAmounts[0]).to.equal(expectedExpenditure);
        });
    });

    describe("Alternative & Edge Cases", function() {
        it("should allow a contributor to withdraw funds before a contract is signed", async function() {
            const project = await createProject(false); // ERC20
            const fundingAmount = ethers.parseEther("250");
            await testToken.connect(user1).approve(await project.getAddress(), fundingAmount);
            await project.connect(user1).sendFunds(fundingAmount);

            const userBalanceBefore = await testToken.balanceOf(user1.address);
            await project.connect(user1).withdrawAsContributor();
            expect(await testToken.balanceOf(user1.address)).to.equal(userBalanceBefore + fundingAmount);
        });

        it("should correctly handle a contributor switching their vote from Dispute to Release", async function() {
            const project = await createProject(false); // ERC20
            const amount1 = ethers.parseEther("300"); // 30%
            const amount2 = ethers.parseEther("700"); // 70%
            await testToken.connect(user1).approve(await project.getAddress(), amount1);
            await project.connect(user1).sendFunds(amount1);
            await testToken.connect(user2).approve(await project.getAddress(), amount2);
            await project.connect(user2).sendFunds(amount2);

            const totalFunding = amount1 + amount2;
            const arbitrationFee = (totalFunding * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            await testToken.connect(contractor).approve(await project.getAddress(), arbitrationFee / 2n);
            await project.connect(contractor).signContract();

            // 1. Minority user (user1) votes to dispute. Quorum is not met.
            await project.connect(user1).voteToDispute();
            expect(await project.stage()).to.equal(2); // Still Ongoing
            expect(await project.totalVotesForDispute()).to.equal(amount1);
            expect(await project.totalVotesForRelease()).to.equal(0);

            // 2. Minority user (user1) switches their vote to release.
            await project.connect(user1).voteToReleasePayment();
            expect(await project.stage()).to.equal(2); // Still Ongoing
            expect(await project.totalVotesForDispute()).to.equal(0);
            expect(await project.totalVotesForRelease()).to.equal(amount1);

            // 3. Majority user (user2) also votes to release, pushing the vote over the 70% quorum.
            await project.connect(user2).voteToReleasePayment();
            expect(await project.stage()).to.equal(6); // Now Closed
            expect(await project.totalVotesForRelease()).to.equal(amount1 + amount2);
        });

        it("should enforce the projectThreshold for creating projects", async function() {
            const threshold = ethers.parseEther("10");
            await economy.connect(timelock).setProjectThreshold(threshold);

            // This should fail, author has no RepTokens
            await expect(createProject(true)).to.be.revertedWith("Insufficient reputation to create a project");

            // Mint some mock rep tokens to the author
            await mockRepToken.connect(deployer).mint(author.address, threshold);

            // This should now succeed
            await expect(createProject(true)).to.not.be.reverted;
        });
    });
});
// project-lifecycle.test.js
