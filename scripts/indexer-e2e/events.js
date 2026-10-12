// Indexer end-to-end, phase B: emit every DAO and trustless event type the indexer should capture,
// and record what happened in out/manifest.json for verify.py.
//   npx hardhat run scripts/indexer-e2e/events.js --network localhost
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const dep = require("./out/deployment.json");
const manifest = { daos: {}, projects: {} };

const wait = async (txPromise) => (await txPromise).wait();
const eventArgs = (receipt, name) => receipt.logs.find(l => l.eventName === name)?.args;
async function advance(seconds) {
    await network.provider.send("evm_increaseTime", [Number(seconds)]);
    await network.provider.send("evm_mine");
}

// propose -> vote -> queue -> execute through a HomebaseDAO governor
async function govern(governor, voters, targets, calldatas, description) {
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

async function main() {
    const [deployer, alice, bob, carol, contractor, arbiter] = await ethers.getSigners();
    const E = (n) => ethers.parseEther(String(n));

    // ---------------- DAO side ----------------
    // 1. Standard (non-transferable) DAO: delegation, a full proposal that edits the registry
    const std = await ethers.getContractAt("StandardFactory", dep.wrapper);
    let r = await wait(std.deployDAOwithToken({
        name: "E2E Standard", symbol: "STD", description: "standard dao", decimals: 18, executionDelay: 60,
        initialMembers: [alice.address, bob.address], initialAmounts: [E(600), E(400), 0, 1, 0, 4],
        keys: ["e2e.key"], values: ["v1"],
    }));
    let created = eventArgs(r, "NewDaoCreated");
    const stdGov = await ethers.getContractAt("HomebaseDAO", created.dao);
    const stdToken = await ethers.getContractAt("RepToken", created.token);
    const stdRegistry = await ethers.getContractAt("Registry", created.registry);
    await wait(stdToken.connect(alice).delegate(alice.address));
    await wait(stdToken.connect(bob).delegate(alice.address));
    const stdProposal = await govern(stdGov.connect(alice), [alice], [created.registry],
        [stdRegistry.interface.encodeFunctionData("editRegistry", ["e2e.key", "v2"])], "E2E: edit registry");
    manifest.daos.standard = { dao: created.dao, token: created.token, registryAddress: created.registry,
        members: { [alice.address]: E(600).toString(), [bob.address]: E(400).toString() },
        delegates: { [alice.address]: alice.address, [bob.address]: alice.address },
        votingWeights: { [alice.address]: E(1000).toString() },
        proposals: { [stdProposal.toString()]: { state: "Executed", forVotes: E(1000).toString() } },
        registryValues: { "e2e.key": "v2" } };

    // 2. Transferable DAO: a token transfer between members
    const stdT = await ethers.getContractAt("StandardFactoryTransferable", dep.wrapper_t);
    r = await wait(stdT.deployDAOwithToken({
        name: "E2E Transferable", symbol: "TRF", description: "transferable dao", decimals: 18, executionDelay: 60,
        initialMembers: [alice.address, bob.address], initialAmounts: [E(100), E(100), 0, 1, 0, 4],
        keys: [], values: [],
    }));
    created = eventArgs(r, "NewDaoCreated");
    const trfToken = await ethers.getContractAt("RepToken", created.token);
    await wait(trfToken.connect(alice).transfer(carol.address, E(30)));
    manifest.daos.transferable = { dao: created.dao, token: created.token,
        members: { [alice.address]: E(70).toString(), [bob.address]: E(100).toString(), [carol.address]: E(30).toString() } };

    // 3. Wrapped-token DAO: wrap an existing ERC20
    const underlying = await (await ethers.getContractFactory("TestERC20")).deploy("Underlying", "UND", 18, E(1000));
    await underlying.waitForDeployment();
    const stdW = await ethers.getContractAt("StandardFactoryWrapped", dep.wrapper_w);
    r = await wait(stdW.deployDAOwithWrappedToken({
        name: "E2E Wrapped", symbol: "wUND", description: "wrapped dao", executionDelay: 60,
        underlyingTokenAddress: await underlying.getAddress(), governanceSettings: [0, 1, 0, 4],
        keys: [], values: [], transferrableStr: "false",
    }));
    created = eventArgs(r, "NewDaoCreated") ?? {};
    const wrappedInfo = eventArgs(r, "DaoWrappedDeploymentInfo");
    const wrappedToken = created.token ?? wrappedInfo?.wrappedTokenAddress;
    if (wrappedToken) {
        const wTok = await ethers.getContractAt("WrappedRepToken", wrappedToken);
        await wait(underlying.approve(wrappedToken, E(50)));
        await wait(wTok.depositFor(deployer.address, E(50)));
    }
    manifest.daos.wrapped = { dao: created.dao ?? wrappedInfo?.daoAddress, token: wrappedToken,
        members: { [deployer.address]: E(50).toString() } };

    // 4. Economy DAO through the 3-step TrustlessFactory flow
    const tf = await ethers.getContractAt("TrustlessFactory", dep.wrapper_trustless);
    const infraEv = eventArgs(await wait(tf.deployInfrastructure(1, 500)), "InfrastructureDeployed");
    const tokEv = eventArgs(await wait(tf.deployDAOToken(infraEv.registry, infraEv.timelock,
        { name: "E2E Economy", symbol: "ECO", initialMembers: [deployer.address, alice.address], initialAmounts: [E(1000), E(500)] },
        { name: "E2E Economy DAO", votingDelay: 0, votingPeriod: 1, proposalThreshold: 0, quorumFraction: 4 })), "DAOTokenDeployed");
    const usdc = await (await ethers.getContractFactory("TestERC20")).deploy("Test USDC", "USDC", 6, 10n ** 15n);
    await usdc.waitForDeployment();
    const usdcAddr = await usdc.getAddress();
    const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    await wait(tf.configureAndFinalize(
        { implAddresses: [dep.nativeProjectImpl, dep.erc20ProjectImpl],
          contractAddresses: [infraEv.economy, infraEv.registry, infraEv.timelock, tokEv.repToken, tokEv.dao] },
        { arbitrationFeeBps: 500, initialPlatformFeeBps: 100, initialAuthorFeeBps: 100, initialCoolingOffPeriod: 0,
          initialBackersQuorumBps: 7000, initialProjectThreshold: 0, initialAppealPeriod: 86400 },
        [`jurisdiction.parity.${NATIVE.toLowerCase()}`, `jurisdiction.parity.${usdcAddr.toLowerCase()}`],
        [E(1).toString(), (10n ** 30n).toString()]));
    const economy = await ethers.getContractAt("Economy", infraEv.economy);
    const ecoGov = await ethers.getContractAt("HomebaseDAO", tokEv.dao);
    const ecoToken = await ethers.getContractAt("RepToken", tokEv.repToken);
    await wait(ecoToken.connect(deployer).delegate(deployer.address));
    await wait(ecoToken.connect(alice).delegate(alice.address));
    manifest.daos.economy = { dao: tokEv.dao, token: tokEv.repToken, registryAddress: infraEv.registry, economy: infraEv.economy,
        members: { [deployer.address]: E(1000).toString(), [alice.address]: E(500).toString() },
        votingWeights: { [deployer.address]: E(1000).toString(), [alice.address]: E(500).toString() } };

    // ---------------- Trustless side ----------------
    const coolingOff = async () => advance(Number(await economy.effectiveCoolingOffPeriod()) + 1);
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
    await advance(86401);
    await wait(p2.finalizeArbitration());
    await wait(p2.connect(contractor).withdrawAsContractor());
    await wait(p2.connect(bob).withdrawAsContributor());
    manifest.projects.p2 = { address: await p2.getAddress(), stage: "closed", backers: [bob.address, carol.address],
        disputeResolution: 60,
        events: ["NewProject", "SetParties", "SendFunds", "ContractSigned", "BackerVoteCast", "ProjectDisputed",
                 "ArbitrationDecision", "ArbitrationFinalized", "ProjectClosed", "ContractorPaid", "AuthorPaid", "ContributorWithdrawn"] };

    // P3 native: contractor disputes, arbiter rules, a DAO member appeals, the DAO overrules
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
    await wait(p3.connect(deployer).appeal(appealId, [await p3.getAddress()]));
    await advance(Number(await ecoGov.votingDelay()) + 1);
    await wait(ecoGov.connect(deployer).castVote(appealId, 1));
    await advance(Number(await ecoGov.votingPeriod()) + 1);
    await wait(ecoGov.queue([await p3.getAddress()], [0], [overrule], ethers.id(desc)));
    await advance(61); // economy timelock delay is 1 minute
    await wait(ecoGov.execute([await p3.getAddress()], [0], [overrule], ethers.id(desc)));
    manifest.projects.p3 = { address: await p3.getAddress(), stage: "closed", backers: [bob.address], disputeResolution: 30,
        events: ["NewProject", "SendFunds", "ContractSigned", "ProjectDisputed", "ArbitrationDecision",
                 "ArbitrationAppealed", "DaoOverruled", "ProjectClosed"] };

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
    await wait(ecoToken.connect(bob).claimReputationFromEconomy());
    manifest.daos.economy.members[bob.address] = (await ecoToken.balanceOf(bob.address)).toString();

    manifest.finalBlock = await ethers.provider.getBlockNumber();
    const file = path.join(__dirname, "out", "manifest.json");
    fs.writeFileSync(file, JSON.stringify(manifest, (k, v) => typeof v === "bigint" ? v.toString() : v, 2));
    console.log(`Done at block ${manifest.finalBlock}. Manifest: ${file}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
