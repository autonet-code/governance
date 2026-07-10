// Deploy AutonetRepClaim and produce the timelock grant path (mirror -> claim).
//
// AutonetRepClaim mints RepToken to AGENTS proportional to the ATN they PROVABLY
// EARNED on the autonet Substrate (tool-pool distributions + net service revenue),
// 1:1 in whole-token terms. Ratified in docs/tool_substrate.md
// "Decision (2026-07-10): fees-only emission + REP-from-earnings". It RETIRES
// ReputationMirror (nothing to mirror; REP is a pure function of ratified earnings).
//
// ── DECIMAL SCALING ─────────────────────────────────────────────────────────
// Substrate earnings are ATN BASE UNITS (1 ATN = 1e6; Substrate has no decimals).
// RepToken.decimals() == 18. "1:1 whole-token" => multiply the ATN-base delta by
// 10**(18-6) = 1e12 (AutonetRepClaim.REP_PER_ATN_BASE). Exact; never truncates.
//
// ── MINTER WIRING (the governance action that swaps mirror -> claim) ─────────
// RepToken.mint(to, amount) is gated to `admin || minters[msg.sender]`. After
// jurisdiction finalize, `admin` is the DAO TimelockController. The claim contract
// must be added to `minters` via RepToken.setMinter(claim, true) — itself
// `admin || timelock`-gated. So the swap is TWO calls in ONE governance proposal
// the timelock executes:
//   1) RepToken.setMinter(<AutonetRepClaim addr>, true)   // grant new
//   2) RepToken.setMinter(<ReputationMirror addr>, false) // revoke old (optional
//                                                          //   if never deployed)
//
// GENESIS ORDERING NOTE: if you pass a non-empty genesis seed, the claim contract
// must ALREADY be a minter at construction (its constructor mints the seed). Two
// options: (a) predeploy grant to the PRECOMPUTED create address, then deploy; or
// (b) deploy with an EMPTY genesis array and seed via a separate governance mint.
// This script uses (b) by default (safe on any network); set GENESIS_* to use (a)
// only where you control the deployer nonce and can pre-grant.
//
// This script DEPLOYS the claim contract and PRINTS the grant calldata. It does
// NOT perform a live grant (the timelock only acts through governance).
//
// Usage:
//   SUBSTRATE_ADDR=0x... REPTOKEN_ADDR=0x... [MIRROR_ADDR=0x...] \
//   npx hardhat run scripts/deploy-autonet-rep-claim.js --network <net>

const { ethers } = require("hardhat");

async function main() {
    const substrate = process.env.SUBSTRATE_ADDR;
    const repToken = process.env.REPTOKEN_ADDR;
    const mirror = process.env.MIRROR_ADDR; // optional: old mirror to revoke

    if (!substrate || !repToken) {
        throw new Error("Set SUBSTRATE_ADDR and REPTOKEN_ADDR env vars");
    }

    // Default: empty genesis seed (option (b) above). Amounts are a launch
    // decision; seed via a separate governance mint after the minter grant lands,
    // or wire a precomputed-address pre-grant if seeding at construction.
    const genesisHolders = [];
    const genesisAmounts = [];

    const Claim = await ethers.getContractFactory("AutonetRepClaim");
    const claim = await Claim.deploy(substrate, repToken, genesisHolders, genesisAmounts);
    await claim.waitForDeployment();
    const claimAddr = await claim.getAddress();

    console.log("AutonetRepClaim deployed:", claimAddr);
    console.log("  substrate:", substrate);
    console.log("  repToken :", repToken);
    console.log("  REP_PER_ATN_BASE:", (await claim.REP_PER_ATN_BASE()).toString(), "(1e12: ATN base 1e6 -> REP 1e18, 1:1 whole-token)");

    const rep = await ethers.getContractAt("RepToken", repToken);

    console.log("\n=== TIMELOCK GRANT (governance proposal, NOT executed here) ===");
    const grantCalldata = rep.interface.encodeFunctionData("setMinter", [claimAddr, true]);
    console.log("1) GRANT new claim as minter:");
    console.log("   Target :", repToken);
    console.log("   Value  : 0");
    console.log("   Calldata (RepToken.setMinter(claim, true)):");
    console.log("  ", grantCalldata);

    if (mirror) {
        const revokeCalldata = rep.interface.encodeFunctionData("setMinter", [mirror, false]);
        console.log("2) REVOKE the retired ReputationMirror minter:");
        console.log("   Target :", repToken);
        console.log("   Value  : 0");
        console.log("   Calldata (RepToken.setMinter(mirror, false)):");
        console.log("  ", revokeCalldata);
    } else {
        console.log("2) (No MIRROR_ADDR given — skip the revoke; only needed if a mirror was ever granted.)");
    }

    console.log("\nRoute both through the HomebaseDAO governor -> queue -> timelock.execute.");
    console.log("After the grant lands, AutonetRepClaim.claim(agent) mints REP to earners.");
    console.log("There is NO rate knob, NO admin, NO pause: the 1:1 rate is hardcoded.");
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
