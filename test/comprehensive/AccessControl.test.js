const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { passCoolingOff } = require("../helpers/coolingOff");

/**
 * Comprehensive Access Control Tests
 *
 * Tests all permission scenarios:
 * - Function access restrictions
 * - Stage restrictions
 * - Role-based access
 */
describe("Comprehensive Access Control Tests", function () {
    let economy, nativeProjectImpl, erc20ProjectImpl, testToken, mockRepToken, mockGovernor;
    let deployer, timelock, registry, author, contractor, arbiter, backer1, backer2, randomUser;

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

    async function createOpenProject() {
        // Create project without parties set
        const tx = await economy.connect(author).createERC20Project(
            "Test Project", ethers.ZeroAddress, ethers.ZeroAddress, "terms", "repo", "desc",
            await testToken.getAddress()
        );
        const receipt = await tx.wait();
        const projectAddress = receipt.logs.find(log => log.eventName === 'NewProject').args.contractAddress;
        return ethers.getContractAt("ERC20Project", projectAddress);
    }

    beforeEach(async function () {
        [deployer, timelock, registry, author, contractor, arbiter, backer1, backer2, randomUser] = await ethers.getSigners();

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
        await testToken.connect(deployer).transfer(contractor.address, ethers.parseEther("100000"));
    });

    describe("setParties Access Control", function() {

        it("should allow only author to set parties", async function() {
            const project = await createOpenProject();

            await expect(
                project.connect(randomUser).setParties(contractor.address, arbiter.address, "terms")
            ).to.be.revertedWith("Only the Project's Author can set the other parties.");

            // Author can set
            await project.connect(author).setParties(contractor.address, arbiter.address, "terms");
            expect(await project.contractor()).to.equal(contractor.address);
        });

        it("should only allow setParties in Open stage", async function() {
            const project = await createERC20Project(); // Already in Pending stage

            await expect(
                project.connect(author).setParties(contractor.address, arbiter.address, "terms")
            ).to.be.revertedWith("Parties can only be set in 'open' stage.");
        });
    });

    describe("signContract Access Control", function() {

        it("should allow only contractor to sign", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);

            await passCoolingOff(project);
            await expect(
                project.connect(randomUser).signContract()
            ).to.be.revertedWith("Only the designated contractor can sign the contract");

            // Contractor can sign
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();
        });

        it("should only allow signing in Pending stage", async function() {
            // Create project with valid contractor, sign it, then try to sign again
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);

            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            // Project is now Ongoing - trying to sign again should fail
            await passCoolingOff(project);
            await expect(
                project.connect(contractor).signContract()
            ).to.be.revertedWith("The project can only be signed while in `pending` stage.");
        });

        it("should enforce cooling off period when parties set after creation", async function() {
            // Projects created with parties already set don't have cooling off period
            // Cooling off only applies when setParties is called after creation
            const project = await createOpenProject();
            const amount = ethers.parseEther("1000");

            // Add funds while open
            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            // Set parties - this triggers cooling off period
            await project.connect(author).setParties(contractor.address, arbiter.address, "terms");

            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            // Try to sign immediately (within cooling off) - should fail
            await expect(
                project.connect(contractor).signContract()
            ).to.be.revertedWith("Contract signing is blocked during the cooling-off period.");

            // Wait for cooling off period
            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);

            // Now should succeed
            await passCoolingOff(project);
            await project.connect(contractor).signContract();
            expect(await project.stage()).to.equal(2); // Ongoing
        });
    });

    describe("Voting Access Control", function() {

        it("should only allow contributors with locked funds to vote", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            await expect(
                project.connect(randomUser).voteToDispute()
            ).to.be.revertedWith("Only contributors with locked funds can vote");

            await expect(
                project.connect(randomUser).voteToReleasePayment()
            ).to.be.revertedWith("Only contributors with locked funds can vote");
        });

        it("should only allow voting in Ongoing stage", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            // Try voting in Pending stage
            await expect(
                project.connect(backer1).voteToDispute()
            ).to.be.revertedWith("Project must be ongoing to vote");
        });
    });

    describe("disputeAsContractor Access Control", function() {

        it("should only allow contractor to dispute as contractor", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            await expect(
                project.connect(randomUser).disputeAsContractor()
            ).to.be.revertedWith("Only the designated Contractor can call this function");

            // Contractor can dispute
            await project.connect(contractor).disputeAsContractor();
            expect(await project.stage()).to.equal(3); // Dispute
        });

        it("should only allow disputeAsContractor in Ongoing stage", async function() {
            const project = await createERC20Project();

            await expect(
                project.connect(contractor).disputeAsContractor()
            ).to.be.revertedWith("This can only be called while the project is ongoing");
        });
    });

    describe("reimburse Access Control", function() {

        it("should only allow contractor to reimburse", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            await expect(
                project.connect(randomUser).reimburse()
            ).to.be.revertedWith("Only the contractor can call this function.");

            // Contractor can reimburse
            await project.connect(contractor).reimburse();
            expect(await project.stage()).to.equal(6); // Closed
        });
    });

    describe("arbitrate Access Control", function() {

        it("should only allow arbiter to arbitrate", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            await project.connect(contractor).disputeAsContractor();

            await expect(
                project.connect(randomUser).arbitrate(50, "ruling")
            ).to.be.revertedWith("Only the Arbiter can call this function");

            // Arbiter can arbitrate
            await project.connect(arbiter).arbitrate(50, "ruling");
        });

        it("should only allow arbitration in Dispute stage", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            // In Ongoing stage, not Dispute
            await expect(
                project.connect(arbiter).arbitrate(50, "ruling")
            ).to.be.revertedWith("Arbitration can only occur if the project is in dispute.");
        });

        it("should reject invalid ruling percentages", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            await project.connect(contractor).disputeAsContractor();

            await expect(
                project.connect(arbiter).arbitrate(101, "ruling")
            ).to.be.revertedWith("Resolution needs to be a number between 0 and 100");
        });
    });

    describe("withdrawAsContractor Access Control", function() {

        it("should only allow contractor to withdraw as contractor", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
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

            await expect(
                project.connect(randomUser).withdrawAsContractor()
            ).to.be.revertedWith("Only the contractor can withdraw.");
        });

        it("should only allow withdrawal in Closed stage", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            await expect(
                project.connect(contractor).withdrawAsContractor()
            ).to.be.revertedWith("The contractor can only withdraw once the project is closed.");
        });
    });

    describe("Stage Transitions", function() {

        it("should follow correct stage transitions: Open -> Pending -> Ongoing -> Closed", async function() {
            const project = await createOpenProject();

            expect(await project.stage()).to.equal(0); // Open

            await project.connect(author).setParties(contractor.address, arbiter.address, "terms");
            expect(await project.stage()).to.equal(1); // Pending

            const amount = ethers.parseEther("1000");
            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();
            expect(await project.stage()).to.equal(2); // Ongoing

            await project.connect(contractor).reimburse();
            expect(await project.stage()).to.equal(6); // Closed
        });

        it("should follow correct stage transitions: Ongoing -> Dispute -> Appealable -> Closed", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();
            expect(await project.stage()).to.equal(2); // Ongoing

            await project.connect(contractor).disputeAsContractor();
            expect(await project.stage()).to.equal(3); // Dispute

            await project.connect(arbiter).arbitrate(50, "ruling");
            expect(await project.stage()).to.equal(4); // Appealable

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();
            expect(await project.stage()).to.equal(6); // Closed
        });
    });

    describe("Contribution Stage Restrictions", function() {

        it("should allow contributions in Open stage", async function() {
            const project = await createOpenProject();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            expect(await project.projectValue()).to.equal(amount);
        });

        it("should allow contributions in Pending stage", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            expect(await project.projectValue()).to.equal(amount);
        });

        it("should NOT allow contributions in Ongoing stage", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            const arbitrationFee = (amount * BigInt(ARBITRATION_FEE_BPS)) / 10000n;
            const contractorStake = arbitrationFee / 2n;
            await testToken.connect(contractor).approve(await project.getAddress(), contractorStake);

            const coolingOff = await economy.coolingOffPeriod();
            await time.increase(coolingOff + 1n);
            await passCoolingOff(project);
            await project.connect(contractor).signContract();

            await testToken.connect(backer2).approve(await project.getAddress(), amount);
            await expect(
                project.connect(backer2).sendFunds(amount)
            ).to.be.revertedWith("Funding is only allowed when the project is in 'open' or 'pending' stage.");
        });
    });
});
