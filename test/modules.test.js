const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Jurisdiction modules, with ContentCourt as the example: installed and attached at origination
// (configureAndFinalizeWithGrants), and installed later by anyone and attached by proposal through
// ModuleAttacher, then detached the same way.
describe("Modules", function () {
    let deployer, member, outsider;
    let trustlessFactory, courts, attacher, nativeImpl, erc20Impl;

    const DAY = 86400;
    const COURT = {
        caseDeposit: ethers.parseEther("1"), thresholdBps: 5500, reviewWindow: 3 * DAY, revealWindow: DAY,
        degradeBps: 1000, assertionSlashBps: 2000,
    };

    const deploy = async (name, ...args) => (await ethers.getContractFactory(name)).deploy(...args);

    // Steps 1 and 2; `modules(j)` installs modules and returns their manifests before step 3
    async function originate(modules = async () => []) {
        const f = trustlessFactory.connect(member);
        const infra = (await (await f.deployInfrastructure(0, 250)).wait())
            .logs.find((l) => l.eventName === "InfrastructureDeployed").args;
        const tok = (await (await f.deployDAOToken(infra.registry, infra.timelock,
            { name: "Rep", symbol: "REP", initialMembers: [member.address], initialAmounts: [ethers.parseEther("1000")] },
            { name: "DAO", votingDelay: 0, votingPeriod: 2, proposalThreshold: 0, quorumFraction: 4 }
        )).wait()).logs.find((l) => l.eventName === "DAOTokenDeployed").args;
        const j = { registry: infra.registry, timelock: infra.timelock, repToken: tok.repToken, economy: infra.economy, dao: tok.dao };

        const manifests = await modules(j);
        const all = (field) => manifests.flatMap((m) => [...m[field]]);
        await f.configureAndFinalizeWithGrants(
            { implAddresses: [await nativeImpl.getAddress(), await erc20Impl.getAddress()],
              contractAddresses: [infra.economy, infra.registry, infra.timelock, tok.repToken, tok.dao] },
            { arbitrationFeeBps: 250, initialPlatformFeeBps: 250, initialAuthorFeeBps: 500, initialCoolingOffPeriod: 60,
              initialBackersQuorumBps: 5100, initialProjectThreshold: 0, initialAppealPeriod: 120 },
            all("registryKeys"), all("registryValues"), all("minters"), all("slashers"));
        return {
            j,
            dao: await ethers.getContractAt("HomebaseDAO", tok.dao),
            rep: await ethers.getContractAt("RepToken", tok.repToken),
            registry: await ethers.getContractAt("Registry", infra.registry),
        };
    }

    async function installCourt(j, from = outsider) {
        await courts.connect(from).install(j, COURT);
        return courts.lastInstallBy(from.address);
    }

    async function govern(dao, [targets, values, calldatas], description) {
        const rc = await (await dao.connect(member).propose([...targets], [...values], [...calldatas], description)).wait();
        const id = rc.logs.map((l) => { try { return dao.interface.parseLog(l); } catch { return null; } })
            .find((e) => e && e.name === "ProposalCreated").args.proposalId;
        await dao.connect(member).castVote(id, 1);
        await time.increase(121);
        await dao.queue([...targets], [...values], [...calldatas], ethers.id(description));
        await dao.execute([...targets], [...values], [...calldatas], ethers.id(description));
    }

    before(async function () {
        [deployer, member, outsider] = await ethers.getSigners();
        nativeImpl = await deploy("NativeProject");
        erc20Impl = await deploy("ERC20Project");
        trustlessFactory = await deploy("TrustlessFactory",
            await (await deploy("InfrastructureFactory")).getAddress(),
            await (await deploy("DAOFactory")).getAddress(),
            await (await deploy("EconomyFactory")).getAddress(),
            await (await deploy("RepTokenFactory")).getAddress());
        courts = await deploy("ContentCourtFactory");
        attacher = await deploy("ModuleAttacher");
    });

    it("attaches a module at origination", async function () {
        const { rep, registry } = await originate(async (j) => [await courts.manifest(await installCourt(j, member))]);
        const id = await courts.lastInstallBy(member.address);
        const court = await courts.courtOf(id);

        expect(await rep.slashers(court)).to.equal(true);
        expect(await registry.getRegistryValue("jurisdiction.content_court.court")).to.equal(court.toLowerCase());
        expect(await registry.getRegistryValue("modules.content_court"))
            .to.equal(`${(await courts.getAddress()).toLowerCase()}:${id}`);
        const c = await ethers.getContractAt("ContentCourt", court);
        expect(await c.timelock()).to.equal(await rep.timelockAddress());
        expect(await c.treasury()).to.equal(await registry.getAddress());
    });

    it("an installed module is inert until a proposal attaches it, and a proposal detaches it", async function () {
        const { j, dao, rep, registry } = await originate();
        await rep.connect(member).delegate(member.address);

        const id = await installCourt(j);
        const court = await courts.courtOf(id);
        expect(await rep.slashers(court)).to.equal(false);

        await govern(dao, await attacher.attachCalls(await courts.getAddress(), id), "Attach the content court");
        expect(await rep.slashers(court)).to.equal(true);
        expect(await registry.getRegistryValue("jurisdiction.content_court.court")).to.equal(court.toLowerCase());
        const keyCount = (await registry.getAllKeys()).length;

        await govern(dao, await attacher.detachCalls(await courts.getAddress(), id), "Detach the content court");
        expect(await rep.slashers(court)).to.equal(false);
        expect(await registry.getRegistryValue("jurisdiction.content_court.court")).to.equal("");
        expect(await registry.getRegistryValue("modules.content_court")).to.equal("");

        // Attaching again doesn't list the keys twice
        await govern(dao, await attacher.attachCalls(await courts.getAddress(), id), "Attach it again");
        expect(await rep.slashers(court)).to.equal(true);
        expect((await registry.getAllKeys()).length).to.equal(keyCount);
    });

    it("won't build a proposal for a module wired to a mismatched jurisdiction", async function () {
        const a = await originate();
        const b = await originate();
        // Registry of A, timelock of B: an installation that would answer to B's governance
        const id = await installCourt({ ...a.j, timelock: b.j.timelock });
        await expect(attacher.attachCalls(await courts.getAddress(), id))
            .to.be.revertedWithCustomError(attacher, "NotAJurisdiction");
    });

    it("rejects missing jurisdiction addresses and unknown installations", async function () {
        const z = ethers.ZeroAddress;
        await expect(courts.install({ registry: z, timelock: z, repToken: z, economy: z, dao: z }, COURT))
            .to.be.revertedWithCustomError(courts, "ZeroAddress");
        await expect(courts.manifest(999)).to.be.revertedWithCustomError(courts, "UnknownInstall");
    });
});
