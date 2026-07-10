/** Anchor charter v1 on the NEW CharterAnchor via a governance proposal on the
 * NEW autonet DAO (Etherlink shadownet). ONE call:
 *   CharterAnchor.anchorCharter(charterHash, charterUri)
 *
 * Full lifecycle: propose -> castVote(1) -> poll voting period -> queue ->
 * execute -> verify currentCharter() reads back the expected hash.
 *
 * Signer key from C:\code\autonet\.env (PRIVATE_KEY). NEVER printed.
 * Modeled on scripts/submit-autonet-attach-e2e.js. Run:
 *   node scripts/submit-autonet-charter-anchor-e2e.js
 */
const fs = require("fs");
const { ethers } = require("ethers");

const RPC = "https://node.shadownet.etherlink.com";
const CHAIN_ID = 127823;
const GOV = "0xD5691B7c37a472D84D4E3b8d89CEb79a675dd36e"; // new HomebaseDAO
const REP = "0x00A2aF275D1800DAaB115A05d892b888aF73778D";
const ANCHOR = "0x5e18e8ba38aA752121a0DFadCa5E49A7f3237fF0"; // new CharterAnchor
const EXPECT_SIGNER = "0x06E5b15Bc39f921e1503073dBb8A5dA2Fc6220E9";

const CHARTER_HASH = "0x5756ed3aa1831533c6ae7a1728cd6af73241c787049080ac3469d5b40f841cd5";
const CHARTER_URI = "https://github.com/autonet-code/node/blob/master/nodes/common/world_model_substrate/adapter.py";

const DESC =
  "Anchor charter v1 on new CharterAnchor (0x5e18e8ba38aA752121a0DFadCa5E49A7f3237fF0) for autonet-DAO jurisdiction, 2026-07-10";

const REP_ABI = ["function getVotes(address) view returns (uint256)"];
const ANCHOR_ABI = [
  "function anchorCharter(bytes32,string)",
  "function currentCharter() view returns (uint256 version, bytes32 hash, string uri, bytes32 prevHash, uint256 timestamp)",
  "function versionCount() view returns (uint256)",
];
const GOV_ABI = [
  "function propose(address[],uint256[],bytes[],string) returns (uint256)",
  "function castVote(uint256,uint8) returns (uint256)",
  "function queue(address[],uint256[],bytes[],bytes32) returns (uint256)",
  "function execute(address[],uint256[],bytes[],bytes32) payable returns (uint256)",
  "function state(uint256) view returns (uint8)",
  "function proposalDeadline(uint256) view returns (uint256)",
  "function hashProposal(address[],uint256[],bytes[],bytes32) view returns (uint256)",
  "event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)",
];

const STATE = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadKey() {
  const raw = fs.readFileSync("C:\\code\\autonet\\.env", "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*PRIVATE_KEY\s*=\s*(.+?)\s*$/);
    if (m) {
      let k = m[1].trim().replace(/^["']|["']$/g, "");
      if (!k.startsWith("0x")) k = "0x" + k;
      return k;
    }
  }
  throw new Error("PRIVATE_KEY not found");
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const wallet = new ethers.Wallet(loadKey(), provider);
  if (wallet.address.toLowerCase() !== EXPECT_SIGNER.toLowerCase())
    throw new Error(`signer mismatch: ${wallet.address}`);
  console.log("signer:", wallet.address);

  const rep = new ethers.Contract(REP, REP_ABI, wallet);
  const anchor = new ethers.Contract(ANCHOR, ANCHOR_ABI, wallet);
  const gov = new ethers.Contract(GOV, GOV_ABI, wallet);

  const votes = await rep.getVotes(wallet.address);
  console.log("getVotes(signer):", votes.toString());
  if (votes === 0n) { console.error("STOP: 0 votes (not self-delegated)."); process.exit(1); }

  const targets = [ANCHOR];
  const values = [0];
  const calldatas = [anchor.interface.encodeFunctionData("anchorCharter", [CHARTER_HASH, CHARTER_URI])];
  const descHash = ethers.keccak256(ethers.toUtf8Bytes(DESC));
  console.log("target:", ANCHOR);
  console.log("calldata:", calldatas[0]);
  console.log("descHash:", descHash);

  const predictedId = (await gov.hashProposal(targets, values, calldatas, descHash)).toString();
  console.log("predicted proposalId:", predictedId);

  let proposalId, curState = -1;
  const txHashes = {};
  try {
    curState = Number(await gov.state(predictedId));
    proposalId = predictedId;
    console.log("proposal already exists, state:", STATE[curState]);
  } catch {
    const txP = await gov.propose(targets, values, calldatas, DESC);
    console.log("PROPOSE tx:", txP.hash);
    txHashes.propose = txP.hash;
    const rcP = await txP.wait();
    const ev = rcP.logs.map((l) => { try { return gov.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "ProposalCreated");
    proposalId = ev.args.proposalId.toString();
    console.log("PROPOSAL_ID:", proposalId);
    console.log("  voteStart:", ev.args.voteStart.toString(), "voteEnd:", ev.args.voteEnd.toString());
    curState = Number(await gov.state(proposalId));
  }
  console.log("state after propose:", STATE[curState]);

  while (Number(await gov.state(proposalId)) === 0) { console.log("  pending..."); await sleep(3000); }

  if (Number(await gov.state(proposalId)) === 1) {
    const txV = await gov.castVote(proposalId, 1);
    console.log("CASTVOTE tx:", txV.hash);
    txHashes.castVote = txV.hash;
    await txV.wait();
    console.log("  voted For");
  }

  const deadline = await gov.proposalDeadline(proposalId);
  console.log("proposalDeadline:", deadline.toString());
  while (Number(await gov.state(proposalId)) === 1) {
    const blk = await provider.getBlock("latest");
    console.log(`  active... ts=${blk.timestamp}, deadline=${deadline}`);
    await sleep(5000);
  }
  let st = Number(await gov.state(proposalId));
  console.log("state after voting period:", STATE[st]);
  if (st === 3 || st === 2) { console.error("STOP:", STATE[st]); process.exit(1); }

  if (st === 4) {
    const txQ = await gov.queue(targets, values, calldatas, descHash);
    console.log("QUEUE tx:", txQ.hash);
    txHashes.queue = txQ.hash;
    await txQ.wait();
    st = Number(await gov.state(proposalId));
    console.log("state after queue:", STATE[st]);
  }

  if (st === 5 || st === 4) {
    const txE = await gov.execute(targets, values, calldatas, descHash, { gasLimit: 6_000_000 });
    console.log("EXECUTE tx:", txE.hash);
    txHashes.execute = txE.hash;
    const rcE = await txE.wait();
    console.log("  executed block:", rcE.blockNumber, "status:", rcE.status);
    st = Number(await gov.state(proposalId));
  }
  console.log("FINAL state:", STATE[st]);

  console.log("\n=== VERIFICATION ===");
  const vc = await anchor.versionCount();
  const cur = await anchor.currentCharter();
  const gotHash = cur[1].slice(2);
  const wantHash = CHARTER_HASH.slice(2);
  console.log("versionCount:", vc.toString());
  console.log("currentCharter version:", cur[0].toString());
  console.log("currentCharter hash:", gotHash);
  console.log("expected hash:      ", wantHash);
  console.log("currentCharter uri: ", cur[2]);
  console.log("hash MATCH:", gotHash.toLowerCase() === wantHash.toLowerCase());

  console.log("\n=== SUMMARY (json) ===");
  console.log(JSON.stringify({
    proposalId, finalState: STATE[st], txHashes, descHash,
    verify: { versionCount: vc.toString(), hash: gotHash, match: gotHash.toLowerCase() === wantHash.toLowerCase() },
  }));
}

main().catch((e) => { console.error(e); process.exit(1); });
