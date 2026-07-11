// Deploy the CoinOffering stack to BASE SEPOLIA (chainId 84532) using the
// current mint-on-demand model (no pre-minted inventory; CO has minter role and
// a DAO-set saleCap). Writes a deployment record AND the boats frontend config
// (boats/web/co_config.js) pointed at Base Sepolia, so the hosted site talks to
// a real, reachable chain.
//
// The payment token is our own mintable test USDC; anyone can mint it (the app
// exposes a hidden /faucet route), so testers don't need a real-USDC faucet.
//
// Prereq: the deployer (SEPOLIA_PRIVATE_KEY account) must hold Base Sepolia ETH.
// Run: npx hardhat run scripts/deployTestCOBaseSepolia.js --network baseSepolia
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const bal = await ethers.provider.getBalance(deployer.address);

  console.log(`\n=== CO Base Sepolia deploy (chainId ${net.chainId}) ===`);
  console.log("Deployer:", deployer.address);
  console.log("Balance :", ethers.formatEther(bal), "ETH");
  if (bal === 0n) {
    throw new Error("Deployer has 0 ETH on Base Sepolia. Fund it from a faucet first.");
  }

  // On a live testnet we only control the deployer key. The execution-team
  // delegate is just an address to auto-delegate buyers to; derive one
  // deterministically so it's recorded but not a live signer here.
  const execDelegate = deployer.address; // delegate to the deployer for the demo

  // Registry (treasury + spend guard). constructor(owner, wrapper).
  console.log("\n[1] Registry...");
  const Registry = await ethers.getContractFactory("Registry");
  const registry = await Registry.deploy(deployer.address, deployer.address);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("    ", registryAddr);

  // ATNB = transferable RepToken.
  // constructor(name,symbol,registry,timelock,members,amounts,transferable)
  console.log("\n[2] ATNB (transferable RepToken)...");
  const RepToken = await ethers.getContractFactory("RepToken");
  const atnb = await RepToken.deploy(
    "Autonet Boats", "ATNB", registryAddr, deployer.address, [], [], true
  );
  await atnb.waitForDeployment();
  const atnbAddr = await atnb.getAddress();
  console.log("    ", atnbAddr);

  // Test USDC (6 decimals). Public mint() => doubles as the faucet token.
  console.log("\n[3] Test USDC (6 dec, public mint)...");
  const TestERC20 = await ethers.getContractFactory("TestERC20");
  const usdc = await TestERC20.deploy("USD Coin (Test)", "USDC", 6, 0);
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  console.log("    ", usdcAddr);

  // CoinOffering. constructor(atnb, registry, admin).
  console.log("\n[4] CoinOffering...");
  const CO = await ethers.getContractFactory("CoinOffering");
  const co = await CO.deploy(atnbAddr, registryAddr, deployer.address);
  await co.waitForDeployment();
  const coAddr = await co.getAddress();
  console.log("    ", coAddr);

  // Wire: parity (18-dec convention; 1 USDC -> 2 ATNB => 2e18 * 1e12 = 2e30),
  // jurisdiction (authorizes the dividend path), default delegate, CO minter
  // role, and the fundraising cap (the goal). No pre-minted inventory.
  console.log("\n[5] Wiring...");
  const PARITY = ethers.parseEther("2") * (10n ** 12n); // 2e30
  const parityKey = `jurisdiction.parity.${usdcAddr.toLowerCase()}`;
  await (await registry.editRegistry(parityKey, PARITY.toString())).wait();
  await (await registry.setJurisdictionAddress(atnbAddr)).wait();
  await (await atnb.setDefaultDelegate(execDelegate)).wait();
  await (await atnb.setMinter(coAddr, true)).wait();
  await (await co.setSaleCap(ethers.parseEther("1000000"))).wait(); // goal: 1,000,000 ATNB
  console.log("     parity set, jurisdiction set, defaultDelegate set, CO minter granted, saleCap 1,000,000");

  console.log("\nDeployed:");
  console.log("  Registry    :", registryAddr);
  console.log("  ATNB        :", atnbAddr);
  console.log("  USDC (test) :", usdcAddr);
  console.log("  CoinOffering:", coAddr);

  // Deployment record.
  const out = {
    network: "Base Sepolia",
    chainId: Number(net.chainId),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: { registry: registryAddr, atnb: atnbAddr, usdc: usdcAddr, coinOffering: coAddr },
    config: { parityKey, parity: PARITY.toString(), executionDelegate: execDelegate },
  };
  const outPath = path.join(__dirname, "..", "deployments", "base-sepolia-co.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("\nWrote", outPath);

  // Single source of truth = Firestore. The boats app fetches this doc at
  // startup, so the build carries NO chain config and can never go stale or
  // accidentally ship local-Hardhat addresses. No co_config.js is generated.
  const chainIdHex = "0x" + Number(net.chainId).toString(16);
  const coConfig = {
    chainId: Number(net.chainId),
    chainIdHex,
    rpcUrl: "https://sepolia.base.org",
    chainName: "Base Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    blockExplorerUrls: ["https://sepolia.basescan.org"],
    contracts: { coinOffering: coAddr, atnb: atnbAddr, usdc: usdcAddr, registry: registryAddr },
    updatedAt: new Date().toISOString(),
  };

  // Write to the boats Firebase project (autoboats-24866) at config/coin_offering.
  // The service-account key lives on D: (a different drive from this repo on C:),
  // so use an absolute path. Override with env BOATS_SA_KEY if it ever moves.
  const KEY_PATH = process.env.BOATS_SA_KEY ||
    "D:/videos/SF/manifesting/from_now/autoboats-24866.json";
  try {
    const admin = require("firebase-admin");
    const serviceAccount = require(KEY_PATH);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    const db = admin.firestore();
    // Write under setup/ — that collection is public-readable (same as the
    // story title). The config/ collection is blocked by security rules.
    await db.collection("setup").doc("coin_offering").set(coConfig);
    console.log("Wrote Firestore setup/coin_offering (autoboats-24866). The app reads this at startup.");
  } catch (e) {
    console.log("(could not write Firestore config:", e.message, ")");
    console.log("Service account expected at:", KEY_PATH);
    console.log("Paste-ready config:\n" + JSON.stringify(coConfig, null, 2));
  }

  console.log("\n=== DONE ===");
  console.log("Test USDC is mintable by anyone via mint(to, amount) — wired to the app's /faucet route.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
