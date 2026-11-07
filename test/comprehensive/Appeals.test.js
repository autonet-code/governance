const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { passCoolingOff } = require("../helpers/coolingOff");

/**
 * Comprehensive Appeals Tests
 *
 * Tests all appeal scenarios:
 * - Appeal process (filing, timing)
 * - DAO overrule
 * - Appeal timeout / finalization
 * - DAO veto
 */
describe("Comprehensive Appeals Tests", function () {
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
        await mockRepToken.mint(backer1.address, PROJECT_THRESHOLD);

        await testToken.connect(deployer).transfer(backer1.address, ethers.parseEther("100000"));
        await testToken.connect(deployer).transfer(backer2.address, ethers.parseEther("100000"));
        await testToken.connect(deployer).transfer(contractor.address, ethers.parseEther("100000"));
    });

    describe("Appeal Finalization (No DAO Action)", function() {

        it("should finalize with original ruling after appeal period expires", async function() {
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

            // Dispute and arbitrate
            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(30, "ruling_hash");

            expect(await project.stage()).to.equal(4); // Appealable
            expect(await project.originalDisputeResolution()).to.equal(30);

            // Wait for the appeal window (floored at a proposal lifecycle) and finalize
            await time.increaseTo((await project.appealEnds()) + 1n);
            await project.finalizeArbitration();

            expect(await project.stage()).to.equal(6); // Closed
            expect(await project.disputeResolution()).to.equal(30);

            // Withdraw all
            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();

            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should NOT allow finalization before appeal period ends", async function() {
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
            await project.connect(arbiter).arbitrate(30, "ruling_hash");

            await expect(
                project.finalizeArbitration()
            ).to.be.revertedWith("Appeal/Finalization period has not ended yet");
        });
    });

    describe("DAO Overrule", function() {

        it("should allow DAO to overrule with different percentage", async function() {
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

            // Arbitrate with 30%
            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(30, "ruling_hash");

            // DAO overrule proposal executes while the ruling is open: 70%
            await project.connect(timelock).daoOverrule(70, "new_ruling");

            expect(await project.stage()).to.equal(6); // Closed
            expect(await project.disputeResolution()).to.equal(70);

            // Withdraw all
            await project.connect(contractor).withdrawAsContractor();
            await project.connect(backer1).withdrawAsContributor();

            expect(await testToken.balanceOf(await project.getAddress())).to.equal(0);
        });

        it("should NOT allow non-timelock to overrule", async function() {
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
            await project.connect(arbiter).arbitrate(30, "ruling_hash");

            // Try to overrule as non-timelock
            await expect(
                project.connect(backer1).daoOverrule(70, "new_ruling")
            ).to.be.revertedWith("Only the DAO Timelock can overrule");
        });

        it("should NOT allow overrule after the appeal window closes", async function() {
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
            await project.connect(arbiter).arbitrate(30, "ruling_hash");

            await time.increaseTo((await project.appealEnds()) + 1n);
            await expect(
                project.connect(timelock).daoOverrule(70, "new_ruling")
            ).to.be.revertedWith("DAO can only overrule an open ruling or a silent arbiter");
        });
    });

    describe("DAO Veto", function() {

        it("should allow DAO to veto and return all funds to backers", async function() {
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

            // Veto before dispute
            await project.connect(timelock).daoVeto();

            expect(await project.stage()).to.equal(6); // Closed
            expect(await project.disputeResolution()).to.equal(0); // 0% to contractor = 100% to backers

            // Backer gets full locked amount back
            const balanceBefore = await testToken.balanceOf(backer1.address);
            await project.connect(backer1).withdrawAsContributor();
            const balanceAfter = await testToken.balanceOf(backer1.address);

            // Should get full locked amount (immediate was already released)
            const immediate = (amount * 0n) / 10000n; // 0% immediate
            const locked = amount - immediate;
            // less the platform fee, which goes to the treasury
            const fee = locked * (await economy.platformFeeBps()) / 10000n;
            expect(balanceAfter - balanceBefore).to.equal(locked - fee);
        });

        it("should NOT allow veto of already closed project", async function() {
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

            // Close via reimburse
            await project.connect(contractor).reimburse();

            await expect(
                project.connect(timelock).daoVeto()
            ).to.be.revertedWith("Cannot veto a closed project.");
        });

        it("should NOT allow non-timelock to veto", async function() {
            const project = await createERC20Project();
            const amount = ethers.parseEther("1000");

            await testToken.connect(backer1).approve(await project.getAddress(), amount);
            await project.connect(backer1).sendFunds(amount);

            await expect(
                project.connect(backer1).daoVeto()
            ).to.be.revertedWith("Only the DAO Timelock can veto a project.");
        });

        it("should allow veto during dispute", async function() {
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

            // Veto during dispute
            await project.connect(timelock).daoVeto();

            expect(await project.stage()).to.equal(6); // Closed
            expect(await project.disputeResolution()).to.equal(0);
        });
    });

    describe("Contractor Stake Reclaim", function() {

        it("should allow contractor to reclaim stake if no arbitration", async function() {
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

            // Close via reimburse (no arbitration)
            await project.connect(contractor).reimburse();

            const balanceBefore = await testToken.balanceOf(contractor.address);
            await project.connect(contractor).reclaimArbitrationStake();
            const balanceAfter = await testToken.balanceOf(contractor.address);

            expect(balanceAfter - balanceBefore).to.equal(contractorStake);
        });

        it("should NOT allow stake reclaim if arbitration occurred", async function() {
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

            // Dispute and arbitrate
            await project.connect(contractor).disputeAsContractor();
            await project.connect(arbiter).arbitrate(50, "ruling_hash");

            const appealPeriod = await economy.appealPeriod();
            await time.increase(appealPeriod + 1n);
            await project.finalizeArbitration();

            await expect(
                project.connect(contractor).reclaimArbitrationStake()
            ).to.be.revertedWith("Stake was used to pay the arbiter.");
        });

        it("should NOT allow double reclaim of stake", async function() {
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

            await project.connect(contractor).reimburse();
            await project.connect(contractor).reclaimArbitrationStake();

            await expect(
                project.connect(contractor).reclaimArbitrationStake()
            ).to.be.revertedWith("You have already reclaimed your stake.");
        });
    });
});
