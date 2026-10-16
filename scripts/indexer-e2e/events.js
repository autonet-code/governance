// Indexer end-to-end, phase B: emit every DAO and trustless event type the indexer should capture,
// and record what happened in out/manifest.json for verify.py.
//   npx hardhat run scripts/indexer-e2e/events.js --network localhost
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { wait, prepare, createJurisdiction } = require("./jurisdiction");

const dep = require("./out/deployment.json");
const manifest = { daos: {}, projects: {} };

const eventArgs = (receipt, name) => receipt.logs.find(l => l.eventName === name)?.args;
async function advance(seconds) {
    await network.provider.send("evm_increaseTime", [Number(seconds)]);
    await network.provider.send("evm_mine");
}

// propose -> vote -> queue -> execute through a HomebaseDAO governor
async function govern(governor, voters, targets, calldatas, description) {
    [targets, calldatas] = [[...targets], [...calldatas]];
    const receipt = await wait(governor.propose(targets, targets.map(() => 0), calldatas, description));
    const proposalId = eventArgs(receipt, "ProposalCreated").proposalId;
    await advance(Number(await governor.votingDelay()) + 1);
    for (const v of voters) await wait(governor.connect(v).castVoteWithReason(proposalId, 1, "e2e"));
    await advance(Number(await governor.votingPeriod()) + 1);
    const descHash = ethers.id(description);
    await wait(governor.queue(targets, targets.map(() => 0), calldatas, descHash));
    const timelock = await ethers.getContractAt("@openzeppelin/contracts/governance/TimelockController.sol:TimelockController", await governor.timelock());
    await advance(Number(await timelock.getMinDelay()) + 1);
    await wait(governor.execute(targets, targets.map(() => 0), calldatas, descHash));
    return proposalId;
}

const ECONOMY = { params: { arbitrationFeeBps: 500, platformFeeBps: 100, authorFeeBps: 100, coolingOffPeriod: 60,
    backersQuorumBps: 7000, projectThreshold: 0, appealPeriod: 86400 } };

async function main() {
    const [deployer, alice, bob, carol, contractor, arbiter] = await ethers.getSigners();
    const E = (n) => ethers.parseEther(String(n));
    const processor = await ethers.getContractAt("ModuleProcessor", dep.moduleProcessor);

    // ---------------- DAO side ----------------
    // 1. Standard (soulbound) DAO: delegation, a full proposal that edits the registry, then the
    //    economy module attached by proposal and detached again
    let j = await createJurisdiction(dep, {
        name: "E2E Standard", symbol: "STD", description: "standard dao",
        members: [alice.address, bob.address], amounts: [E(600), E(400)],
        keys: ["e2e.key"], values: ["v1"],
    });
    const stdGov = j.governor;
    const stdToken = await ethers.getContractAt("RepToken", j.core.token);
    const stdRegistry = await ethers.getContractAt("Registry", j.core.registry);
    await wait(stdToken.connect(alice).delegate(alice.address));
    await wait(stdToken.connect(bob).delegate(alice.address));
    const stdProposal = await govern(stdGov.connect(alice), [alice], [j.core.registry],
        [stdRegistry.interface.encodeFunctionData("editRegistry", ["e2e.key", "v2"])], "E2E: edit registry");
    const stdEconomy = await prepare(dep, j.core, "economy", ECONOMY);
    const stdSetup = await stdEconomy.setup.getAddress();
    const [attachTargets, , attachCalls] = await processor.installCalls(stdSetup, stdEconomy.id);
    await govern(stdGov.connect(alice), [alice], attachTargets, attachCalls, "E2E: attach the economy");
    const [detachTargets, , detachCalls] = await processor.uninstallCalls(stdSetup, stdEconomy.id);
    await govern(stdGov.connect(alice), [alice], detachTargets, detachCalls, "E2E: detach the economy");
    manifest.daos.standard = { dao: j.core.governor, token: j.core.token, registryAddress: j.core.registry,
        members: { [alice.address]: E(600).toString(), [bob.address]: E(400).toString() },
        delegates: { [alice.address]: alice.address, [bob.address]: alice.address },
        votingWeights: { [alice.address]: E(1000).toString() },
        proposals: { [stdProposal.toString()]: { state: "Executed", forVotes: E(1000).toString() } },
        registryValues: { "e2e.key": "v2", "jurisdiction.economy": "", "modules.economy": "" },
        economyDetached: stdEconomy.module };

    // 2. Transferable DAO: a token transfer between members, and the economy attached by proposal
    j = await createJurisdiction(dep, {
        name: "E2E Transferable", symbol: "TRF", description: "transferable dao", tokenKind: 1,
        members: [alice.address, bob.address], amounts: [E(100), E(100)],
    });
    const trfToken = await ethers.getContractAt("RepToken", j.core.token);
    await wait(trfToken.connect(alice).transfer(carol.address, E(30)));
    await wait(trfToken.connect(alice).delegate(alice.address));
    const trfEconomy = await prepare(dep, j.core, "economy", ECONOMY);
    const [trfTargets, , trfCalls] = await processor.installCalls(await trfEconomy.setup.getAddress(), trfEconomy.id);
    await govern(j.governor.connect(alice), [alice], trfTargets, trfCalls, "E2E: add the economy");
    manifest.daos.transferable = { dao: j.core.governor, token: j.core.token, economy: trfEconomy.module,
        members: { [alice.address]: E(70).toString(), [bob.address]: E(100).toString(), [carol.address]: E(30).toString() },
        registryValues: { "jurisdiction.economy": trfEconomy.module.toLowerCase() } };

    // 3. Wrapped-token DAO: wrap an existing ERC20
    const underlying = await (await ethers.getContractFactory("TestERC20")).deploy("Underlying", "UND", 18, E(1000));
    await underlying.waitForDeployment();
    j = await createJurisdiction(dep, {
        name: "E2E Wrapped", symbol: "wUND", description: "wrapped dao", tokenKind: 2,
        underlying: await underlying.getAddress(),
    });
    const wTok = await ethers.getContractAt("WrappedRepToken", j.core.token);
    await wait(underlying.approve(j.core.token, E(50)));
    await wait(wTok.depositFor(deployer.address, E(50)));
    manifest.daos.wrapped = { dao: j.core.governor, token: j.core.token,
        members: { [deployer.address]: E(50).toString() },
        fields: { underlyingToken: await underlying.getAddress() } };

    // 4. Economy DAO: the economy module attached at origination, parities recorded by finalize
    const usdc = await (await ethers.getContractFactory("TestERC20")).deploy("Test USDC", "USDC", 6, 10n ** 15n);
    await usdc.waitForDeployment();
    const usdcAddr = await usdc.getAddress();
    const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    j = await createJurisdiction(dep, {
        name: "E2E Economy", symbol: "ECO", members: [deployer.address, alice.address], amounts: [E(1000), E(500)],
        modules: { economy: ECONOMY },
        keys: [`jurisdiction.parity.${NATIVE.toLowerCase()}`, `jurisdiction.parity.${usdcAddr.toLowerCase()}`],
        values: [E(1).toString(), (10n ** 30n).toString()],
    });
    const economy = await ethers.getContractAt("Economy", j.installs.economy.module);
    const repClaim = await ethers.getContractAt("EconomyRepClaim", j.installs.economy.helpers[0]);
    const ecoGov = j.governor;
    const ecoToken = await ethers.getContractAt("RepToken", j.core.token);
    await wait(ecoToken.connect(deployer).delegate(deployer.address));
    await wait(ecoToken.connect(alice).delegate(alice.address));
    manifest.daos.economy = { dao: j.core.governor, token: j.core.token, registryAddress: j.core.registry,
        economy: await economy.getAddress(),
        members: { [deployer.address]: E(1000).toString(), [alice.address]: E(500).toString() },
        votingWeights: { [deployer.address]: E(1000).toString(), [alice.address]: E(500).toString() },
        registryValues: { "jurisdiction.economy.rep_claim": (await repClaim.getAddress()).toLowerCase() } };

    // ---------------- Trustless side ----------------
    const coolingOff = async () => advance(Number(await economy.coolingOffPeriod()) + 1);
    const newProject = async (name, withParties, token) => {
        const c = withParties ? contractor.address : ethers.ZeroAddress;
        const a = withParties ? arbiter.address : ethers.ZeroAddress;
        const rc = token
            ? await wait(economy.createERC20Project(name, c, a, "terms", "https://github.com/e2e/repo", "desc", token))
            : await wait(economy.createProject(name, c, a, "terms", "https://github.com/e2e/repo", "desc"));
        const addr = eventArgs(rc, "NewProject").contractAddress;
        return ethers.getContractAt(token ? "ERC20Project" : "NativeProject", addr);
    };
    const stakeFor = async (p) => (await p.totalLocked()) * 500n / 10000n / 2n;

    // P1 native: immediate release, released by vote, everyone withdraws, stake reclaimed
    const p1 = await newProject("P1 release", true);
    await wait(p1.connect(bob).sendFundsWithImmediate(2000, { value: E(10) }));
    await coolingOff();
    await wait(p1.connect(contractor).signContract({ value: await stakeFor(p1) }));
    await wait(p1.connect(bob).voteToReleasePayment());
    await wait(p1.connect(contractor).withdrawAsContractor());
    await wait(p1.connect(bob).withdrawAsContributor());
    await wait(p1.connect(contractor).reclaimArbitrationStake());
    manifest.projects.p1 = { address: await p1.getAddress(), stage: "closed", backers: [bob.address],
        events: ["NewProject", "SendFunds", "ContractSigned", "ImmediateFundsReleased", "BackerVoteCast", "ProjectClosed",
                 "AuthorPaid", "ContractorPaid", "ContributorWithdrawn", "ArbitrationStakeReclaimed"] };

    // P2 ERC20: parties set later, two backers, dispute, arbiter ruling finalized after the appeal window
    const p2 = await newProject("P2 dispute", false, usdcAddr);
    await wait(p2.setParties(contractor.address, arbiter.address, "terms-v2"));
    for (const [who, amt] of [[bob, 600n], [carol, 400n]]) {
        await wait(usdc.transfer(who.address, amt * 10n ** 6n));
        await wait(usdc.connect(who).approve(await p2.getAddress(), amt * 10n ** 6n));
        await wait(p2.connect(who).sendFunds(amt * 10n ** 6n));
    }
    await coolingOff();
    await wait(usdc.transfer(contractor.address, 10n ** 9n));
    await wait(usdc.connect(contractor).approve(await p2.getAddress(), await stakeFor(p2)));
    await wait(p2.connect(contractor).signContract());
    await wait(p2.connect(bob).voteToDispute());
    await wait(p2.connect(carol).voteToDispute()); // 70% quorum
    await wait(p2.connect(arbiter).arbitrate(60, "ruling-p2"));
    await advance(Number(await p2.appealEnds()) - (await ethers.provider.getBlock("latest")).timestamp + 1);
    await wait(p2.finalizeArbitration());
    await wait(p2.connect(contractor).withdrawAsContractor());
    await wait(p2.connect(bob).withdrawAsContributor());
    manifest.projects.p2 = { address: await p2.getAddress(), stage: "closed", backers: [bob.address, carol.address],
        disputeResolution: 60,
        events: ["NewProject", "SetParties", "SendFunds", "ContractSigned", "BackerVoteCast", "ProjectDisputed",
                 "ArbitrationDecision", "ArbitrationFinalized", "ProjectClosed", "ContractorPaid", "AuthorPaid", "ContributorWithdrawn"] };

    // P3 native: contractor disputes, arbiter rules, the DAO appeals by proposal and overrules
    const p3 = await newProject("P3 appeal", true);
    await wait(p3.connect(bob).sendFunds({ value: E(5) }));
    await coolingOff();
    await wait(p3.connect(contractor).signContract({ value: await stakeFor(p3) }));
    await wait(p3.connect(contractor).disputeAsContractor());
    await wait(p3.connect(arbiter).arbitrate(80, "ruling-p3"));
    const overrule = p3.interface.encodeFunctionData("daoOverrule", [30, "dao-ruling-p3"]);
    const desc = "E2E: overrule P3";
    const pr = await wait(ecoGov.connect(deployer).propose([await p3.getAddress()], [0], [overrule], desc));
    const appealId = eventArgs(pr, "ProposalCreated").proposalId;
    // The indexer registers the overrule on the project, holding finalization while it is live
    for (let i = 0; i < 60 && (await p3.heldProposals()).length === 0; i++) {
        await network.provider.send("evm_mine");
        await new Promise((r) => setTimeout(r, 1000));
    }
    if ((await p3.heldProposals())[0] !== appealId) throw new Error("indexer never registered the P3 overrule on the project");
    console.log("indexer registered the P3 overrule on the project");
    await advance(Number(await ecoGov.votingDelay()) + 1);
    await wait(ecoGov.connect(deployer).castVote(appealId, 1));
    await advance(Number(await ecoGov.votingPeriod()) + 1);
    await wait(ecoGov.queue([await p3.getAddress()], [0], [overrule], ethers.id(desc)));
    await advance(61); // economy timelock delay is 1 minute
    await wait(ecoGov.execute([await p3.getAddress()], [0], [overrule], ethers.id(desc)));
    manifest.projects.p3 = { address: await p3.getAddress(), stage: "closed", backers: [bob.address], disputeResolution: 30,
        appealProposalId: appealId.toString(),
        events: ["NewProject", "SendFunds", "ContractSigned", "ProjectDisputed", "ArbitrationDecision",
                 "ProposalCreated", "DaoOverruled", "ProjectClosed"] };

    // P4 native: contractor reimburses
    const p4 = await newProject("P4 reimburse", true);
    await wait(p4.connect(carol).sendFunds({ value: E(2) }));
    await coolingOff();
    await wait(p4.connect(contractor).signContract({ value: await stakeFor(p4) }));
    await wait(p4.connect(contractor).reimburse());
    manifest.projects.p4 = { address: await p4.getAddress(), stage: "closed", backers: [carol.address],
        events: ["NewProject", "SendFunds", "ContractSigned", "ProjectClosed"] };

    // P5 native: vetoed by the DAO while pending
    const p5 = await newProject("P5 veto", true);
    await wait(p5.connect(carol).sendFunds({ value: E(1) }));
    await govern(ecoGov.connect(deployer), [deployer], [await p5.getAddress()],
        [p5.interface.encodeFunctionData("daoVeto")], "E2E: veto P5");
    manifest.projects.p5 = { address: await p5.getAddress(), stage: "closed", backers: [carol.address],
        events: ["NewProject", "SendFunds", "VetoedByDao"] };

    // REP from economy activity (outside any proposal)
    await wait(repClaim.connect(bob).claim());
    manifest.daos.economy.members[bob.address] = (await ecoToken.balanceOf(bob.address)).toString();

    manifest.finalBlock = await ethers.provider.getBlockNumber();
    const file = path.join(__dirname, "out", "manifest.json");
    fs.writeFileSync(file, JSON.stringify(manifest, (k, v) => typeof v === "bigint" ? v.toString() : v, 2));
    console.log(`Done at block ${manifest.finalBlock}. Manifest: ${file}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
