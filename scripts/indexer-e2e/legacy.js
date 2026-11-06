// Indexer end-to-end, phase B1: DAOs from the retired StandardFactory contracts. Etherlink still has
// DAOs those factories made (homebase-app shows them), so the indexer keeps following the factory
// addresses in contracts/<network> (wrapper, wrapper_t, wrapper_w). Their sources no longer compile
// against today's core, so each DAO here is a core deployed without the JurisdictionFactory's own
// announcement, then announced through LegacyFactoryEvents with the legacy event, from the legacy
// factory address. Transferable and wrapped tokens exist only on those DAOs, so they come from
// contracts/mocks. Appends the expectations to out/manifest.json for verify.py.
//   npx hardhat run scripts/indexer-e2e/legacy.js --network localhost
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { wait, coreParams } = require("./jurisdiction");

const dep = require("./out/deployment.json");
const file = path.join(__dirname, "out", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));

async function deployCore(o) {
    const f = await ethers.getContractAt("JurisdictionFactory", dep.jurisdictionFactory);
    const p = coreParams(o);
    const core = await f.deployCore.staticCall(p);
    await wait(f.deployCore(p));
    return { p, core: { registry: core.registry, timelock: core.timelock, token: core.token, governor: core.governor } };
}

// A core on a token the factory no longer makes. `token(timelock, registry)` deploys it.
async function deployLegacyCore(o, token) {
    const [deployer] = await ethers.getSigners();
    const p = coreParams(o);
    const infra = await ethers.getContractAt("InfrastructureFactory", dep.infrastructureFactory);
    const dao = await ethers.getContractAt("DAOFactory", dep.daoFactory);
    const timelock = await infra.deployTimelock.staticCall(deployer.address, p.executionDelay);
    await wait(infra.deployTimelock(deployer.address, p.executionDelay));
    const registry = await infra.deployRegistry.staticCall(deployer.address, ethers.ZeroAddress);
    await wait(infra.deployRegistry(deployer.address, ethers.ZeroAddress));
    const tok = await token();
    await tok.waitForDeployment();
    const settings = [p.votingDelay, p.votingPeriod, p.proposalThreshold, p.quorumFraction, p.supermajorityBps];
    const address = await tok.getAddress();
    const governor = await dao.deployDAO.staticCall(address, timelock, p.name, settings);
    await wait(dao.deployDAO(address, timelock, p.name, settings));
    return { p, core: { registry, timelock, token: address, governor } };
}

async function main() {
    const [deployer, alice, bob, carol] = await ethers.getSigners();
    const E = (n) => ethers.parseEther(String(n));
    const at = (addr) => ethers.getContractAt("LegacyFactoryEvents", addr);

    // wrapper (non-transferable): announced, then a proposal and a vote on it
    let { p, core } = await deployCore({ name: "E2E Legacy", symbol: "LGC", description: "legacy factory dao",
        members: [alice.address, bob.address], amounts: [E(50), E(50)] });
    await wait((await at(dep.wrapper)).announce(core.governor, core.token, p.initialMembers, p.initialAmounts,
        p.name, p.symbol, p.description, p.executionDelay, core.registry));
    const token = await ethers.getContractAt("RepToken", core.token);
    await wait(token.connect(alice).delegate(alice.address));
    await wait(token.connect(bob).delegate(bob.address));
    const governor = (await ethers.getContractAt("HomebaseDAO", core.governor)).connect(alice);
    const edit = new ethers.Interface(["function editRegistry(string,string)"]).encodeFunctionData("editRegistry", ["e2e.legacy", "1"]);
    const rc = await wait(governor.propose([core.registry], [0], [edit], "E2E: legacy proposal"));
    const pid = rc.logs.find((l) => l.eventName === "ProposalCreated").args.proposalId;
    await network.provider.send("evm_increaseTime", [Number(await governor.votingDelay()) + 1]);
    await network.provider.send("evm_mine");
    // Half the REP: not decided early, so it stays open
    await wait(governor.castVoteWithReason(pid, 1, "e2e legacy"));
    await wait(governor.connect(bob).castVote(pid, 2));
    manifest.daos.legacy = { dao: core.governor, token: core.token, registryAddress: core.registry,
        members: { [alice.address]: E(50).toString(), [bob.address]: E(50).toString() },
        delegates: { [alice.address]: alice.address }, votingWeights: { [alice.address]: E(50).toString() },
        proposals: { [pid.toString()]: { state: "pending", forVotes: E(50).toString(), abstain: E(50).toString() } },
        proposalsCreated: { [alice.address]: [pid.toString()] },
        fields: { name: "E2E Legacy", symbol: "LGC", nonTransferrable: "True", registryAddress: core.registry } };

    // wrapper_t (transferable): a transfer moves the balances
    ({ p, core } = await deployLegacyCore({ name: "E2E Legacy T", symbol: "LGT", description: "legacy transferable",
        members: [bob.address], amounts: [E(20)] }, async () => (await ethers.getContractFactory("TransferableToken"))
        .deploy("E2E Legacy T", "LGT", [bob.address], [E(20)])));
    await wait((await at(dep.wrapper_t)).announce(core.governor, core.token, p.initialMembers, p.initialAmounts,
        p.name, p.symbol, p.description, p.executionDelay, core.registry));
    await wait((await ethers.getContractAt("TransferableToken", core.token)).connect(bob).transfer(carol.address, E(5)));
    manifest.daos.legacyTransferable = { dao: core.governor, token: core.token,
        members: { [bob.address]: E(15).toString(), [carol.address]: E(5).toString() }, fields: { nonTransferrable: "False" } };

    // wrapper_w (wrapped ERC20): DaoWrappedDeploymentInfo
    const underlying = await (await ethers.getContractFactory("TestERC20")).deploy("Legacy Underlying", "LUND", 18, E(100));
    await underlying.waitForDeployment();
    ({ p, core } = await deployLegacyCore({ name: "E2E Legacy W", symbol: "wLUND", description: "legacy wrapped" },
        async () => (await ethers.getContractFactory("WrappedRepToken"))
            .deploy(await underlying.getAddress(), "E2E Legacy W", "wLUND", false)));
    await wait((await at(dep.wrapper_w)).announceWrapped({ dao: core.governor, token: core.token,
        underlying: await underlying.getAddress(), registry: core.registry, name: p.name, symbol: p.symbol,
        description: p.description, quorumFraction: p.quorumFraction, executionDelay: p.executionDelay,
        votingDelay: p.votingDelay * 60, votingPeriod: p.votingPeriod * 60, proposalThreshold: p.proposalThreshold }));
    const wTok = await ethers.getContractAt("WrappedRepToken", core.token);
    await wait(underlying.approve(core.token, E(10)));
    await wait(wTok.depositFor(deployer.address, E(10)));
    manifest.daos.legacyWrapped = { dao: core.governor, token: core.token,
        members: { [deployer.address]: E(10).toString() },
        fields: { underlyingToken: await underlying.getAddress(), name: "E2E Legacy W" } };

    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    console.log("legacy factory DAOs announced");
}

main().catch((e) => { console.error(e); process.exit(1); });
