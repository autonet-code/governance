const { expect } = require("chai");
const { ethers } = require("hardhat");
const { suite, prepare, prepareDependent, createJurisdiction, govern, REP } = require("./helpers/jurisdiction");
const { metadata, paramType } = require("../scripts/lib/modules");

// Modules after origination: anyone prepares an installation, the DAO attaches it by a proposal
// built by ModuleProcessor, and detaches it the same way. The catalog decides which setups count.
describe("Modules", function () {
    let deployer, member, outsider;
    let s;

    before(async function () {
        [deployer, member, outsider] = await ethers.getSigners();
        s = await suite();
    });

    async function liveDao(modules = []) {
        const j = await createJurisdiction(member, { members: [member.address], amounts: [REP(1000)], modules });
        await j.rep.connect(member).delegate(member.address);
        return j;
    }

    it("a prepared installation is inert until a proposal attaches it; a proposal detaches it", async function () {
        const j = await liveDao(["economy"]);
        const court = await prepare(s, outsider, j.core, "content_court", {}, j.installs);
        expect(await j.rep.slashers(court.module)).to.equal(false);

        await govern(j.dao, member, await s.processor.installCalls(await court.setup.getAddress(), court.id), "Attach the court");
        expect(await j.rep.slashers(court.module)).to.equal(true);
        expect(await j.registry.getRegistryValue("jurisdiction.content_court.court")).to.equal(court.module.toLowerCase());
        const keyCount = (await j.registry.getAllKeys()).length;

        await govern(j.dao, member, await s.processor.uninstallCalls(await court.setup.getAddress(), court.id), "Detach the court");
        expect(await j.rep.slashers(court.module)).to.equal(false);
        expect(await j.registry.getRegistryValue("modules.content_court")).to.equal("");

        // Attaching it again doesn't list the keys twice
        await govern(j.dao, member, await s.processor.installCalls(await court.setup.getAddress(), court.id), "Attach again");
        expect(await j.rep.slashers(court.module)).to.equal(true);
        expect((await j.registry.getAllKeys()).length).to.equal(keyCount);
    });

    it("adds the Economy to a DAO created without it", async function () {
        const j = await liveDao();
        const economy = await prepare(s, member, j.core, "economy");
        await govern(j.dao, member, await s.processor.installCalls(await economy.setup.getAddress(), economy.id), "Add the economy");
        const [ok, module] = await s.processor.attachedModule(j.core.registry, "economy");
        expect(ok).to.equal(true);
        expect(module).to.equal(economy.module);
        expect(await j.rep.minters(economy.prepared.helpers[0])).to.equal(true);
    });

    it("enforces dependencies both ways", async function () {
        const j = await liveDao();
        const economy = await prepare(s, member, j.core, "economy");
        const dependent = await prepareDependent(member, j.core, economy.module);
        // It depends on an economy that isn't attached
        await expect(s.processor.installCalls(await dependent.setup.getAddress(), dependent.id))
            .to.be.revertedWithCustomError(s.processor, "MissingDependency").withArgs("economy");

        await govern(j.dao, member, await s.processor.installCalls(await economy.setup.getAddress(), economy.id), "Economy");
        await govern(j.dao, member, await s.processor.installCalls(await dependent.setup.getAddress(), dependent.id), "Dependent");
        // The economy can't be detached while a module depends on it
        await expect(s.processor.uninstallCalls(await economy.setup.getAddress(), economy.id))
            .to.be.revertedWithCustomError(s.processor, "HasDependents").withArgs("dependent");

        // One wired to a different economy doesn't satisfy the dependency either
        const other = await liveDao(["economy"]);
        const stray = await prepareDependent(member, other.core, economy.module);
        await expect(s.processor.installCalls(await stray.setup.getAddress(), stray.id))
            .to.be.revertedWithCustomError(s.processor, "MissingDependency");
    });

    it("refuses a second installation of an attached module", async function () {
        const j = await liveDao(["economy"]);
        const again = await prepare(s, member, j.core, "economy");
        await expect(s.processor.installCalls(await again.setup.getAddress(), again.id))
            .to.be.revertedWithCustomError(s.processor, "AlreadyAttached");
    });

    it("won't build a proposal for an installation wired to a mismatched core", async function () {
        const a = await liveDao(["economy"]);
        const b = await liveDao();
        // Registry and token of A, governor of B
        const x = await prepare(s, outsider, { ...a.core, governor: b.core.governor }, "content_court");
        await expect(s.processor.installCalls(await x.setup.getAddress(), x.id))
            .to.be.revertedWithCustomError(s.processor, "NotAJurisdiction");
    });

    describe("Catalog", function () {
        it("lists the published modules with their metadata", async function () {
            // Other tests publish a test-only module after these
            expect([...(await s.catalog.names())].slice(0, 3)).to.deep.equal(["economy", "content_court", "autonet"]);
            const repo = await ethers.getContractAt("ModuleRepo", await s.catalog.repoOf("content_court"));
            const v = await repo.latestVersion();
            expect(v.setup).to.equal(await s.setups.content_court.getAddress());
            expect([v.release, v.build]).to.deep.equal([1n, 1n]);
            const build = JSON.parse(Buffer.from(v.buildMetadata.split(",")[1], "base64").toString());
            expect(build.ui.requires).to.deep.equal([]);
            expect(await repo.releaseMetadata(1)).to.match(/^data:application\/json;base64,/);
        });

        it("versions are tagged RELEASE.BUILD and immutable, and only the maintainer publishes", async function () {
            const repo = await (await ethers.getContractFactory("ModuleRepo")).deploy("content_court", deployer.address);
            const setup = async () => (await (await ethers.getContractFactory("ContentCourtSetup")).deploy()).getAddress();
            const s1 = await setup();
            await expect(repo.createVersion(2, s1, "b", "r")).to.be.revertedWithCustomError(repo, "BadRelease");
            await repo.createVersion(1, s1, "b", "r");
            await expect(repo.createVersion(1, s1, "b", "")).to.be.revertedWithCustomError(repo, "SetupAlreadyPublished");
            await repo.createVersion(1, await setup(), "b2", "");
            await repo.createVersion(2, await setup(), "b3", "r2");
            expect((await repo.latestVersion()).build).to.equal(1n);
            expect((await repo.getVersion(1, 2)).buildMetadata).to.equal("b2");
            await expect(repo.createVersion(1, await (await (await ethers.getContractFactory("EconomySetup")).deploy(
                ethers.ZeroAddress, ethers.ZeroAddress, 60)).getAddress(), "b", "")).to.be.revertedWithCustomError(repo, "WrongModule");
            await expect(repo.connect(outsider).createVersion(1, await setup(), "b", ""))
                .to.be.revertedWithCustomError(repo, "OwnableUnauthorizedAccount");
        });

        it("the curator registers and removes repos", async function () {
            const catalog = await (await ethers.getContractFactory("ModuleCatalog")).deploy(deployer.address);
            const repo = await (await ethers.getContractFactory("ModuleRepo")).deploy("content_court", deployer.address);
            const setup = await (await ethers.getContractFactory("ContentCourtSetup")).deploy();
            await repo.createVersion(1, await setup.getAddress(), "b", "r");
            await expect(catalog.connect(outsider).register(await repo.getAddress()))
                .to.be.revertedWithCustomError(catalog, "OwnableUnauthorizedAccount");
            await catalog.register(await repo.getAddress());
            expect(await catalog.isPublished(await setup.getAddress())).to.equal(true);
            await expect(catalog.register(await repo.getAddress())).to.be.revertedWithCustomError(catalog, "NameTaken");
            await catalog.remove("content_court");
            expect(await catalog.isPublished(await setup.getAddress())).to.equal(false);
            expect([...(await catalog.names())]).to.deep.equal([]);
        });
    });

    it("every module's build metadata encodes the data its setup decodes", async function () {
        // createJurisdiction encodes from metadata; this checks the types line up with the contracts
        for (const name of ["economy", "content_court", "autonet"]) {
            const inputs = metadata(name, "build").pluginSetup.prepareInstallation.inputs;
            expect(inputs.map(paramType).join(",")).to.not.include("undefined");
        }
        const j = await liveDao(["economy", "content_court", "autonet"]);
        const [ok] = await s.processor.attachedModule(j.core.registry, "autonet");
        expect(ok).to.equal(true);
    });
});
