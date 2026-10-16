const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { passCoolingOff } = require("./helpers/coolingOff");

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
        await passCoolingOff(project);
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
        await economy.setMinCoolingOffPeriod(0); // instant signing in this fixture
        await economy.setCoolingOffPeriod(0);
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

        it("lets the DAO overrule an open ruling directly, with no on-chain appeal step", async function() {
            // 1. Arbiter rules, moving to Appealable
            await project.connect(arbiter).arbitrate(60, "arbiter_ruling");
            expect(await project.stage()).to.equal(4); // Appealable

            // 2. The DAO's overrule proposal executes and calls the project
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

        it("finalizes the arbiter's ruling once the appeal window closes, and blocks a late overrule", async function() {
            await project.connect(arbiter).arbitrate(70, "original_ruling");
            expect(await project.stage()).to.equal(4); // Appealable

            await expect(project.connect(user1).finalizeArbitration())
                .to.be.revertedWith("Appeal/Finalization period has not ended yet");
            await time.increaseTo((await project.appealEnds()) + 1n);

            await expect(project.connect(timelock).daoOverrule(10, "too_late"))
                .to.be.revertedWith("DAO can only overrule an open ruling or a silent arbiter");

            // Anyone can now finalize
            await project.connect(user1).finalizeArbitration();
            expect(await project.stage()).to.equal(6); // Closed
            expect(await project.disputeResolution()).to.equal(70);
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

        it("lets the DAO overrule a silent arbiter after the appeal period", async function() {
            // 1. Verify we are in the Dispute stage
            expect(await project.stage()).to.equal(3); // Dispute

            // 2. Fast-forward time past the arbiter's exclusive ruling window
            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);

            // 3. DAO overrules and closes the project
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
            await expect(project.connect(timelock).daoOverrule(10, "too_early"))
                .to.be.revertedWith("DAO can only overrule an open ruling or a silent arbiter");
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

        it("still sweeps orphaned tokens after payouts have left the project", async function() {
            const tx = await economy.connect(author).createERC20Project(
                "Sweep after payout", contractor.address, arbiter.address, "t", "r", "d",
                await testToken.getAddress()
            );
            const receipt = await tx.wait();
            const projectAddress = receipt.logs.find(log => log.eventName === 'NewProject').args.contractAddress;
            const project = await ethers.getContractAt("ERC20Project", projectAddress);

            // 20% immediate, released to the contractor at signing
            const fundingAmount = ethers.parseEther("1000");
            await testToken.connect(user1).approve(projectAddress, fundingAmount);
            await project.connect(user1).sendFundsWithImmediate(fundingAmount, 2000);
            await testToken.connect(contractor).approve(projectAddress, fundingAmount);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            const owed = await project.escrowed();
            expect(await testToken.balanceOf(projectAddress)).to.equal(owed);

            const orphanedAmount = ethers.parseEther("7");
            await testToken.connect(user1).transfer(projectAddress, orphanedAmount);
            const registryBefore = await testToken.balanceOf(registry.address);
            await project.connect(timelock).sweepOrphanedTokens(await testToken.getAddress());
            expect(await testToken.balanceOf(registry.address)).to.equal(registryBefore + orphanedAmount);
            expect(await testToken.balanceOf(projectAddress)).to.equal(owed);

            // Everything owed can still be paid out
            await project.connect(user1).voteToReleasePayment();
            await project.connect(contractor).withdrawAsContractor();
            await project.connect(contractor).reclaimArbitrationStake();
            expect(await project.escrowed()).to.equal(0);
            expect(await testToken.balanceOf(projectAddress)).to.equal(0);
        });

        it("refunds a contractor who sends more than the stake when signing", async function() {
            const tx = await economy.connect(author).createProject(
                "Overpay", contractor.address, arbiter.address, "t", "r", "d"
            );
            const receipt = await tx.wait();
            const projectAddress = receipt.logs.find(log => log.eventName === 'NewProject').args.contractAddress;
            const project = await ethers.getContractAt("NativeProject", projectAddress);

            const fundingAmount = ethers.parseEther("2");
            await project.connect(user1).sendFunds({ value: fundingAmount });
            await passCoolingOff(project);

            const stake = (fundingAmount * BigInt(ARBITRATION_FEE_BPS)) / 10000n / 2n;
            const overpay = ethers.parseEther("1");
            await expect(project.connect(contractor).signContract({ value: stake + overpay }))
                .to.changeEtherBalances([contractor, project], [-stake, stake]);
        });
    });
});
// appeals.test.js
