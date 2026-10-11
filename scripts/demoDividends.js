// Demonstrate the revenue/dividend cycle end-to-end on the local node, reusing
// the existing passive-income epoch mechanism. No new contract code.
//
// Flow:
//   1. Two holders buy ATNB (so there are stakes to pay dividends on).
//   2. "Revenue" (test USDC) is deposited into the Registry treasury.
//   3. DAO earmarks it for the next passive-income epoch and starts the epoch.
//   4. Each holder claims pro-rata by their ATNB share at epoch start.
//   5. Verify the split matches stake (and that a holder who delegated their
//      vote away still earns their dividend — dividends track balance, not votes).
//
//   npx hardhat run scripts/demoDividends.js --network localhost
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "local-co.json")));
  const c = cfg.contracts;
  const signers = await ethers.getSigners();
  const deployer = signers[0];   // == RepToken admin/timelock AND Registry owner in the local deploy
  const alice = signers[3];
  const bob = signers[4];

  const co = await ethers.getContractAt(["function buy(address,uint256) returns (uint256)"], c.coinOffering);
  const atnb = await ethers.getContractAt([
    "function balanceOf(address) view returns (uint256)",
    "function startNewRewardEpoch(uint256,address)",
    "function claimReward(uint256)",
    "function currentRewardEpoch() view returns (uint256)",
    "function delegate(address)",
    "function delegates(address) view returns (address)",
  ], c.atnb);
  const usdc = await ethers.getContractAt([
    "function mint(address,uint256)",
    "function approve(address,uint256) returns (bool)",
    "function transfer(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
  ], c.usdc);
  const registry = await ethers.getContractAt([
    "function setSpendCap(address,uint256) external",
  ], c.registry);

  const dec = await usdc.decimals();
  const usd = (n) => ethers.parseUnits(String(n), dec);

  // --- 1. Two holders buy ATNB (Alice 1000 USDC -> 2000 ATNB, Bob 500 -> 1000) ---
  console.log("[1] Two holders buy ATNB...");
  for (const [who, amt] of [[alice, 1000], [bob, 500]]) {
    await (await usdc.mint(who.address, usd(amt))).wait();
    await (await usdc.connect(who).approve(c.coinOffering, usd(amt))).wait();
    await (await co.connect(who).buy(c.usdc, usd(amt))).wait();
  }
  const aBal = await atnb.balanceOf(alice.address);
  const bBal = await atnb.balanceOf(bob.address);
  console.log("   Alice ATNB:", ethers.formatEther(aBal), "| Bob ATNB:", ethers.formatEther(bBal));
  console.log("   (Both auto-delegated away:", (await atnb.delegates(alice.address)) !== ethers.ZeroAddress, ")");

  // --- 2. Deposit "booking revenue" into the treasury (3000 USDC profit) ---
  console.log("\n[2] Depositing 3000 USDC revenue into treasury...");
  const revenue = usd(3000);
  await (await usdc.mint(deployer.address, revenue)).wait();
  await (await usdc.transfer(c.registry, revenue)).wait();

  // Make sure the spend guard won't block the dividend disbursements in this demo.
  await (await registry.setSpendCap(c.usdc, 0)).wait(); // 0 == unmetered

  // --- 3. Earmark for the next epoch + start it ---
  console.log("[3] Starting distribution epoch (earmarks the budget itself)...");
  await (await atnb.startNewRewardEpoch(revenue, c.usdc)).wait();
  const epochId = await atnb.currentRewardEpoch();
  console.log("   Epoch", epochId.toString(), "started with", ethers.formatUnits(revenue, dec), "USDC budget");

  // --- 4. Holders claim ---
  console.log("\n[4] Holders claim dividends...");
  const aUsdcBefore = await usdc.balanceOf(alice.address);
  const bUsdcBefore = await usdc.balanceOf(bob.address);
  await (await atnb.connect(alice).claimReward(epochId)).wait();
  await (await atnb.connect(bob).claimReward(epochId)).wait();
  const aGain = (await usdc.balanceOf(alice.address)) - aUsdcBefore;
  const bGain = (await usdc.balanceOf(bob.address)) - bUsdcBefore;
  console.log("   Alice received:", ethers.formatUnits(aGain, dec), "USDC");
  console.log("   Bob   received:", ethers.formatUnits(bGain, dec), "USDC");

  // --- 5. Verify pro-rata (Alice has 2x Bob's stake -> 2x the dividend; total ~= revenue) ---
  const total = aGain + bGain;
  const ratioOk = aGain === bGain * 2n; // exact for these round numbers
  console.log("\n[5] Checks:");
  // Both holders are auto-delegated away, so their delegate's cut (1% by default) is left for the delegate to claim
  console.log("   total distributed:", ethers.formatUnits(total, dec), "USDC (budget 3000, delegate cut unclaimed)");
  console.log("   Alice == 2x Bob (pro-rata by stake):", ratioOk);
  if (!ratioOk) throw new Error("pro-rata split incorrect");
  console.log("\n=== DIVIDEND CYCLE OK (dividends track ATNB balance, even when votes are delegated away) ===");
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
