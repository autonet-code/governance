// Deploy the ReputationMirror and produce the timelock grant path.
//
// The mirror issues RepToken to HUMAN OWNERS proportional to the soulbound
// reputation their owner-bound agents earned on the autonet Substrate. Per the
// wiring map §B3: MIRROR, DON'T BRIDGE. No token flows between the two ledgers;
// the mirror only READS substrate.agentReputation and MINTS RepToken.
//
// ── How RepToken minting authority works in this repo ──────────────────────
// RepToken.mint(to, amount) is gated to `admin || minters[msg.sender]`
// (RepToken.sol:301-304). After jurisdiction finalize, `admin` is the DAO
// TimelockController and the deployer no longer has it. The mirror therefore
// needs to be added to the `minters` set. That is done via
// RepToken.setMinter(mirror, true), which is `admin || timelock`-gated
// (RepToken.sol:294-298). So the grant MUST be executed BY THE TIMELOCK, i.e.
// as a governance proposal that the DAO passes and the timelock executes.
//
// This script DEPLOYS the mirror and PRINTS the calldata for that grant. It does
// NOT perform a live grant (the timelock only acts through governance).
//
// Usage:
//   SUBSTRATE_ADDR=0x... REPTOKEN_ADDR=0x... PERIOD_SECONDS=604800 \
//   npx hardhat run scripts/deploy-reputation-mirror.js --network <net>

const { ethers } = require("hardhat");

async function main() {
    const substrate = process.env.SUBSTRATE_ADDR;
    const repToken = process.env.REPTOKEN_ADDR;
    const period = process.env.PERIOD_SECONDS || "604800"; // default 1 week

    if (!substrate || !repToken) {
        throw new Error("Set SUBSTRATE_ADDR and REPTOKEN_ADDR env vars");
    }

    const Mirror = await ethers.getContractFactory("ReputationMirror");
    const mirror = await Mirror.deploy(substrate, repToken, period);
    await mirror.waitForDeployment();
    const mirrorAddr = await mirror.getAddress();

    console.log("ReputationMirror deployed:", mirrorAddr);
    console.log("  substrate:", substrate);
    console.log("  repToken :", repToken);
    console.log("  period   :", period, "seconds");
    console.log("  repPerReputation:", (await mirror.repPerReputation()).toString(), "(RATE_ONE = 1e18 = 1:1 default)");
    console.log("  timelock (rate governor, read from RepToken):", await mirror.timelock());

    // ── The grant the DAO timelock must execute ──────────────────────────────
    const rep = await ethers.getContractAt("RepToken", repToken);
    const grantCalldata = rep.interface.encodeFunctionData("setMinter", [mirrorAddr, true]);

    console.log("\n=== TIMELOCK GRANT (governance proposal, NOT executed here) ===");
    console.log("Target :", repToken);
    console.log("Value  : 0");
    console.log("Calldata (RepToken.setMinter(mirror, true)):");
    console.log(grantCalldata);
    console.log("\nRoute this through the HomebaseDAO governor -> queue -> timelock.execute.");
    console.log("After it lands, ReputationMirror.claim() can mint RepToken to owners.");
    console.log("\nThe rate knob ReputationMirror.setRepPerReputation(uint256) is");
    console.log("TIMELOCK-ONLY. Changing it is the direction/quality exchange-rate");
    console.log("decision the user must bless (wiring map D.4).");
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
