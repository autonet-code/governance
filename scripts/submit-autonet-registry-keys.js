/** Autonet self-description registry keys E2E proposal (2026-07-10) on Etherlink shadownet.
 * THREE calls, ONE governor proposal, all target Registry, all editRegistry(string,string):
 *   1. editRegistry("jurisdiction.autonet.substrate",  "0x4C4dAEd19B98ddaEc6cC421b6a781Bd3fBB7af25")
 *   2. editRegistry("jurisdiction.autonet.vault",      "0xc1F834cf00A60a425F8a7d7ce9A326cB645ad4f6")
 *   3. editRegistry("jurisdiction.autonet.rep_claim",  "0x391Dd10eFa04BEB1638E80fE5F1A3BE96A590401")
 *
 * Full lifecycle: propose -> castVote(1) -> wait out 60s voting period
 * (poll state, no sleep-guessing) -> queue -> execute -> verify.
 *
 * Signer key is loaded from C:\code\autonet\.env (PRIVATE_KEY). It is NEVER
 * printed/echoed/logged. Modeled on scripts/submit-autonet-attach-e2e.js.
 * Run:  node scripts/submit-autonet-registry-keys.js
 */
const fs = require("fs");
const { ethers } = require("ethers");

// ---- addresses (shadownet) ----
const RPC = "https://node.shadownet.etherlink.com";
const CHAIN_ID = 127823;
const GOV = "0xD5691B7c37a472D84D4E3b8d89CEb79a675dd36e"; // HomebaseDAO
const REGISTRY = "0x422f3DC77614004a60F8598E4ADE6e9Ec19F6c56";
const EXPECT_SIGNER = "0x06E5b15Bc39f921e1503073dBb8A5dA2Fc6220E9";

// ---- the three registry keys to self-describe ----
const KEYS = [
  ["jurisdiction.autonet.substrate", "0x4C4dAEd19B98ddaEc6cC421b6a781Bd3fBB7af25"],
  ["jurisdiction.autonet.vault", "0xc1F834cf00A60a425F8a7d7ce9A326cB645ad4f6"],
  ["jurisdiction.autonet.rep_claim", "0x391Dd10eFa04BEB1638E80fE5F1A3BE96A590401"],
];

const DESC =
  "Self-describe autonet attachment: registry keys for substrate, vault (ATN sale), and REP claim rail";

// ---- minimal ABIs ----
const REP_ABI = [
  "function getVotes(address) view returns (uint256)",
];
const REG_ABI = [
  "function editRegistry(string,string)",
  "function getRegistryValue(string) view returns (string)",
];
const GOV_ABI = [
  "function propose(address[],uint256[],bytes[],string) returns (uint256)",
  "function castVote(uint256,uint8) returns (uint256)",
  "function queue(address[],uint256[],bytes[],bytes32) returns (uint256)",
  "function execute(address[],uint256[],bytes[],bytes32) payable returns (uint256)",
  "function state(uint256) view returns (uint8)",
  "function proposalDeadline(uint256) view returns (uint256)",
  "function token() view returns (address)",
  "function hashProposal(address[],uint256[],bytes[],bytes32) view returns (uint256)",
  "event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)",
];

const STATE = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadKey() {
  const envPath = "C:\\code\\autonet\\.env";
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*PRIVATE_KEY\s*=\s*(.+?)\s*$/);
    if (m) {
      let k = m[1].trim().replace(/^["']|["']$/g, "");
      if (!k.startsWith("0x")) k = "0x" + k;
      return k;
    }
  }
  throw new Error("PRIVATE_KEY not found in " + envPath);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const wallet = new ethers.Wallet(loadKey(), provider);
  if (wallet.address.toLowerCase() !== EXPECT_SIGNER.toLowerCase())
    throw new Error(`signer mismatch: derived ${wallet.address}, expected ${EXPECT_SIGNER}`);
  console.log("signer:", wallet.address);

  const reg = new ethers.Contract(REGISTRY, REG_ABI, wallet);
  const gov = new ethers.Contract(GOV, GOV_ABI, wallet);

  // ---- precondition: self-delegated voting power (read gov's own vote token) ----
  const tokenAddr = await gov.token();
  console.log("gov vote token:", tokenAddr);
  const rep = new ethers.Contract(tokenAddr, REP_ABI, provider);
  const votes = await rep.getVotes(wallet.address);
  console.log("getVotes(signer):", votes.toString());
  if (votes === 0n) {
    console.error("STOP: signer has 0 votes (not self-delegated). Aborting.");
    process.exit(1);
  }

  // ---- build proposal: three editRegistry calls, all to Registry ----
  const targets = KEYS.map(() => REGISTRY);
  const values = KEYS.map(() => 0);
  const calldatas = KEYS.map(([k, v]) => reg.interface.encodeFunctionData("editRegistry", [k, v]));
  const descHash = ethers.keccak256(ethers.toUtf8Bytes(DESC));
  console.log("targets:", targets);
  calldatas.forEach((c, i) => console.log(`calldata[${i}] (${KEYS[i][0]}):`, c));
  console.log("descHash:", descHash);

  const predictedId = (await gov.hashProposal(targets, values, calldatas, descHash)).toString();
  console.log("predicted proposalId:", predictedId);

  // If already exists, skip re-propose.
  let proposalId;
  let curState = -1;
  try {
    curState = Number(await gov.state(predictedId));
    proposalId = predictedId;
    console.log("proposal already exists, state:", STATE[curState]);
  } catch {
    // ---- PHASE 1: propose ----
    const txP = await gov.propose(targets, values, calldatas, DESC);
    console.log("PROPOSE tx:", txP.hash);
    const rcP = await txP.wait();
    console.log("  mined block:", rcP.blockNumber);
    const ev = rcP.logs
      .map((l) => { try { return gov.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "ProposalCreated");
    proposalId = ev.args.proposalId.toString();
    console.log("PROPOSAL_ID:", proposalId);
    console.log("  voteStart:", ev.args.voteStart.toString(), "voteEnd:", ev.args.voteEnd.toString());
    curState = Number(await gov.state(proposalId));
  }
  console.log("state after propose:", STATE[curState]);

  // votingDelay is 0, but poll until Active before voting.
  while (Number(await gov.state(proposalId)) === 0 /*Pending*/) {
    console.log("  pending... waiting for Active");
    await sleep(3000);
  }

  // ---- PHASE 2: castVote(1 = For) ----
  if (Number(await gov.state(proposalId)) === 1 /*Active*/) {
    const txV = await gov.castVote(proposalId, 1);
    console.log("CASTVOTE tx:", txV.hash);
    await txV.wait();
    console.log("  voted For");
  } else {
    console.log("  not Active, skipping castVote (state:", STATE[Number(await gov.state(proposalId))], ")");
  }

  // ---- wait out 60s voting period: poll state until != Active ----
  const deadline = await gov.proposalDeadline(proposalId);
  console.log("proposalDeadline (clock units):", deadline.toString());
  while (Number(await gov.state(proposalId)) === 1 /*Active*/) {
    const blk = await provider.getBlock("latest");
    console.log(`  active... latest ts=${blk.timestamp}, deadline=${deadline}`);
    await sleep(5000);
  }
  let st = Number(await gov.state(proposalId));
  console.log("state after voting period:", STATE[st]);
  if (st === 3 /*Defeated*/ || st === 2 /*Canceled*/) {
    console.error("STOP: proposal", STATE[st]);
    process.exit(1);
  }

  // ---- PHASE 3: queue (OZ Governor + TimelockControl requires it) ----
  if (st === 4 /*Succeeded*/) {
    const txQ = await gov.queue(targets, values, calldatas, descHash);
    console.log("QUEUE tx:", txQ.hash);
    await txQ.wait();
    st = Number(await gov.state(proposalId));
    console.log("state after queue:", STATE[st]);
  }

  // timelock minDelay is 0; poll to Queued readiness (already ready at delay 0).
  // ---- PHASE 4: execute (explicit generous gasLimit for Etherlink) ----
  if (st === 5 /*Queued*/ || st === 4 /*Succeeded*/) {
    const txE = await gov.execute(targets, values, calldatas, descHash, { gasLimit: 8_000_000 });
    console.log("EXECUTE tx:", txE.hash);
    const rcE = await txE.wait();
    console.log("  executed block:", rcE.blockNumber, "status:", rcE.status);
    st = Number(await gov.state(proposalId));
  }
  console.log("FINAL state:", STATE[st]);

  // ---- verification: read back all three keys ----
  console.log("\n=== VERIFICATION ===");
  const readbacks = {};
  for (const [k] of KEYS) {
    const v = await reg.getRegistryValue(k);
    readbacks[k] = v;
    console.log(`  getRegistryValue("${k}"):`, v);
  }

  console.log("\n=== SUMMARY (json) ===");
  console.log(JSON.stringify({
    proposalId, finalState: STATE[st], readbacks,
  }));
}

main().catch((e) => { console.error(e); process.exit(1); });
