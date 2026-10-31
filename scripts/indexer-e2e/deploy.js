// Indexer end-to-end, phase A: deploy the jurisdiction suite to a local node and record addresses.
//   npx hardhat run scripts/indexer-e2e/deploy.js --network localhost
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deployJurisdictionSuite, MODULES } = require("../lib/modules");

async function main() {
    const [deployer] = await ethers.getSigners();
    const s = await deployJurisdictionSuite(ethers, deployer);
    const addr = (c) => c.getAddress();
    // Everything here is seeded into contracts/Localhost; the indexer watches jurisdictionFactory
    const out = {
        rpc: process.env.E2E_RPC_URL || "http://127.0.0.1:8545",
        chainId: 31337,
        jurisdictionFactory: await addr(s.jurisdictionFactory),
        moduleCatalog: await addr(s.catalog),
        moduleProcessor: await addr(s.processor),
        nativeProject: await addr(s.nativeProject),
        erc20Project: await addr(s.erc20Project),
        nativeCurrency: "ETH", symbol: "ETH", blockExplorer: "",
    };
    for (const name of MODULES) out[`${name}Setup`] = await addr(s.setups[name]);
    const file = path.join(__dirname, "out", "deployment.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
