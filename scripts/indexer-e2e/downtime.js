// Indexer end-to-end, phase B2: events while the indexer is stopped. Run between two indexer runs:
// a DAO created, and proposals created, voted on and executed, all while it is down. On restart the
// historical sync records them and the main loop then replays the same blocks; nothing it already
// recorded may be reset (a replayed ProposalCreated used to overwrite the proposal, zeroing its votes).
// Adds the expectations to out/manifest.json for verify.py.
//   npx hardhat run scripts/indexer-e2e/downtime.js --network localhost
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { wait, createJurisdiction } = require("./jurisdiction");

const dep = require("./out/deployment.json");
const file = path.join(__dirname, "out", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));

async function advance(seconds) {
    await network.provider.send("evm_increaseTime", [Number(seconds)]);
    await network.provider.send("evm_mine");
}

// propose -> vote -> queue -> execute
async function govern(governor, voters, targets, calldatas, description) {
    const receipt = await wait(governor.propose(targets, targets.map(() => 0), calldatas, description));
    const proposalId = receipt.logs.find((l) => l.eventName === "ProposalCreated").args.proposalId;
    await advance(Number(await governor.votingDelay()) + 1);
    for (const v of voters) await wait(governor.connect(v).castVoteWithReason(proposalId, 1, "e2e downtime"));
    await advance(Number(await governor.votingPeriod()) + 1);
    const descHash = ethers.id(description);
    await wait(governor.queue(targets, targets.map(() => 0), calldatas, descHash));
    const timelock = await ethers.getContractAt("@openzeppelin/contracts/governance/TimelockController.sol:TimelockController", await governor.timelock());
    await advance(Number(await timelock.getMinDelay()) + 1);
    await wait(governor.execute(targets, targets.map(() => 0), calldatas, descHash));
    return proposalId;
}

async function main() {
    const [, alice, bob] = await ethers.getSigners();
    const E = (n) => ethers.parseEther(String(n));
    const registryEdit = (registry, key, value) =>
        [[registry], [new ethers.Interface(["function editRegistry(string,string)"]).encodeFunctionData("editRegistry", [key, value])]];

    // An existing DAO: a proposal created, voted and executed while the indexer is down
    const std = manifest.daos.standard;
    const stdGov = (await ethers.getContractAt("HomebaseDAO", std.dao)).connect(alice);
    const stdId = await govern(stdGov, [alice], ...registryEdit(std.registryAddress, "e2e.downtime", "v1"), "E2E: edit while down");
    std.proposals[stdId.toString()] = { state: "Executed", forVotes: E(1000).toString(), supermajorityBps: null };
    std.registryValues["e2e.downtime"] = "v1";

    // A DAO created while the indexer is down, with a proposal of its own
    const j = await createJurisdiction(dep, {
        name: "E2E Downtime", symbol: "DWN", description: "created while the indexer was down",
        members: [alice.address, bob.address], amounts: [E(70), E(30)],
    });
    const token = await ethers.getContractAt("RepToken", j.core.token);
    await wait(token.connect(alice).delegate(alice.address));
    await wait(token.connect(bob).delegate(bob.address));
    // 70% For decides it early
    const id = await govern(j.governor.connect(alice), [alice], ...registryEdit(j.core.registry, "e2e.created", "while down"),
        "E2E: first proposal while down");
    manifest.daos.downtime = { dao: j.core.governor, token: j.core.token, registryAddress: j.core.registry,
        members: { [alice.address]: E(70).toString(), [bob.address]: E(30).toString() },
        delegates: { [alice.address]: alice.address, [bob.address]: bob.address },
        votingWeights: { [alice.address]: E(70).toString(), [bob.address]: E(30).toString() },
        proposals: { [id.toString()]: { state: "Executed", forVotes: E(70).toString(), supermajorityBps: null } },
        // A replayed DAO creation used to rewrite the member docs, dropping what came after it
        proposalsCreated: { [alice.address]: [id.toString()] },
        registryValues: { "e2e.created": "while down" },
        activity: ["daoCreated", "delegate", "proposalCreated", "vote", "proposalQueued", "proposalExecuted", "registryEdit"] };
    std.proposalsCreated = { ...(std.proposalsCreated || {}), [alice.address]: [stdId.toString()] };

    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    console.log(`downtime events done: proposal ${stdId} on the standard DAO, DAO ${j.core.governor} with proposal ${id}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
