const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Appeals and Advanced Fund Handling", function () {
    let economy, nativeProjectImpl, erc20ProjectImpl, testToken, mockRepToken, mockGovernor;
    let deployer, timelock, registry, author, contractor, arbiter, user1, daoMember;

    const ARBITRATION_FEE_BPS = 500; // 5%
    const PROJECT_THRESHOLD = ethers.parseEther("1000");

    // Helper to set up a project in the Dispute stage
    async function setupDisputedProject() {
        // Create an ERC20 project
        const tx = await economy.connect(author).createERC20Project(
            "Appeal Test", contractor.address, arbiter.address, "t", "r", "d",
            await testToken.getAddress()
        );
        const receipt = await tx.wait();
        const projectAddress = receipt.logs.find(log => log.eventName === 'NewProject').args.contractAddress;
        const project = await ethers.getContractAt("ERC20Project", projectAddress);

        // Fund the project
        const fundingAmount = ethers.parseEther("5000");
        await testToken.connect(user1).approve(projectAddress, fundingAmount);
        await project.connect(user1).sendFunds(fundingAmount);

        // Contractor stakes half the arbitration fee and signs
        const arbitrationFee = (fundingAmount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
        await testToken.connect(contractor).approve(projectAddress, arbitrationFee / 2n);
        await project.connect(contractor).signContract();

        // Dispute it
        await project.connect(user1).voteToDispute();
        expect(await project.stage()).to.equal(3); // Dispute

        return { project, fundingAmount, arbitrationFee };
    }

    beforeEach(async function () {
        [deployer, timelock, registry, author, contractor, arbiter, user1, daoMember] = await ethers.getSigners();

        // Deploy implementations and core contracts
        const NativeProjectImpl = await ethers.getContractFactory("NativeProject");
        nativeProjectImpl = await NativeProjectImpl.deploy();
        const ERC20ProjectImpl = await ethers.getContractFactory("ERC20Project");
        erc20ProjectImpl = await ERC20ProjectImpl.deploy();
        const Economy = await ethers.getContractFactory("Economy");
        economy = await Economy.deploy(ARBITRATION_FEE_BPS);

        // Deploy mocks
        const TestToken = await ethers.getContractFactory("TestToken");
        testToken = await TestToken.deploy();
        const MockRepToken = await ethers.getContractFactory("MockRepToken");
        mockRepToken = await MockRepToken.deploy();
        const MockGovernor = await ethers.getContractFactory("MockGovernor");
        mockGovernor = await MockGovernor.deploy();

        // Link contracts
        await economy.connect(deployer).setImplementations(await nativeProjectImpl.getAddress(), await erc20ProjectImpl.getAddress());
        await economy.connect(deployer).setDaoAddresses(timelock.address, registry.address, await mockGovernor.getAddress(), await mockRepToken.getAddress());

        // Set DAO parameters
        await economy.connect(timelock).setProjectThreshold(PROJECT_THRESHOLD);

        // Mint reputation to the author so they can create projects
        await mockRepToken.mint(author.address, PROJECT_THRESHOLD);

        // Distribute tokens
        await testToken.connect(deployer).transfer(author.address, ethers.parseEther("10000"));
        await testToken.connect(deployer).transfer(contractor.address, ethers.parseEther("10000"));
        await testToken.connect(deployer).transfer(user1.address, ethers.parseEther("10000"));
    });

    describe("Full Appeal Lifecycle", function() {
        let project, fundingAmount, arbitrationFee;

        beforeEach(async function() {
            const result = await setupDisputedProject();
            project = result.project;
            fundingAmount = result.fundingAmount;
            arbitrationFee = result.arbitrationFee;
        });

        it("should allow a valid DAO member to appeal and the DAO to overrule", async function() {
            // 1. Arbiter rules, moving to Appealable
            await project.connect(arbiter).arbitrate(60, "arbiter_ruling");
            expect(await project.stage()).to.equal(4); // Appealable

            // 2. Setup mocks for a valid appeal
            await mockRepToken.mint(daoMember.address, PROJECT_THRESHOLD);
            await mockGovernor.setProposalState(1); // Active state

            // 3. DAO Member successfully appeals
            await project.connect(daoMember).appeal(123, [await project.getAddress()]);
            expect(await project.stage()).to.equal(5); // Appeal

            // 4. DAO Timelock overrules the arbiter
            const daoRuling = 25; // DAO is less generous
            await project.connect(timelock).daoOverrule(daoRuling, "dao_ruling");
            expect(await project.stage()).to.equal(6); // Closed

            // 5. Verify final state
            expect(await project.disputeResolution()).to.equal(daoRuling);
            expect(await project.ruling_hash()).to.equal("dao_ruling");

            // 6. Verify arbiter was still paid because they ruled
            const arbiterNet = arbitrationFee - (arbitrationFee * (await economy.platformFeeBps())) / 10000n;
            expect(await testToken.balanceOf(arbiter.address)).to.equal(arbiterNet);
        });

        it("should finalize the arbiter's ruling if the appeal initiation period expires", async function() {
            await project.connect(arbiter).arbitrate(70, "original_ruling");
            expect(await project.stage()).to.equal(4); // Appealable

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);

            // Attempt to appeal should fail
            await mockRepToken.mint(daoMember.address, PROJECT_THRESHOLD);
            await mockGovernor.setProposalState(1);
            await expect(project.connect(daoMember).appeal(123, [await project.getAddress()]))
                .to.be.revertedWith("Appeal initiation period has ended");

            // Anyone can now finalize
            await project.connect(user1).finalizeArbitration();
            expect(await project.stage()).to.equal(6); // Closed
            expect(await project.disputeResolution()).to.equal(70);
        });

        it("should finalize the arbiter's ruling if the DAO fails to act after an appeal", async function() {
            await project.connect(arbiter).arbitrate(80, "original_ruling");
            await mockRepToken.mint(daoMember.address, PROJECT_THRESHOLD);
            await mockGovernor.setProposalState(1);
            await project.connect(daoMember).appeal(123, [await project.getAddress()]);
            expect(await project.stage()).to.equal(5); // Appeal

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);

            // DAO tries to overrule too late
            await expect(project.connect(timelock).daoOverrule(10, "too_late"))
                .to.be.revertedWith("Appeal period has ended");

            // Finalize with original ruling
            await project.connect(user1).finalizeArbitration();
            expect(await project.stage()).to.equal(6); // Closed
            expect(await project.disputeResolution()).to.equal(80);
        });

        it("should prevent appeals from members with insufficient voting power", async function() {
            await project.connect(arbiter).arbitrate(50, "ruling");

            // Mint just under the required threshold
            await mockRepToken.mint(daoMember.address, PROJECT_THRESHOLD - 1n);
            await mockGovernor.setProposalState(1);

            await expect(project.connect(daoMember).appeal(123, [await project.getAddress()]))
                .to.be.revertedWith("Insufficient voting power to appeal");
        });
    });

    // Test suite for the inactive arbiter scenario
    describe("Arbiter Inactivity & Escalation", function() {
        let project, fundingAmount, arbitrationFee;

        beforeEach(async function() {
            const result = await setupDisputedProject();
            project = result.project;
            fundingAmount = result.fundingAmount;
            arbitrationFee = result.arbitrationFee;
        });

        it("should allow the DAO to escalate a dispute if the arbiter is inactive", async function() {
            // 1. Verify we are in the Dispute stage
            expect(await project.stage()).to.equal(3); // Dispute

            // 2. Fast-forward time past the arbiter's exclusive ruling window
            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);

            // 3. Setup mocks for a valid appeal
            await mockRepToken.mint(daoMember.address, PROJECT_THRESHOLD);
            await mockGovernor.setProposalState(1);

            // 4. DAO member successfully appeals from the Dispute stage
            await project.connect(daoMember).appeal(456, [await project.getAddress()]);
            expect(await project.stage()).to.equal(5); // Appeal

            // 5. DAO overrules and closes the project
            await project.connect(timelock).daoOverrule(10, "dao_intervention");
            expect(await project.stage()).to.equal(6); // Closed

            // 6. Verify the consequences of arbiter inactivity
            // Arbiter should NOT be paid
            expect(await testToken.balanceOf(arbiter.address)).to.equal(0);

            // The forfeited fee should be in the DAO treasury (Registry)
            const registryBalance = await testToken.balanceOf(registry.address);
            // Registry balance contains the forfeited arbitration fee
            expect(registryBalance).to.equal(arbitrationFee);

            // Contractor should NOT be able to reclaim their stake (it was used for the fee)
            await expect(project.connect(contractor).reclaimArbitrationStake())
                .to.be.revertedWith("Stake was used to pay the arbiter.");
        });

        it("should prevent the DAO from escalating a dispute within the arbiter's exclusive window", async function() {
            // 1. Verify we are in the Dispute stage
            expect(await project.stage()).to.equal(3);

            // 2. DO NOT fast-forward time. The arbiter is still within their window.
            await mockRepToken.mint(daoMember.address, PROJECT_THRESHOLD);
            await mockGovernor.setProposalState(1);

            // 3. Attempting to appeal now must fail
            await expect(project.connect(daoMember).appeal(789, [await project.getAddress()]))
                .to.be.revertedWith("Appeal not allowed at this time");
        });
    });

    describe("Fund Handling Mechanisms", function() {
        it("should correctly handle direct ETH transfers via receive() in NativeProject", async function() {
            const tx = await economy.connect(author).createProject(
                "Native Receive Test", ethers.ZeroAddress, ethers.ZeroAddress, "t", "r", "d"
            );
            const receipt = await tx.wait();
            const projectAddress = receipt.logs.find(log => log.eventName === 'NewProject').args.contractAddress;
            const project = await ethers.getContractAt("NativeProject", projectAddress);

            const fundingAmount = ethers.parseEther("2.5");
            const userBalanceBefore = await ethers.provider.getBalance(user1.address);

            const sendTx = await user1.sendTransaction({
                to: projectAddress,
                value: fundingAmount
            });
            await sendTx.wait();

            const sendReceipt = await ethers.provider.getTransactionReceipt(sendTx.hash);
            const gasUsed = sendReceipt.gasUsed * sendTx.gasPrice;

            expect(await project.projectValue()).to.equal(fundingAmount);
            const contribution = await project.contributions(user1.address);
            expect(contribution.total).to.equal(fundingAmount);
            expect(await ethers.provider.getBalance(user1.address)).to.equal(userBalanceBefore - fundingAmount - gasUsed);
        });

        it("should allow the DAO to sweep orphaned ERC20 tokens", async function() {
            const { project, fundingAmount, arbitrationFee } = await setupDisputedProject();
            const projectAddress = await project.getAddress();
            const orphanedAmount = ethers.parseEther("123");

            // User accidentally sends tokens directly
            await testToken.connect(user1).transfer(projectAddress, orphanedAmount);

            const projectValue = await project.projectValue();
            const totalBalance = await testToken.balanceOf(projectAddress);
            // Only contractor's half of the arbitration fee is staked
            const contractorStake = arbitrationFee / 2n;

            expect(totalBalance).to.be.gt(projectValue);
            expect(totalBalance).to.equal(projectValue + contractorStake + orphanedAmount);

            // A non-timelock account cannot sweep
            await expect(project.connect(author).sweepOrphanedTokens(await testToken.getAddress()))
                .to.be.revertedWith("Only the DAO Timelock can sweep tokens.");

            // Timelock sweeps the tokens to the DAO treasury (Registry)
            const registryBalanceBefore = await testToken.balanceOf(registry.address);
            await project.connect(timelock).sweepOrphanedTokens(await testToken.getAddress());
            const registryBalanceAfter = await testToken.balanceOf(registry.address);

            // Verify balances and state
            expect(registryBalanceAfter).to.equal(registryBalanceBefore + orphanedAmount);
            expect(await testToken.balanceOf(projectAddress)).to.equal(projectValue + contractorStake);
            expect(await project.projectValue()).to.equal(projectValue); // Unchanged
        });
    });
});
// appeals.test.js
