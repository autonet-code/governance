const { expect } = require("chai");
const { ethers } = require("hardhat");
const { suite, coreParams, prepare, createJurisdiction, REP } = require("./helpers/jurisdiction");

describe("JurisdictionFactory", function () {
    let deployer, m1, m2, outsider;
    let s;

    before(async function () {
        [deployer, m1, m2, outsider] = await ethers.getSigners();
        s = await suite();
    });

    async function expectHandedOver(core) {
        const timelock = await ethers.getContractAt("TimelockController", core.timelock);
        expect(await (await ethers.getContractAt("Registry", core.registry)).owner()).to.equal(core.timelock);
        expect(await (await ethers.getContractAt("Registry", core.registry)).jurisdictionAddress()).to.equal(core.token);
        expect(await (await ethers.getContractAt("RepToken", core.token)).admin()).to.equal(core.timelock);
        expect(await (await ethers.getContractAt("HomebaseDAO", core.governor)).timelock()).to.equal(core.timelock);
        expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), core.governor)).to.equal(true);
        expect(await timelock.hasRole(await timelock.CANCELLER_ROLE(), core.governor)).to.equal(true);
        expect(await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), await s.jurisdictionFactory.getAddress())).to.equal(false);
    }

    it("creates a DAO with no modules in one transaction", async function () {
        const p = coreParams({ members: [m1.address, m2.address], amounts: [REP(100), REP(50)], executionDelay: 60 });
        const core = await s.jurisdictionFactory.deploy.staticCall(p, ["jurisdiction.name"], ["Test"]);
        await expect(s.jurisdictionFactory.deploy(p, ["jurisdiction.name"], ["Test"]))
            .to.emit(s.jurisdictionFactory, "NewDaoCreated");
        await expectHandedOver(core);
        const registry = await ethers.getContractAt("Registry", core.registry);
        expect(await registry.getRegistryValue("jurisdiction.name")).to.equal("Test");
        expect(await (await ethers.getContractAt("RepToken", core.token)).balanceOf(m1.address)).to.equal(REP(100));
    });

    it("creates an Economy DAO: the core plus the economy module", async function () {
        const j = await createJurisdiction(m1, { members: [m1.address], amounts: [REP(10)], modules: ["economy"] });
        await expectHandedOver(j.core);
        expect(await j.economy.timelockAddress()).to.equal(j.core.timelock);
        expect(await j.economy.repTokenAddress()).to.equal(j.core.token);
        expect(await j.economy.appealPeriod()).to.equal(120n);
        expect(await j.rep.minters(await j.economyClaim.getAddress())).to.equal(true);
        expect(await j.registry.getRegistryValue("jurisdiction.economy")).to.equal((await j.economy.getAddress()).toLowerCase());
        expect(await j.registry.getRegistryValue("modules.economy"))
            .to.equal(`${(await s.setups.economy.getAddress()).toLowerCase()}:${j.installs.economy.id}`);
    });

    it("creates a transferable DAO and a wrapped-token DAO", async function () {
        const t = await createJurisdiction(m1, { tokenKind: 1, members: [m1.address], amounts: [REP(10)] });
        expect(await t.rep.isTransferable()).to.equal(true);
        const erc20 = await (await ethers.getContractFactory("TestERC20")).deploy("Gov", "GOV", 18, 0);
        const w = await createJurisdiction(m1, { tokenKind: 2, underlying: await erc20.getAddress() });
        expect(await w.rep.underlying()).to.equal(await erc20.getAddress());
        expect(await w.rep.admin()).to.equal(w.core.timelock);
    });

    it("only the originator finalizes a pending core, once", async function () {
        const f = s.jurisdictionFactory;
        const core = await f.connect(m1).deployCore.staticCall(coreParams());
        await f.connect(m1).deployCore(coreParams());
        const c = { registry: core.registry, timelock: core.timelock, token: core.token, governor: core.governor };
        await expect(f.connect(outsider).finalize(c, [], [], [])).to.be.revertedWithCustomError(f, "NotOriginator");
        await expect(f.connect(m1).finalize({ ...c, governor: outsider.address }, [], [], []))
            .to.be.revertedWithCustomError(f, "WrongCore");
        await f.connect(m1).finalize(c, [], [], []);
        await expect(f.connect(m1).finalize(c, [], [], [])).to.be.revertedWithCustomError(f, "NotPending");
    });

    it("attaches modules in order and refuses one whose dependency isn't attached first", async function () {
        const f = s.jurisdictionFactory.connect(m1);
        const core = await f.deployCore.staticCall(coreParams());
        await f.deployCore(coreParams());
        const c = { registry: core.registry, timelock: core.timelock, token: core.token, governor: core.governor };
        const economy = await prepare(s, m1, c, "economy");
        const court = await prepare(s, m1, c, "content_court", {}, { economy });
        const ref = async (x) => ({ setup: await x.setup.getAddress(), id: x.id });
        await expect(f.finalize(c, [await ref(court), await ref(economy)], [], []))
            .to.be.revertedWithCustomError(s.processor, "MissingDependency").withArgs("economy");
        await f.finalize(c, [await ref(economy), await ref(court)], [], []);
        const rep = await ethers.getContractAt("RepToken", c.token);
        expect(await rep.slashers(court.module)).to.equal(true);
    });

    it("refuses an installation prepared for another core, or from an unpublished setup", async function () {
        const f = s.jurisdictionFactory.connect(m1);
        const a = await f.deployCore.staticCall(coreParams());
        await f.deployCore(coreParams());
        const b = await f.deployCore.staticCall(coreParams());
        await f.deployCore(coreParams());
        const ca = { registry: a.registry, timelock: a.timelock, token: a.token, governor: a.governor };
        const cb = { registry: b.registry, timelock: b.timelock, token: b.token, governor: b.governor };
        const econB = await prepare(s, m1, cb, "economy");
        await expect(f.finalize(ca, [{ setup: await econB.setup.getAddress(), id: econB.id }], [], []))
            .to.be.revertedWithCustomError(s.processor, "WrongCore");

        const rogue = await (await ethers.getContractFactory("EconomySetup")).deploy(
            await s.nativeProject.getAddress(), await s.erc20Project.getAddress());
        await rogue.connect(m1).prepareInstallation(ca, require("../scripts/lib/modules").encodeInstallData(
            ethers, "economy", require("./helpers/jurisdiction").DEFAULTS.economy));
        await expect(f.finalize(ca, [{ setup: await rogue.getAddress(), id: 1 }], [], []))
            .to.be.revertedWithCustomError(s.processor, "NotPublished");
    });
});
