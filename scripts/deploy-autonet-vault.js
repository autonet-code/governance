// Deploy an AutonetVault satellite for a jurisdiction DAO and print the
// governance wiring it needs. Modeled on scripts/deploy-autonet-rep-claim.js:
// deploy the satellite, then PRINT the calldata the DAO timelock must execute —
// this script does NOT perform live grants (the timelock only acts through
// governance).
//
// WHAT THE VAULT IS
// -----------------
// A CoinOffering-shaped router that sells ATN (the Autonet NETWORK token, on the
// external Substrate contract) for registry-whitelisted ERC20s at registry
// parity. Payment is routed straight to the Registry treasury; ATN is minted to
// the buyer on Substrate via IAutonetATN.mintFromVault. Uncapped, buy-only, no
// custody. See contracts/AutonetVault.sol.
//
// TWO GOVERNANCE ACTIONS ARE REQUIRED AFTER DEPLOY (both timelock-executed):
//   1. On the AUTONET side (Substrate): authorize this vault to call
//      mintFromVault. Substrate currently has NO admin mint path; the autonet
//      repo must implement IAutonetATN.mintFromVault gated to a vault allowlist,
//      then add THIS vault to it. That grant lives in the autonet repo, not here
//      — this script only prints the vault address to register.
//   2. On the DAO side (Registry): whitelist each payment token by setting its
//      parity key. This is a normal Registry edit through the timelock.
//
// Usage:
//   ATN_ADDR=0x...        # the Autonet network Substrate contract
//   REGISTRY_ADDR=0x...   # the jurisdiction DAO Registry (treasury + parity)
//   ADMIN_ADDR=0x...      # vault admin — the DAO Timelock (pause/admin only)
//   [PARITY_TOKENS=0x..,0x..  PARITY_VALUES=1000000000000000000,..]  # optional
//   npx hardhat run scripts/deploy-autonet-vault.js --network <net>
//
// PARITY / DECIMALS REMINDER
// --------------------------
// atnOut = paymentAmount * parity / 1e18, and ATN is 6-DECIMAL (1e6-scaled).
// The decimal adjustment is baked into the parity value:
//   1 USDC (6d) -> 1 ATN (6d):  parity = 1e18
//   1 USDC (6d) -> 2 ATN (6d):  parity = 2e18
//   1 DAI  (18d) -> 1 ATN (6d): parity = 1e6

const { ethers } = require("hardhat");

async function main() {
    const atn = process.env.ATN_ADDR;
    const registry = process.env.REGISTRY_ADDR;
    const admin = process.env.ADMIN_ADDR;

    if (!atn || !registry || !admin) {
        throw new Error("Set ATN_ADDR, REGISTRY_ADDR and ADMIN_ADDR env vars");
    }

    const [deployer] = await ethers.getSigners();
    const net = await ethers.provider.getNetwork();
    console.log(`\n=== AutonetVault deploy (chainId ${net.chainId}) ===`);
    console.log("Deployer   :", deployer.address);
    console.log("ATN (Substrate):", atn);
    console.log("Registry   :", registry);
    console.log("Admin (timelock):", admin);

    const Vault = await ethers.getContractFactory("AutonetVault");
    const vault = await Vault.deploy(atn, registry, admin);
    await vault.waitForDeployment();
    const vaultAddr = await vault.getAddress();

    console.log("\nAutonetVault deployed:", vaultAddr);

    // ── Action 1: autonet-side mint authorization (in the autonet repo) ──────
    console.log("\n=== ACTION 1: authorize the vault to mint on Substrate (AUTONET REPO) ===");
    console.log("Substrate must implement IAutonetATN.mintFromVault(to, amount)");
    console.log("gated to an allowlist, and add this vault to it:");
    console.log("  vault to allowlist:", vaultAddr);
    console.log("Without this, buy() reverts at the mintFromVault call.");

    // ── Action 2: DAO-side parity whitelist (Registry edit via timelock) ─────
    console.log("\n=== ACTION 2: whitelist payment tokens on the Registry (DAO TIMELOCK) ===");
    const reg = await ethers.getContractAt("Registry", registry);

    const tokensRaw = process.env.PARITY_TOKENS;
    const valuesRaw = process.env.PARITY_VALUES;
    if (tokensRaw && valuesRaw) {
        const tokens = tokensRaw.split(",").map((s) => s.trim());
        const values = valuesRaw.split(",").map((s) => s.trim());
        if (tokens.length !== values.length) {
            throw new Error("PARITY_TOKENS and PARITY_VALUES length mismatch");
        }
        for (let i = 0; i < tokens.length; i++) {
            const key = `jurisdiction.parity.${tokens[i].toLowerCase()}`;
            const calldata = reg.interface.encodeFunctionData("editRegistry", [key, values[i]]);
            console.log(`\n  token ${tokens[i]} -> parity ${values[i]}`);
            console.log("  Target :", registry);
            console.log("  Value  : 0");
            console.log("  Calldata (Registry.editRegistry):");
            console.log("  " + calldata);
        }
    } else {
        console.log("(no PARITY_TOKENS/PARITY_VALUES given — set them to print editRegistry calldata)");
        console.log("Each is: Registry.editRegistry(\"jurisdiction.parity.<lowercaseToken>\", \"<parity18dp>\")");
    }

    console.log("\nRoute both actions through the respective governor -> queue -> timelock.execute.");
    console.log("After they land, AutonetVault.buy(paymentToken, amount) is live.");
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
