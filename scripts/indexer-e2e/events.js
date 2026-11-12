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
// A project doc as the indexer wrote it to its document store (E2E_STORE), or null
const { execFileSync } = require("child_process");
const READ_DOC = "import sqlite3,sys\nr=sqlite3.connect(sys.argv[1]).execute('SELECT data FROM docs WHERE path=?',(sys.argv[2],)).fetchone()\nprint(r[0] if r else 'null')";
async function projectDoc(dao, project) {
    const store = process.env.E2E_STORE;
    if (!store) throw new Error("E2E_STORE is not set");
    const out = execFileSync("python", ["-c", READ_DOC, store, `idaosLocalhost/${dao}/projects/${project.toLowerCase()}`]);
    return JSON.parse(out.toString());
}
// Mines blocks (so the indexer keeps going) until the project doc satisfies [test], or fails
async function untilProject(dao, project, test, what) {
    for (let i = 0; i < 120; i++) {
        if (test(await projectDoc(dao, project))) return;
        await network.provider.send("evm_mine");
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`indexer never ${what}`);
}

// The indexer also registers a veto or overrule on the project so it holds; wait for that before
// voting, or the registration can land after the vote is over and revert
async function untilHeld(project, proposalId, what) {
    for (let i = 0; i < 60; i++) {
        if ((await project.queryFilter(project.filters.DaoProposalRegistered(proposalId))).length > 0) return;
        await network.provider.send("evm_mine");
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`indexer never registered ${what} on the project`);
}

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
        members: [alice.address, bob.address], amounts: [E(600), E(400)], supermajorityBps: 7500,
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
    // A project made while the economy is attached stays under the DAO after the detach
    const stdEco = await ethers.getContractAt("Economy", stdEconomy.module);
    const p0 = eventArgs(await wait(stdEco.connect(alice).createProject("P0 before detach", ethers.ZeroAddress, ethers.ZeroAddress,
        "terms", "https://github.com/e2e/repo", "desc")), "NewProject").contractAddress;
    const [detachTargets, , detachCalls] = await processor.uninstallCalls(stdSetup, stdEconomy.id);
    await govern(stdGov.connect(alice), [alice], detachTargets, detachCalls, "E2E: detach the economy");
    manifest.daos.standard = { dao: j.core.governor, token: j.core.token, registryAddress: j.core.registry,
        members: { [alice.address]: E(600).toString(), [bob.address]: E(400).toString() },
        delegates: { [alice.address]: alice.address, [bob.address]: alice.address },
        votingWeights: { [alice.address]: E(1000).toString() },
        proposals: { [stdProposal.toString()]: { state: "Executed", forVotes: E(1000).toString(), supermajorityBps: null } },
        fields: { supermajorityBps: "7500" },
        registryValues: { "e2e.key": "v2", "jurisdiction.economy": "", "modules.economy": "" },
        economyDetached: stdEconomy.module, projects: { [p0]: { stage: "open", economy: stdEconomy.module } } };

    // 2. The economy attached to a live DAO by proposal
    j = await createJurisdiction(dep, {
        name: "E2E Attach", symbol: "ATT", description: "economy attached later",
        members: [alice.address, bob.address], amounts: [E(100), E(100)],
    });
    const attToken = await ethers.getContractAt("RepToken", j.core.token);
    await wait(attToken.connect(alice).delegate(alice.address));
    await wait(attToken.connect(bob).delegate(bob.address));
    const attEconomy = await prepare(dep, j.core, "economy", ECONOMY);
    const [attTargets, , attCalls] = await processor.installCalls(await attEconomy.setup.getAddress(), attEconomy.id);
    // Attaching a module to a live DAO grants token rights, so it is constitutional
    const attAttach = await govern(j.governor.connect(alice), [alice, bob], attTargets, attCalls, "E2E: add the economy");
    manifest.daos.attached = { dao: j.core.governor, token: j.core.token, economy: attEconomy.module,
        members: { [alice.address]: E(100).toString(), [bob.address]: E(100).toString() },
        registryValues: { "jurisdiction.economy": attEconomy.module.toLowerCase() },
        proposals: { [attAttach.toString()]: { state: "Executed", forVotes: E(200).toString(), supermajorityBps: "6667" } } };

    // 4. Economy DAO: the economy module attached at origination, parities recorded by finalize
    const usdc = await (await ethers.getContractFactory("TestERC20")).deploy("Test USDC", "USDC", 6, 10n ** 15n);
    await usdc.waitForDeployment();
    const usdcAddr = await usdc.getAddress();
    const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    j = await createJurisdiction(dep, {
        name: "E2E Economy", symbol: "ECO", members: [deployer.address, alice.address], amounts: [E(1000), E(500)], supermajorityBps: 6000,
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
    await untilHeld(p3, appealId, "the P3 overrule");
    console.log("indexer registered the P3 overrule on the project");
    await advance(Number(await ecoGov.votingDelay()) + 1);
    await wait(ecoGov.connect(deployer).castVote(appealId, 1));
    await advance(Number(await ecoGov.votingPeriod()) + 1);
    await wait(ecoGov.queue([await p3.getAddress()], [0], [overrule], ethers.id(desc)));
    await advance(61); // economy timelock delay is 1 minute
    await wait(ecoGov.execute([await p3.getAddress()], [0], [overrule], ethers.id(desc)));
    manifest.projects.p3 = { address: await p3.getAddress(), stage: "closed", backers: [bob.address], disputeResolution: 30,
        appealProposalId: appealId.toString(), appealProposals: [appealId.toString()],
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
    const vetoId = await govern(ecoGov.connect(deployer), [deployer], [await p5.getAddress()],
        [p5.interface.encodeFunctionData("daoVeto")], "E2E: veto P5");
    manifest.projects.p5 = { address: await p5.getAddress(), stage: "closed", backers: [carol.address],
        vetoProposals: [vetoId.toString()], vetoProposalId: vetoId.toString(),
        events: ["NewProject", "SendFunds", "VetoedByDao"] };

    // P6 native: an appeal made the way werule makes it (type "appeal") that the DAO votes down;
    // the indexer unlinks it so the app offers Appeal again
    const p6 = await newProject("P6 failed appeal", true);
    const p6Addr = await p6.getAddress();
    await wait(p6.connect(bob).sendFunds({ value: E(1) }));
    await coolingOff();
    await wait(p6.connect(contractor).signContract({ value: await stakeFor(p6) }));
    await wait(p6.connect(contractor).disputeAsContractor());
    await wait(p6.connect(arbiter).arbitrate(70, "ruling-p6"));
    const overrule6 = p6.interface.encodeFunctionData("daoOverrule", [10, "dao-ruling-p6"]);
    const desc6 = "Appeal: P6 failed appeal0|||0appeal0|||0Overrule P6 to 10%0|||0https://github.com/e2e/repo";
    const failedAppeal = eventArgs(await wait(ecoGov.connect(deployer).propose([p6Addr], [0], [overrule6], desc6)), "ProposalCreated").proposalId;
    const ecoDao = await ecoGov.getAddress();
    await untilProject(ecoDao, p6Addr, (f) => f?.appealProposalId === failedAppeal.toString(), "linked the P6 appeal");
    await untilHeld(p6, failedAppeal, "the P6 appeal");
    await advance(Number(await ecoGov.votingDelay()) + 1);
    await wait(ecoGov.connect(deployer).castVote(failedAppeal, 0));
    await advance(Number(await ecoGov.votingPeriod()) + 1);
    await untilProject(ecoDao, p6Addr, (f) => f && !f.appealProposalId, "cleared the defeated P6 appeal");
    console.log("indexer cleared the defeated P6 appeal");
    manifest.projects.p6 = { address: p6Addr, stage: "appealable", backers: [bob.address],
        appealProposalId: null, appealProposals: [failedAppeal.toString()],
        events: ["NewProject", "SendFunds", "ContractSigned", "ProjectDisputed", "ArbitrationDecision", "ProposalCreated"] };

    // P7 native: a veto made the way werule makes it (type "veto") that the DAO votes down; the
    // indexer links it on the project while it runs, then unlinks it so a new veto can be proposed
    const p7 = await newProject("P7 failed veto", false);
    const p7Addr = await p7.getAddress();
    await wait(p7.connect(carol).sendFunds({ value: E(1) }));
    const veto7 = p7.interface.encodeFunctionData("daoVeto");
    const desc7 = "Veto: P7 failed veto0|||0veto0|||0Close P70|||0https://github.com/e2e/repo";
    const failedVeto = eventArgs(await wait(ecoGov.connect(deployer).propose([p7Addr], [0], [veto7], desc7)), "ProposalCreated").proposalId;
    await untilProject(ecoDao, p7Addr, (f) => f?.vetoProposalId === failedVeto.toString(), "linked the P7 veto");
    // P7 has no parties yet, so there is no signing to hold: the indexer links the veto but can't register it
    if ((await p7.queryFilter(p7.filters.DaoProposalRegistered(failedVeto))).length > 0) throw new Error("P7 veto was registered while Open");
    console.log("indexer linked the P7 veto");
    await advance(Number(await ecoGov.votingDelay()) + 1);
    await wait(ecoGov.connect(deployer).castVote(failedVeto, 0));
    await advance(Number(await ecoGov.votingPeriod()) + 1);
    await untilProject(ecoDao, p7Addr, (f) => f && !f.vetoProposalId, "cleared the defeated P7 veto");
    console.log("indexer cleared the defeated P7 veto");
    manifest.projects.p7 = { address: p7Addr, stage: "open", backers: [carol.address],
        vetoProposalId: null, vetoProposals: [failedVeto.toString()],
        events: ["NewProject", "SendFunds", "ProposalCreated"] };

    // ---------------- Debates ----------------
    // A debate on the Economy DAO's token: opened (root argument), argued, backed and closed
    const debatesFactory = await ethers.getContractAt("DebatesFactory", dep.debatesFactory);
    const debateRc = await wait(debatesFactory.connect(deployer).createDebate(await ecoToken.getAddress(), "E2E debate", "Root thesis", E(10)));
    const debateAddr = eventArgs(debateRc, "DebateCreated").debateAddress;
    const debate = await ethers.getContractAt("Debate", debateAddr);
    await wait(debate.connect(alice).addArgument(1, 1, E(5), "A counterpoint"));
    await wait(debate.connect(deployer).addWeight(1, E(1)));
    await wait(debate.connect(deployer).closeDebate());

    // REP from economy activity (outside any proposal)
    await wait(repClaim.connect(bob).claim());
    manifest.daos.economy.members[bob.address] = (await ecoToken.balanceOf(bob.address)).toString();

    // A constitutional proposal: raising the economy DAO's own supermajority (protected at 6000 of all
    // REP, including what bob claimed and never delegated, so it takes both voters)
    const raiseFor = (await ecoToken.getVotes(deployer.address)) + (await ecoToken.getVotes(alice.address));
    const raise = await govern(ecoGov.connect(deployer), [deployer, alice], [await ecoGov.getAddress()],
        [ecoGov.interface.encodeFunctionData("setSupermajority", [7000])], "E2E: raise the supermajority");
    manifest.daos.economy.proposals = { [raise.toString()]: { state: "Executed", forVotes: raiseFor.toString(), supermajorityBps: "6000" } };
    manifest.daos.economy.fields = { supermajorityBps: "7000" };

    // Every kind of event the economy DAO went through reaches its activity feed
    manifest.daos.economy.activity = ["daoCreated", "mint", "delegate", "registryEdit", "proposalCreated", "vote",
        "proposalQueued", "proposalExecuted", "createProject", "sendFunds", "signContract", "projectDisputed",
        "arbitrate", "daoOverruled", "vetoedByDao", "debateCreated", "debateArgument", "debateWeight", "debateClosed",
        "supermajoritySet"];
    manifest.daos.economy.debates = [debateAddr];

    // ---------------- Autonet ----------------
    // A jurisdiction with the autonet module, and an agent registering on its Substrate
    const CHARTER = '{"axes":[{"id":"correctness","thesis":"Works."},{"id":"simplicity","thesis":"Small."}]}';
    j = await createJurisdiction(dep, {
        name: "E2E Autonet", symbol: "ATJ", members: [deployer.address], amounts: [E(100)],
        modules: { autonet: {
            substrate: { challengeWindow: 3600, charter: CHARTER, epochRules: "2", genesisRoot: ethers.ZeroHash, serviceFeeBps: 250, feeTreasuryBps: 5000 },
            toolBond: { minStake: 100_000_000n, revealWindow: 86400, degradeBps: 1000, authorSlashBps: 10000,
                unbondDelay: 30 * 86400, reviewerShareBps: 4000 },
        } },
        keys: [`jurisdiction.parity.${usdcAddr.toLowerCase()}`], values: [(10n ** 30n).toString()],
    });
    const autonetSetup = await ethers.getContractAt("AutonetSetup", dep.autonetSetup);
    const substrateAddr = (await autonetSetup.deploymentOf(j.installs.autonet.id)).substrate;
    const agent = (await ethers.getSigners())[7]; // not #9, the indexer's relayer
    const owner = new ethers.Wallet(ethers.id("e2e agent owner"));
    const substrate = new ethers.Contract(substrateAddr, require("../../test/fixtures/autonet/Substrate.json").abi, agent);
    // The indexer follows the Substrate once it has indexed the jurisdiction's registry
    await new Promise((r) => setTimeout(r, 8000));
    const binding = owner.signingKey.sign(await substrate.bindingHash(agent.address, ethers.ZeroAddress, 0)).serialized;
    await wait(substrate.registerAgentBound(ethers.toUtf8Bytes("e2e-peer"), owner.address, ethers.ZeroAddress, binding));
    await wait(substrate.updateEndpoint("wss://e2e.example/agent"));
    // Amending the charter is constitutional
    const AMENDED = '{"axes":[{"id":"correctness","thesis":"Works."},{"id":"simplicity","thesis":"Small."},{"id":"care","thesis":"Kind."}]}';
    await wait((await ethers.getContractAt("RepToken", j.core.token)).connect(deployer).delegate(deployer.address));
    const registryA = await ethers.getContractAt("Registry", j.core.registry);
    const amend = await govern(j.governor.connect(deployer), [deployer], [j.core.registry],
        [registryA.interface.encodeFunctionData("editRegistry", ["jurisdiction.autonet.charter", AMENDED])], "E2E: amend the charter");
    manifest.daos.autonet = { dao: j.core.governor, token: j.core.token, registryAddress: j.core.registry,
        registryValues: { "jurisdiction.autonet.substrate": substrateAddr.toLowerCase(), "jurisdiction.autonet.charter": AMENDED },
        proposals: { [amend.toString()]: { state: "Executed", forVotes: E(100).toString(), supermajorityBps: "6667" } },
        fields: { supermajorityBps: "6667" },
        activity: ["daoCreated", "registryEdit", "agentRegistered", "agentBound", "agentEndpoint"],
        agents: [agent.address] };

    manifest.finalBlock = await ethers.provider.getBlockNumber();
    const file = path.join(__dirname, "out", "manifest.json");
    fs.writeFileSync(file, JSON.stringify(manifest, (k, v) => typeof v === "bigint" ? v.toString() : v, 2));
    console.log(`Done at block ${manifest.finalBlock}. Manifest: ${file}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
