// UI write-flow setup on a fresh chain (no time travel, so chain time matches the browser clock):
// an economy DAO for trustless flows and a standard DAO with an open proposal for werule voting.
// Writes out/ui.json.   npx hardhat run scripts/indexer-e2e/ui_setup.js --network localhost
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { wait, createJurisdiction } = require("./jurisdiction");
const dep = require("./out/deployment.json");

const eventArgs = (r, name) => r.logs.find(l => l.eventName === name)?.args;
const E = (n) => ethers.parseEther(String(n));

async function main() {
    const [deployer, alice] = await ethers.getSigners();
    const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

    const eco = await createJurisdiction(dep, {
        name: "UI Economy", symbol: "UIE", members: [deployer.address, alice.address], amounts: [E(1000), E(500)],
        modules: { economy: { params: { arbitrationFeeBps: 500, platformFeeBps: 100, authorFeeBps: 100, coolingOffPeriod: 0,
            backersQuorumBps: 7000, projectThreshold: 0, appealPeriod: 86400 } } },
        keys: [`jurisdiction.parity.${NATIVE.toLowerCase()}`], values: [E(1).toString()],
    });
    const ecoToken = await ethers.getContractAt("RepToken", eco.core.token);
    await wait(ecoToken.connect(deployer).delegate(deployer.address));

    const std = await createJurisdiction(dep, {
        name: "UI Standard", symbol: "UIS", description: "ui standard dao", votingPeriod: 30,
        members: [deployer.address, alice.address], amounts: [E(600), E(400)],
    });
    const stdToken = await ethers.getContractAt("RepToken", std.core.token);
    await wait(stdToken.connect(deployer).delegate(deployer.address));
    await wait(stdToken.connect(alice).delegate(alice.address));
    const registry = await ethers.getContractAt("Registry", std.core.registry);
    await ethers.provider.send("evm_mine", []);
    const pr = await wait(std.governor.connect(alice).propose([std.core.registry], [0],
        [registry.interface.encodeFunctionData("editRegistry", ["ui.key", "voted"])], "UI: vote on me"));
    const proposalId = eventArgs(pr, "ProposalCreated").proposalId.toString();

    const out = { economy: eco.installs.economy.module, economyDao: eco.core.governor, standardDao: std.core.governor, proposalId };
    fs.writeFileSync(path.join(__dirname, "out", "ui.json"), JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
