/** Cast a FOR vote on a genesis proposal.
 *  Governor address from deployments/autonet-jurisdiction-<network>.json
 *  (env GOV overrides). Proposal from PROPOSAL_ID env, or the LATEST
 *  ProposalCreated event when unset (FROM_BLOCK env narrows the scan).
 */
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

function loadGov() {
  const p = path.join(__dirname, "..", "deployments",
    `autonet-jurisdiction-${hre.network.name}.json`);
  const info = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  const gov = process.env.GOV || (info.dao && info.dao.governor);
  if (!gov) throw new Error("No governor address: deploy the jurisdiction or set GOV=0x...");
  return gov;
}

async function findLatestProposalId(gov) {
  const fromBlock = Number(process.env.FROM_BLOCK || 0);
  const events = await gov.queryFilter(gov.filters.ProposalCreated(), fromBlock);
  if (!events.length) throw new Error("No ProposalCreated events found — set PROPOSAL_ID or FROM_BLOCK");
  return events[events.length - 1].args.proposalId;
}

async function main() {
  const gov = await ethers.getContractAt("HomebaseDAO", loadGov());
  const id = process.env.PROPOSAL_ID || (await findLatestProposalId(gov));
  console.log("proposalId:", id.toString());

  // Wait for Active (state 1) — covers a nonzero votingDelay.
  for (let i = 0; i < 30; i++) {
    if ((await gov.state(id)) === 1n) break;
    await new Promise(r => setTimeout(r, 5000));
  }
  console.log("state:", await gov.state(id));
  const tx = await gov.castVote(id, 1);
  await tx.wait();
  const votes = await gov.proposalVotes(id);
  console.log("voted FOR — for:", ethers.formatEther(votes[1]));
  console.log("\nNext (after the voting deadline): npx hardhat run scripts/execute-genesis-proposals.js --network", hre.network.name);
}
main().catch(e => { console.error(e); process.exit(1); });
