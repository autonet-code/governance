/** Autonet-attach E2E proposal (2026-07-10) on Etherlink shadownet.
 * TWO calls, ONE governor proposal:
 *   A. RepToken.setMinter(AutonetRepClaim, true)
 *   B. Registry.editRegistry("jurisdiction.parity.<usdc lc>", "1e18")
 *
 * Full lifecycle: propose -> castVote(1) -> wait out 60s voting period
 * (poll state, no sleep-guessing) -> queue -> execute -> verify.
 *
 * Signer key is loaded from C:\code\autonet\.env (PRIVATE_KEY). It is NEVER
 * printed/echoed/logged. Modeled on the 2026-07-10 flag-day proposal but
 * standalone (raw ethers provider, so it does not depend on hardhat's config.js
 * PRIVATE_KEY). Run:  node scripts/submit-autonet-attach-e2e.js
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// ---- addresses (shadownet, from deployments/shadownet-autonet-dao-e2e.json) ----
const RPC = "https://node.shadownet.etherlink.com";
const CHAIN_ID = 127823;
const GOV = "0xD5691B7c37a472D84D4E3b8d89CEb79a675dd36e"; // HomebaseDAO
const TIMELOCK = "0xdB2B6098356f80304Ec78D51799d4e5a377e81dA";
const REP = "0x00A2aF275D1800DAaB115A05d892b888aF73778D";
const REGISTRY = "0x422f3DC77614004a60F8598E4ADE6e9Ec19F6c56";
const CLAIM = "0x391Dd10eFa04BEB1638E80fE5F1A3BE96A590401";
const VAULT = "0xc1F834cf00A60a425F8a7d7ce9A326cB645ad4f6";
const USDC_LC = "0xfa9a9d2d8442af9ce9313177046f5c80042946b7";
const USDC_QUOTE = "0xfa9a9d2d8442af9ce9313177046f5C80042946b7"; // checksummed for quote()
const PARITY = "1000000000000000000"; // 1e18
const EXPECT_SIGNER = "0x06E5b15Bc39f921e1503073dBb8A5dA2Fc6220E9";

const DESC =
  "Attach autonet-DAO stack 2026-07-10: grant AutonetRepClaim RepToken minter, whitelist test-USDC parity 1:1 on Registry";

// ---- minimal ABIs ----
const REP_ABI = [
  "function setMinter(address,bool)",
  "function minters(address) view returns (bool)",
  "function getVotes(address) view returns (uint256)",
  "function delegates(address) view returns (address)",
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
  "function hashProposal(address[],uint256[],bytes[],bytes32) view returns (uint256)",
  "event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)",
];
const VAULT_ABI = ["function quote(address,uint256) view returns (uint256)"];

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

  const rep = new ethers.Contract(REP, REP_ABI, wallet);
  const reg = new ethers.Contract(REGISTRY, REG_ABI, wallet);
  const gov = new ethers.Contract(GOV, GOV_ABI, wallet);
  const vault = new ethers.Contract(VAULT, VAULT_ABI, provider);

  // ---- precondition: self-delegated voting power ----
  const votes = await rep.getVotes(wallet.address);
  console.log("getVotes(signer):", votes.toString());
  if (votes === 0n) {
    console.error("STOP: signer has 0 votes (not self-delegated). Aborting.");
    process.exit(1);
  }

  // ---- build proposal ----
  const targets = [REP, REGISTRY];
  const values = [0, 0];
  const calldatas = [
    rep.interface.encodeFunctionData("setMinter", [CLAIM, true]),
    reg.interface.encodeFunctionData("editRegistry", [`jurisdiction.parity.${USDC_LC}`, PARITY]),
  ];
  const descHash = ethers.keccak256(ethers.toUtf8Bytes(DESC));
  console.log("targets:", targets);
  calldatas.forEach((c, i) => console.log(`calldata[${i}]:`, c));
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
    const txE = await gov.execute(targets, values, calldatas, descHash, { gasLimit: 6_000_000 });
    console.log("EXECUTE tx:", txE.hash);
    const rcE = await txE.wait();
    console.log("  executed block:", rcE.blockNumber, "status:", rcE.status);
    st = Number(await gov.state(proposalId));
  }
  console.log("FINAL state:", STATE[st]);

  // ---- verification ----
  console.log("\n=== VERIFICATION ===");
  const isMinter = await rep.minters(CLAIM);
  console.log("1. RepToken.minters(AutonetRepClaim):", isMinter);
  const parityVal = await reg.getRegistryValue(`jurisdiction.parity.${USDC_LC}`);
  console.log("2. Registry.getRegistryValue(parity):", parityVal);
  let quoteOut;
  try {
    quoteOut = (await vault.quote(USDC_QUOTE, 1000000n)).toString();
    console.log("3. AutonetVault.quote(usdc, 1e6):", quoteOut);
  } catch (e) {
    quoteOut = "ERROR: " + (e.shortMessage || e.message);
    console.log("3. AutonetVault.quote:", quoteOut);
  }

  console.log("\n=== SUMMARY (json) ===");
  console.log(JSON.stringify({
    proposalId, finalState: STATE[st],
    verify: { minter: isMinter, parity: parityVal, quote: quoteOut },
  }));
}

main().catch((e) => { console.error(e); process.exit(1); });
