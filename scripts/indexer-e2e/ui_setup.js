// UI write-flow setup on a fresh chain (no time travel, so chain time matches the browser clock):
// an economy DAO for trustless flows and a standard DAO with an open proposal for werule voting.
// Writes out/ui.json.   npx hardhat run scripts/indexer-e2e/ui_setup.js --network localhost
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const dep = require("./out/deployment.json");

const wait = async (p) => (await p).wait();
const eventArgs = (r, name) => r.logs.find(l => l.eventName === name)?.args;
const E = (n) => ethers.parseEther(String(n));

async function main() {
    const [deployer, alice] = await ethers.getSigners();
    const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

    const tf = await ethers.getContractAt("TrustlessFactory", dep.wrapper_trustless);
    const infra = eventArgs(await wait(tf.deployInfrastructure(1, 500)), "InfrastructureDeployed");
    const tok = eventArgs(await wait(tf.deployDAOToken(infra.registry, infra.timelock,
        { name: "UI Economy", symbol: "UIE", initialMembers: [deployer.address, alice.address], initialAmounts: [E(1000), E(500)] },
        { name: "UI Economy DAO", votingDelay: 0, votingPeriod: 1, proposalThreshold: 0, quorumFraction: 4 })), "DAOTokenDeployed");
    await wait(tf.configureAndFinalize(
        { implAddresses: [dep.nativeProjectImpl, dep.erc20ProjectImpl],
          contractAddresses: [infra.economy, infra.registry, infra.timelock, tok.repToken, tok.dao] },
        { arbitrationFeeBps: 500, initialPlatformFeeBps: 100, initialAuthorFeeBps: 100, initialCoolingOffPeriod: 0,
          initialBackersQuorumBps: 7000, initialProjectThreshold: 0, initialAppealPeriod: 86400 },
        [`jurisdiction.parity.${NATIVE.toLowerCase()}`], [E(1).toString()]));
    const ecoToken = await ethers.getContractAt("RepToken", tok.repToken);
    await wait(ecoToken.connect(deployer).delegate(deployer.address));

    const std = await ethers.getContractAt("StandardFactory", dep.wrapper);
    const created = eventArgs(await wait(std.deployDAOwithToken({
        name: "UI Standard", symbol: "UIS", description: "ui standard dao", decimals: 18, executionDelay: 60,
        initialMembers: [deployer.address, alice.address], initialAmounts: [E(600), E(400), 0, 30, 0, 4],
        keys: [], values: [],
    })), "NewDaoCreated");
    const stdToken = await ethers.getContractAt("RepToken", created.token);
    await wait(stdToken.connect(deployer).delegate(deployer.address));
    await wait(stdToken.connect(alice).delegate(alice.address));
    const gov = await ethers.getContractAt("HomebaseDAO", created.dao);
    const registry = await ethers.getContractAt("Registry", created.registry);
    await ethers.provider.send("evm_mine", []);
    const pr = await wait(gov.connect(alice).propose([created.registry], [0],
        [registry.interface.encodeFunctionData("editRegistry", ["ui.key", "voted"])], "UI: vote on me"));
    const proposalId = eventArgs(pr, "ProposalCreated").proposalId.toString();

    const out = { economy: infra.economy, economyDao: tok.dao, standardDao: created.dao, proposalId };
    fs.writeFileSync(path.join(__dirname, "out", "ui.json"), JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
