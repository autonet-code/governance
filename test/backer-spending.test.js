const { expect } = require("chai");
const { ethers } = require("hardhat");
const { passCoolingOff } = require("./helpers/coolingOff");

// Backers' spending is read from closed projects, so REP accrues without a withdrawal.
describe("Backer spending", function () {
    const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    let deployer, timelock, author, backer, contractor, arbiter;
    let economy, registry, repToken, claim;

    async function createProject() {
        const receipt = await (await economy.connect(author).createProject(
            "p", contractor.address, arbiter.address, "t", "r", "d")).wait();
        const addr = receipt.logs.find(l => l.eventName === "NewProject").args.contractAddress;
        return ethers.getContractAt("NativeProject", addr);
    }

    async function spentNative(user) {
        const profile = await economy.getUser(user);
        const i = profile.spentTokens.findIndex(t => t.toLowerCase() === NATIVE.toLowerCase());
        return i < 0 ? 0n : profile.spentAmounts[i];
    }

    beforeEach(async function () {
        [deployer, timelock, author, backer, contractor, arbiter] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("Registry")).deploy(timelock.address, deployer.address);
        const nativeImpl = await (await ethers.getContractFactory("NativeProject")).deploy();
        const erc20Impl = await (await ethers.getContractFactory("ERC20Project")).deploy();
        economy = await (await ethers.getContractFactory("Economy")).deploy(500);
        await economy.setImplementations(await nativeImpl.getAddress(), await erc20Impl.getAddress());
        repToken = await (await ethers.getContractFactory("RepToken")).deploy(
            "Jurisdiction", "JUR", await registry.getAddress(), timelock.address, [], [], false);
        await repToken.setAdmin(timelock.address);
        claim = await (await ethers.getContractFactory("EconomyRepClaim")).deploy(
            await economy.getAddress(), await repToken.getAddress(), await registry.getAddress());
        await repToken.connect(timelock).setMinter(await claim.getAddress(), true);
        await economy.setMinCoolingOffPeriod(0); // instant signing in this fixture
        await economy.setCoolingOffPeriod(0);
        await economy.setDaoAddresses(timelock.address, await registry.getAddress(), deployer.address, await repToken.getAddress());
        await registry.connect(timelock).editRegistry(`jurisdiction.parity.${NATIVE.toLowerCase()}`, ethers.parseEther("1").toString());
    });

    it("credits spending once the project closes, without the backer withdrawing", async function () {
        const project = await createProject();
        const amount = ethers.parseEther("10");
        await project.connect(backer).sendFundsWithImmediate(2000, { value: amount });
        expect(await spentNative(backer.address)).to.equal(0n);

        await passCoolingOff(project);
        await project.connect(contractor).signContract({ value: ethers.parseEther("0.2") });
        expect(await spentNative(backer.address)).to.equal(0n); // not closed yet

        await project.connect(backer).voteToReleasePayment();
        expect(await spentNative(backer.address)).to.equal(amount);

        await claim.connect(backer).claim();
        expect(await repToken.balanceOf(backer.address)).to.equal(amount);
    });

    it("does not double count when the backer also withdraws", async function () {
        const project = await createProject();
        await project.connect(backer).sendFunds({ value: ethers.parseEther("10") });
        await passCoolingOff(project);
        await project.connect(contractor).signContract({ value: ethers.parseEther("0.25") });
        await project.connect(contractor).reimburse(); // full refund: nothing spent

        expect(await spentNative(backer.address)).to.equal(0n);
        await project.connect(backer).withdrawAsContributor();
        expect(await spentNative(backer.address)).to.equal(0n);
        await expect(project.connect(backer).withdrawAsContributor()).to.be.revertedWith("Already withdrawn.");
    });

    it("counts only the immediate portion when the contractor reimburses", async function () {
        const project = await createProject();
        await project.connect(backer).sendFundsWithImmediate(2000, { value: ethers.parseEther("10") });
        await passCoolingOff(project);
        await project.connect(contractor).signContract({ value: ethers.parseEther("0.2") });
        await project.connect(contractor).reimburse();

        expect(await spentNative(backer.address)).to.equal(ethers.parseEther("2"));
        const before = await ethers.provider.getBalance(backer.address);
        const tx = await project.connect(backer).withdrawAsContributor();
        const r = await tx.wait();
        const after = await ethers.provider.getBalance(backer.address);
        expect(after - before + r.gasUsed * r.gasPrice).to.equal(ethers.parseEther("8"));
        expect(await spentNative(backer.address)).to.equal(ethers.parseEther("2"));
    });

    it("refunds the immediate portion when the DAO vetoes before signing", async function () {
        const project = await createProject();
        const amount = ethers.parseEther("10");
        await project.connect(backer).sendFundsWithImmediate(2000, { value: amount });
        await project.connect(timelock).daoVeto();

        expect(await spentNative(backer.address)).to.equal(0n);
        const before = await ethers.provider.getBalance(backer.address);
        const r = await (await project.connect(backer).withdrawAsContributor()).wait();
        const after = await ethers.provider.getBalance(backer.address);
        expect(after - before + r.gasUsed * r.gasPrice).to.equal(amount);
        expect(await ethers.provider.getBalance(await project.getAddress())).to.equal(0n);
    });

    it("lists each backed project once even if the backer re-funds after withdrawing", async function () {
        const project = await createProject();
        await project.connect(backer).sendFunds({ value: ethers.parseEther("1") });
        await project.connect(backer).withdrawAsContributor();
        await project.connect(backer).sendFunds({ value: ethers.parseEther("1") });
        expect(await economy.projectsAsBacker(backer.address, 0)).to.equal(await project.getAddress());
        await expect(economy.projectsAsBacker(backer.address, 1)).to.be.reverted;
    });
});
// backer-spending.test.js
