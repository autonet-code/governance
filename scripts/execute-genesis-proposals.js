/** Finish a genesis proposal: wait for the voting deadline, then queue() and
 *  execute() it through the timelock.
 *
 *  - Governor from deployments/autonet-jurisdiction-<network>.json (GOV env
 *    overrides).
 *  - Proposal from PROPOSAL_ID env, or the LATEST ProposalCreated event when
 *    unset (FROM_BLOCK env narrows the scan). The proposal's targets/values/
 *    calldatas/description are reconstructed from that event, so this script
 *    needs no knowledge of what was proposed.
 *  - Handles BOTH paths: governors that require queuing (GovernorTimelockControl
 *    — queue, wait out the timelock eta, execute; with TIMELOCK_DELAY_SECS=0
 *    the eta is immediate) and proposals that report no queuing needed
 *    (execute directly).
 *
 *  OZ Governor states: 0 Pending, 1 Active, 2 Canceled, 3 Defeated,
 *  4 Succeeded, 5 Queued, 6 Expired, 7 Executed.
 */
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

const POLL_MS = 5000;
const MAX_POLLS = Number(process.env.MAX_POLLS || 720); // default: up to 1 hour

function loadGov() {
  const p = path.join(__dirname, "..", "deployments",
    `autonet-jurisdiction-${hre.network.name}.json`);
  const info = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  const gov = process.env.GOV || (info.dao && info.dao.governor);
  if (!gov) throw new Error("No governor address: deploy the jurisdiction or set GOV=0x...");
  return gov;
}

async function findProposalEvent(gov) {
  const fromBlock = Number(process.env.FROM_BLOCK || 0);
  const events = await gov.queryFilter(gov.filters.ProposalCreated(), fromBlock);
  if (!events.length) throw new Error("No ProposalCreated events found — set FROM_BLOCK?");
  if (process.env.PROPOSAL_ID) {
    const want = BigInt(process.env.PROPOSAL_ID);
    const ev = events.find(e => e.args.proposalId === want);
    if (!ev) throw new Error(`ProposalCreated event for id ${want} not found (FROM_BLOCK too high?)`);
    return ev;
  }
  return events[events.length - 1];
}

async function waitForState(gov, id, isDone, label) {
  for (let i = 0; i < MAX_POLLS; i++) {
    const s = await gov.state(id);
    if (isDone(s)) return s;
    if (i % 6 === 0) console.log(`  waiting (${label})... state=${s}`);
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const gov = await ethers.getContractAt("HomebaseDAO", loadGov());
  const ev = await findProposalEvent(gov);
  const id = ev.args.proposalId;

  // Reconstruct the proposal actions from the creation event.
  const targets = [...ev.args.targets];
  const values = [...ev.args[3]]; // `values` collides with a Result method; use index
  const calldatas = [...ev.args.calldatas];
  const descriptionHash = ethers.keccak256(ethers.toUtf8Bytes(ev.args.description));

  console.log("proposalId:", id.toString());
  console.log("deadline  :", (await gov.proposalDeadline(id)).toString(),
    "(now:", (await ethers.provider.getBlock("latest")).timestamp + ")");

  // 1. Wait out the vote: leave Pending/Active.
  let state = await waitForState(gov, id, s => s !== 0n && s !== 1n, "voting deadline");
  if (state === 3n) throw new Error("Proposal DEFEATED — nothing to execute");
  if (state === 2n || state === 6n) throw new Error(`Proposal in terminal state ${state} (canceled/expired)`);
  if (state === 7n) { console.log("Already executed."); return; }

  // 2. Queue if the governor requires it (GovernorTimelockControl does).
  if (state === 4n /* Succeeded */) {
    if (await gov.proposalNeedsQueuing(id)) {
      console.log("queueing...");
      await (await gov.queue(targets, values, calldatas, descriptionHash)).wait();
      const eta = await gov.proposalEta(id);
      console.log("queued; timelock eta:", eta.toString());
      state = 5n;
    } else {
      console.log("no queuing required — executing directly");
    }
  }

  // 3. Wait out the timelock eta (immediate when TIMELOCK_DELAY_SECS=0), execute.
  if (state === 5n /* Queued */) {
    const eta = await gov.proposalEta(id);
    for (let i = 0; i < MAX_POLLS; i++) {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      if (BigInt(now) >= eta) break;
      if (i % 6 === 0) console.log(`  waiting (timelock eta ${eta})... now=${now}`);
      await new Promise(r => setTimeout(r, POLL_MS));
    }
  }
  console.log("executing...");
  await (await gov.execute(targets, values, calldatas, descriptionHash)).wait();
  console.log("state:", await gov.state(id), "(7 = Executed)");
}
main().catch(e => { console.error(e); process.exit(1); });
