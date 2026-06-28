// Self-contained shadownet validation of the CoinOffering + Registry spend-guard
// + RepToken defaultDelegate/exemption. Deploys a minimal, isolated set (does NOT
// touch the existing shadownet jurisdiction) and exercises the full flow:
//   mint ATNB -> CO (exempt, no votes) -> buyer buys -> payment routed to Registry
//   treasury -> buyer auto-delegated to execution delegate -> buyer reclaims vote
//   -> arm spend cap -> treasury outflow under cap passes, over cap reverts.
//
// Run: npx hardhat run scripts/deployTestCOShadownet.js --network ets
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

function ok(cond, msg) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("   ok:", msg);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`\n=== CO/guard shadownet validation ===`);
  console.log("Network chainId:", net.chainId.toString());
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // We use the deployer as: admin/timelock stand-in, and derive a couple of
  // deterministic test identities for execution-delegate and buyer. On a live
  // testnet we can't getSigners() for arbitrary accounts, so the buyer flow is
  // driven from the deployer acting as buyer (sufficient to validate mechanics).
  const execDelegate = ethers.Wallet.createRandom().address; // just an address to delegate to
  console.log("Execution delegate (target):", execDelegate);

  // 1. Registry (treasury + guard). constructor(owner, wrapper).
  console.log("\n[1] Deploying Registry (with spend-guard)...");
  const Registry = await ethers.getContractFactory("Registry");
  const registry = await Registry.deploy(deployer.address, deployer.address);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("   Registry:", registryAddr);

  // 2. ATNB = transferable RepToken. constructor(name,symbol,registry,timelock,members,amounts,transferable)
  console.log("\n[2] Deploying ATNB (transferable RepToken)...");
  const RepToken = await ethers.getContractFactory("RepToken");
  const atnb = await RepToken.deploy(
    "Autonet Boats", "ATNB", registryAddr, deployer.address, [], [], true
  );
  await atnb.waitForDeployment();
  const atnbAddr = await atnb.getAddress();
  console.log("   ATNB:", atnbAddr);

  // 3. Test USDC (6-decimal payment token).
  console.log("\n[3] Deploying test USDC (6 dec)...");
  const TestERC20 = await ethers.getContractFactory("TestERC20");
  const usdc = await TestERC20.deploy("USD Coin", "USDC", 6, 0);
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  console.log("   USDC:", usdcAddr);

  // 4. CoinOffering. constructor(atnb, registry, admin).
  console.log("\n[4] Deploying CoinOffering...");
  const CO = await ethers.getContractFactory("CoinOffering");
  const co = await CO.deploy(atnbAddr, registryAddr, deployer.address);
  await co.waitForDeployment();
  const coAddr = await co.getAddress();
  console.log("   CO:", coAddr);

  // 5. Wire: parity (18-dec convention; 1 USDC -> 2 ATNB => 2e18 * 1e12 = 2e30),
  //    default delegate, exempt the CO inventory, mint inventory to CO.
  console.log("\n[5] Wiring...");
  const PARITY = ethers.parseEther("2") * (10n ** 12n); // 2e30
  const parityKey = `jurisdiction.parity.${usdcAddr.toLowerCase()}`;
  await (await registry.editRegistry(parityKey, PARITY.toString())).wait();
  await (await atnb.setDefaultDelegate(execDelegate)).wait();
  await (await atnb.setAutoDelegateExempt(coAddr, true)).wait();
  await (await atnb.mint(coAddr, ethers.parseEther("1000000"))).wait();
  console.log("   parity set, defaultDelegate set, CO exempt, 1,000,000 ATNB minted to CO");

  // Inventory must NOT carry votes for the execution delegate.
  ok((await atnb.getVotes(execDelegate)) === 0n, "CO inventory does not auto-delegate (exempt)");

  // 6. Buyer flow (deployer acts as buyer).
  console.log("\n[6] Buy flow (deployer as buyer)...");
  await (await usdc.mint(deployer.address, ethers.parseUnits("10000", 6))).wait();
  await (await usdc.approve(coAddr, ethers.MaxUint256)).wait();

  const pay = ethers.parseUnits("500", 6); // 500 USDC
  const expectedAtnb = ethers.parseEther("1000"); // 500 * 2
  const treasuryBefore = await usdc.balanceOf(registryAddr);
  await (await co.buy(usdcAddr, pay)).wait();

  ok((await atnb.balanceOf(deployer.address)) === expectedAtnb, "buyer received 1000 ATNB");
  ok((await usdc.balanceOf(registryAddr)) === treasuryBefore + pay, "payment routed to Registry treasury");
  ok((await usdc.balanceOf(coAddr)) === 0n, "CO holds no cash");
  ok((await atnb.delegates(deployer.address)) === execDelegate, "buyer auto-delegated to execution delegate");
  ok((await atnb.getVotes(execDelegate)) === expectedAtnb, "execution delegate holds buyer's votes");

  // 7. Reclaim (werule.io flow).
  console.log("\n[7] Reclaim vote...");
  await (await atnb.delegate(deployer.address)).wait();
  ok((await atnb.getVotes(execDelegate)) === 0n, "execution delegate lost votes after reclaim");
  ok((await atnb.getVotes(deployer.address)) === expectedAtnb, "buyer self-holds votes after reclaim");

  // 8. Spend guard: arm a cap on USDC and test under/over.
  console.log("\n[8] Treasury spend-guard...");
  // Move Registry ownership flow isn't needed: deployer is owner (== _treasuryOps).
  const cap = ethers.parseUnits("300", 6);
  await (await registry.setSpendCap(usdcAddr, cap)).wait();
  // Under cap: transfer 200 USDC out — should pass.
  await (await registry.transferERC20(usdcAddr, deployer.address, ethers.parseUnits("200", 6))).wait();
  console.log("   ok: 200 USDC outflow under 300 cap passed");
  // Over remaining cap: transfer another 200 (total 400 > 300) — should revert.
  let reverted = false;
  try {
    await (await registry.transferERC20(usdcAddr, deployer.address, ethers.parseUnits("200", 6))).wait();
  } catch (e) { reverted = true; }
  ok(reverted, "outflow exceeding window cap reverted");

  // 9. Save deployment record.
  const out = {
    network: "Etherlink-Shadownet",
    chainId: Number(net.chainId),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: { registry: registryAddr, atnb: atnbAddr, usdc: usdcAddr, coinOffering: coAddr },
    config: { parityKey, parity: PARITY.toString(), executionDelegate: execDelegate },
  };
  const outPath = path.join(__dirname, "..", "deployments", "etherlink-shadownet-co.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("\n=== ALL CHECKS PASSED ===");
  console.log("Saved:", outPath);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
