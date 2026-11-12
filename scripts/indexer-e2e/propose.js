// Edge e2e helper: one new proposal on a DAO, by the deployer (a member of the e2e economy DAO), so a
// reader can watch it arrive as a push. Never the main local chain: run with E2E_RPC_URL set.
//   EDGE_E2E_DAO=0x... E2E_RPC_URL=http://127.0.0.1:8546 npx hardhat run scripts/indexer-e2e/propose.js --network localhost
const { ethers } = require("hardhat");

async function main() {
    if (!process.env.E2E_RPC_URL) throw new Error("set E2E_RPC_URL to the e2e node");
    const dao = process.env.EDGE_E2E_DAO;
    if (!dao) throw new Error("set EDGE_E2E_DAO");
    const [deployer] = await ethers.getSigners();
    const governor = await ethers.getContractAt("HomebaseDAO", dao);
    const token = await governor.token();
    const description = `Edge push check ${Date.now()}`;
    const tx = await governor.connect(deployer).propose([token], [0], ["0x"], description);
    await tx.wait();
    console.log(`proposed on ${dao}: ${description}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
