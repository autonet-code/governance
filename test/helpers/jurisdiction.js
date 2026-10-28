// Creates jurisdictions the way the werule wizard does: JurisdictionFactory.deployCore, a prepared
// installation per module (data encoded from the module's build metadata), then finalize.
const { ethers } = require("hardhat");
const { deployJurisdictionSuite, encodeInstallData } = require("../../scripts/lib/modules");

const REP = (n) => ethers.parseEther(String(n));
const DAY = 86400;

const DEFAULTS = {
    economy: {
        params: { arbitrationFeeBps: 250, platformFeeBps: 250, authorFeeBps: 500, coolingOffPeriod: 60,
            backersQuorumBps: 5100, projectThreshold: 0, appealPeriod: 120 },
    },
    content_court: {
        params: { caseDeposit: ethers.parseEther("1"), thresholdBps: 5500, reviewWindow: 3 * DAY, revealWindow: DAY,
            degradeBps: 1000, assertionSlashBps: 2000, appealPeriod: 120 },
    },
    autonet: {
        substrate: { challengeWindow: 3600, charter: "", epochRules: "" },
        toolBond: { minStake: 100_000_000n, revealWindow: DAY, degradeBps: 1000, authorSlashBps: 10000,
            unbondDelay: 30 * DAY, reviewerShareBps: 4000, appealPeriod: 120, harmWeightBps: 20000, harmQuorumBps: 10 },
    },
};

let _suite;
async function suite() {
    if (!_suite) _suite = await deployJurisdictionSuite(ethers, (await ethers.getSigners())[0]);
    return _suite;
}

function coreParams(o = {}) {
    return {
        name: o.name ?? "Jurisdiction", symbol: o.symbol ?? "REP", description: o.description ?? "",
        tokenKind: o.tokenKind ?? 0, underlying: o.underlying ?? ethers.ZeroAddress,
        initialMembers: o.members ?? [], initialAmounts: o.amounts ?? [],
        votingDelay: o.votingDelay ?? 0, votingPeriod: o.votingPeriod ?? 2,
        proposalThreshold: o.proposalThreshold ?? 0, quorumFraction: o.quorumFraction ?? 4,
        executionDelay: o.executionDelay ?? 0,
    };
}

/// Prepares an installation of `name` for `core`; returns its id
async function prepare(s, from, core, name, values = {}) {
    const v = { ...DEFAULTS[name], ...values };
    const setup = s.setups[name].connect(from);
    await (await setup.prepareInstallation(core, encodeInstallData(ethers, name, v))).wait();
    const id = await setup.lastPreparedBy(from.address);
    const [, p] = await setup.installationOf(id);
    return { id, setup, module: p.module, prepared: p };
}

/// A test-only module, published in the suite's catalog, that depends on an attached economy.
/// prepareDependent(from, core, economy) prepares it like `prepare` does.
let _dependent;
async function dependentSetup() {
    const s = await suite();
    if (!_dependent) {
        const [deployer] = await ethers.getSigners();
        const setup = await (await ethers.getContractFactory("MockDependentSetup", deployer)).deploy();
        const repo = await (await ethers.getContractFactory("ModuleRepo", deployer)).deploy("dependent", deployer.address);
        await (await repo.createVersion(1, await setup.getAddress(), "", "")).wait();
        await (await s.catalog.connect(deployer).register(await repo.getAddress())).wait();
        _dependent = setup;
    }
    return _dependent;
}

async function prepareDependent(from, core, economy) {
    const setup = (await dependentSetup()).connect(from);
    await (await setup.prepareInstallation(core, ethers.AbiCoder.defaultAbiCoder().encode(["address"], [economy]))).wait();
    const id = await setup.lastPreparedBy(from.address);
    const [, p] = await setup.installationOf(id);
    return { id, setup, module: p.module, prepared: p };
}

/// `modules`: array of names, or [name, values] pairs, attached in order
async function createJurisdiction(from, o = {}) {
    const s = await suite();
    const f = s.jurisdictionFactory.connect(from);
    const p = coreParams(o);
    const core = await f.deployCore.staticCall(p);
    await (await f.deployCore(p)).wait();
    const c = { registry: core.registry, timelock: core.timelock, token: core.token, governor: core.governor };
    const installs = {};
    const refs = [];
    for (const m of o.modules ?? []) {
        const [name, values] = Array.isArray(m) ? m : [m, {}];
        installs[name] = await prepare(s, from, c, name, values);
        refs.push({ setup: await installs[name].setup.getAddress(), id: installs[name].id });
    }
    await (await f.finalize(c, refs, o.keys ?? [], o.values ?? [])).wait();
    return {
        s, core: c, installs,
        dao: await ethers.getContractAt("HomebaseDAO", c.governor),
        rep: await ethers.getContractAt(o.tokenKind === 2 ? "WrappedRepToken" : "RepToken", c.token),
        registry: await ethers.getContractAt("Registry", c.registry),
        timelock: await ethers.getContractAt("TimelockController", c.timelock),
        economy: installs.economy && await ethers.getContractAt("Economy", installs.economy.module),
        economyClaim: installs.economy && await ethers.getContractAt("EconomyRepClaim", installs.economy.prepared.helpers[0]),
    };
}

/// Propose, vote (by `voter`), wait out the voting period, queue and execute
async function govern(dao, voter, [targets, values, calldatas], description) {
    const { time } = require("@nomicfoundation/hardhat-network-helpers");
    [targets, values, calldatas] = [[...targets], [...values], [...calldatas]];
    const rc = await (await dao.connect(voter).propose(targets, values, calldatas, description)).wait();
    const id = rc.logs.map((l) => { try { return dao.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "ProposalCreated").args.proposalId;
    await dao.connect(voter).castVote(id, 1);
    await time.increase(Number(await dao.votingPeriod()) + 1);
    await dao.queue(targets, values, calldatas, ethers.id(description));
    await dao.execute(targets, values, calldatas, ethers.id(description));
    return id;
}

module.exports = { REP, DAY, DEFAULTS, suite, coreParams, prepare, prepareDependent, createJurisdiction, govern };
