// Mint test USDC (and top up ETH gas) to a target wallet on the local node so a
// human can run the real Coin Offering buy flow from MetaMask.
//   npx hardhat run scripts/fundTestWallet.js --network localhost
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const TARGET = "0x06E5b15Bc39f921e1503073dBb8A5dA2Fc6220E9";
const USDC_AMOUNT = "100000";   // 100k test USDC
const ETH_AMOUNT = "10";        // gas

async function main() {
  const [deployer] = await ethers.getSigners();
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "local-co.json")));
  const usdcAddr = cfg.contracts.usdc;

  // Sanity: ensure there's actually code at the USDC address (node not wiped).
  const code = await ethers.provider.getCode(usdcAddr);
  if (code === "0x") {
    throw new Error(`No contract at USDC ${usdcAddr}. The node was likely restarted; re-run scripts/deployCOLocal.js first.`);
  }

  const usdc = await ethers.getContractAt(
    ["function mint(address,uint256)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"],
    usdcAddr
  );
  const dec = await usdc.decimals();
  const sym = await usdc.symbol();

  // Mint USDC.
  const amount = ethers.parseUnits(USDC_AMOUNT, dec);
  await (await usdc.mint(TARGET, amount)).wait();

  // Top up ETH for gas (from the funded deployer).
  await (await deployer.sendTransaction({ to: TARGET, value: ethers.parseEther(ETH_AMOUNT) })).wait();

  const bal = await usdc.balanceOf(TARGET);
  const ethBal = await ethers.provider.getBalance(TARGET);
  console.log(`\nFunded ${TARGET}:`);
  console.log(`  ${sym}: ${ethers.formatUnits(bal, dec)}`);
  console.log(`  ETH: ${ethers.formatEther(ethBal)}`);
  console.log(`\nUSDC token address (add to MetaMask if you want to see the balance): ${usdcAddr}`);
  console.log(`CO address: ${cfg.contracts.coinOffering}`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
