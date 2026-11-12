// Deploy the jurisdiction suite to Etherlink Shadownet (ets, chainId 127823) or a local node (31337):
// JurisdictionFactory and its sub-factories, the project implementations, the module catalog and
// processor, and the module setups (economy, content_court, autonet) with version 1.1 of each
// published in the catalog (docs/modules.md). Everything is fresh; sequential nonces from one key.
//
// Firestore fields (contracts/<network>):
//   jurisdictionFactory  the core factory (the indexer watches its NewDaoCreated)
//   moduleCatalog        modules, versions and metadata (werule lists modules from it)
//   moduleProcessor      builds attach/detach proposals
//   nativeProject, erc20Project   project implementations (the economy setup also holds them)
//
// Writes deployments/<etherlink-shadownet|localhost>-jurisdiction.json, and merges the addresses into
// the werule indexer's network file deployments/networks/<Name>.json (scripts/lib/network-file.js),
// with fromBlock = the block this deploy started at, and publishes that file to R2 (Shadownet only; see
// scripts/lib/network-file.js for the keys).
//   npx hardhat run scripts/deploy-jurisdiction-suite.js --network ets
// CURATOR (optional): address that maintains the catalog and repos; default the deployer.
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const { deployJurisdictionSuite, MODULES } = require("./lib/modules");
const { writeNetworkFile, publishNetworkFile } = require("./lib/network-file");

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const local = net.chainId === 31337n;
  if (net.chainId !== 127823n && !local) {
    throw new Error(`Wrong network: expected chainId 127823 (shadownet) or 31337, got ${net.chainId}`);
  }
  console.log(`Jurisdiction suite on chain ${net.chainId}, deployer ${deployer.address}`);
  console.log(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))}\n`);

  const fromBlock = (await ethers.provider.getBlockNumber()) + 1;
  const s = await deployJurisdictionSuite(ethers, deployer, { log: console.log, curator: process.env.CURATOR || undefined });
  const addr = (c) => c.getAddress();
  const out = {
    network: local ? "localhost" : "Etherlink-Shadownet",
    chainId: Number(net.chainId),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    firestoreFields: {
      jurisdictionFactory: await addr(s.jurisdictionFactory),
      moduleCatalog: await addr(s.catalog),
      moduleProcessor: await addr(s.processor),
      nativeProject: await addr(s.nativeProject),
      erc20Project: await addr(s.erc20Project),
    },
    factories: {
      infrastructureFactory: await addr(s.infrastructureFactory),
      daoFactory: await addr(s.daoFactory),
      repTokenFactory: await addr(s.repTokenFactory),
    },
    modules: {},
  };
  for (const name of MODULES) {
    out.modules[name] = { setup: await addr(s.setups[name]), repo: await addr(s.repos[name]), version: "1.1" };
  }

  const file = path.join(__dirname, "..", "deployments", `${local ? "localhost" : "etherlink-shadownet"}-jurisdiction.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("\nFirestore fields:");
  for (const [k, v] of Object.entries(out.firestoreFields)) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`Saved ${file}`);
  const netFile = writeNetworkFile({
    chainId: net.chainId, hardhatUrl: hre.network.config.url, fromBlock,
    fields: { ...out.firestoreFields, ...out.factories,
              ...Object.fromEntries(MODULES.map((m) => [`${m}Setup`, out.modules[m].setup])) },
  });
  console.log(`Network file ${netFile}`);
  publishNetworkFile(netFile);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
