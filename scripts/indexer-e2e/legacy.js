// Indexer end-to-end, phase B1: DAOs from the retired StandardFactory contracts. Etherlink still has
// DAOs those factories made (homebase-app shows them), so the indexer keeps following the factory
// addresses in contracts/<network> (wrapper, wrapper_t, wrapper_w). Their sources no longer compile
// against today's core, so each DAO here is a core deployed without the JurisdictionFactory's own
// announcement, then announced through LegacyFactoryEvents with the legacy event, from the legacy
// factory address. Appends the expectations to out/manifest.json for verify.py.
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

async function main() {
    const [deployer, alice, bob] = await ethers.getSigners();
    const E = (n) => ethers.parseEther(String(n));
    const at = (addr) => ethers.getContractAt("LegacyFactoryEvents", addr);

    // wrapper (non-transferable): announced, then a proposal and a vote on it
    let { p, core } = await deployCore({ name: "E2E Legacy", symbol: "LGC", description: "legacy factory dao",
        members: [alice.address, bob.address], amounts: [E(50), E(50)] });
    await wait((await at(dep.wrapper)).announce(core.governor, core.token, p.initialMembers, p.initialAmounts,
        p.name, p.symbol, p.description, p.executionDelay, core.registry));
    const token = await ethers.getContractAt("RepToken", core.token);
    await wait(token.connect(alice).delegate(alice.address));
    const governor = (await ethers.getContractAt("HomebaseDAO", core.governor)).connect(alice);
    const edit = new ethers.Interface(["function editRegistry(string,string)"]).encodeFunctionData("editRegistry", ["e2e.legacy", "1"]);
    const rc = await wait(governor.propose([core.registry], [0], [edit], "E2E: legacy proposal"));
    const pid = rc.logs.find((l) => l.eventName === "ProposalCreated").args.proposalId;
    await network.provider.send("evm_increaseTime", [Number(await governor.votingDelay()) + 1]);
    await network.provider.send("evm_mine");
    // Half the REP: not decided early, so it stays open
    await wait(governor.castVoteWithReason(pid, 1, "e2e legacy"));
    manifest.daos.legacy = { dao: core.governor, token: core.token, registryAddress: core.registry,
        members: { [alice.address]: E(50).toString(), [bob.address]: E(50).toString() },
        delegates: { [alice.address]: alice.address }, votingWeights: { [alice.address]: E(50).toString() },
        proposals: { [pid.toString()]: { state: "pending", forVotes: E(50).toString() } },
        proposalsCreated: { [alice.address]: [pid.toString()] },
        fields: { name: "E2E Legacy", symbol: "LGC", nonTransferrable: "True", registryAddress: core.registry } };

    // wrapper_t (transferable)
    ({ p, core } = await deployCore({ name: "E2E Legacy T", symbol: "LGT", description: "legacy transferable",
        tokenKind: 1, members: [bob.address], amounts: [E(20)] }));
    await wait((await at(dep.wrapper_t)).announce(core.governor, core.token, p.initialMembers, p.initialAmounts,
        p.name, p.symbol, p.description, p.executionDelay, core.registry));
    manifest.daos.legacyTransferable = { dao: core.governor, token: core.token,
        members: { [bob.address]: E(20).toString() }, fields: { nonTransferrable: "False" } };

    // wrapper_w (wrapped ERC20): DaoWrappedDeploymentInfo
    const underlying = await (await ethers.getContractFactory("TestERC20")).deploy("Legacy Underlying", "LUND", 18, E(100));
    await underlying.waitForDeployment();
    ({ p, core } = await deployCore({ name: "E2E Legacy W", symbol: "wLUND", description: "legacy wrapped",
        tokenKind: 2, underlying: await underlying.getAddress() }));
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
