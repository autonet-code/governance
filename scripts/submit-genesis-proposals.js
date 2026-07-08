/** Submit the two genesis wiring actions as ONE governor proposal:
 *  1. RepToken.setMinter(ReputationMirror, true)
 *  2. CharterAnchor.anchorCharter(charter v1 hash, uri)
 * Self-delegates the deployer's AREP first if needed, then proposes.
 * Vote with scripts/vote-genesis.js; queue+execute with
 * scripts/execute-genesis-proposals.js.
 *
 * Addresses are read from deployments/autonet-jurisdiction-<network>.json
 * (the file deploy-autonet-jurisdiction.js writes), overridable via env:
 *   GOV=0x..    governor (default: json dao.governor)
 *   REP=0x..    RepToken (default: json dao.repToken)
 *   MIRROR=0x.. ReputationMirror (default: json mirror.reputationMirror)
 *   ANCHOR=0x.. CharterAnchor — autonet-side, NOT in the json unless a
 *               `charterAnchor` key was added; usually passed via env.
 *   CHARTER_HASH / CHARTER_URI  override the charter v1 hash / uri.
 */
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

const DEFAULT_HASH = "0x5756ed3aa1831533c6ae7a1728cd6af73241c787049080ac3469d5b40f841cd5";
const DEFAULT_URI = "https://github.com/autonet-code/node/blob/master/nodes/common/world_model_substrate/adapter.py";
const DESC = "Genesis wiring: grant ReputationMirror RepToken-minter rights; anchor charter v1";

function loadGenesisAddresses() {
  const p = path.join(__dirname, "..", "deployments",
    `autonet-jurisdiction-${hre.network.name}.json`);
  const info = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  const addrs = {
    gov: process.env.GOV || (info.dao && info.dao.governor),
    rep: process.env.REP || (info.dao && info.dao.repToken),
    mirror: process.env.MIRROR || (info.mirror && info.mirror.reputationMirror),
    anchor: process.env.ANCHOR || info.charterAnchor,
  };
  console.log(`addresses (${fs.existsSync(p) ? p : "env only — no deployment json"}):`);
  for (const [k, v] of Object.entries(addrs)) console.log(`  ${k.padEnd(6)} ${v || "(unset)"}`);
  return addrs;
}

async function main() {
  const [signer] = await ethers.getSigners();
  const { gov: GOV, rep: REP, mirror: MIRROR, anchor: ANCHOR } = loadGenesisAddresses();
  if (!GOV || !REP || !MIRROR) {
    throw new Error("Missing GOV/REP/MIRROR — deploy the jurisdiction first or set env overrides");
  }
  if (!ANCHOR) {
    throw new Error("Missing ANCHOR (CharterAnchor is autonet-side): set ANCHOR=0x... " +
      "or add a charterAnchor key to the deployment json");
  }
  const HASH = process.env.CHARTER_HASH || DEFAULT_HASH;
  const URI = process.env.CHARTER_URI || DEFAULT_URI;

  const gov = await ethers.getContractAt("HomebaseDAO", GOV);
  const rep = await ethers.getContractAt("RepToken", REP);
  const anchorIface = new ethers.Interface(["function anchorCharter(bytes32,string)"]);

  const targets = [REP, ANCHOR];
  const values = [0, 0];
  const calldatas = [
    rep.interface.encodeFunctionData("setMinter", [MIRROR, true]),
    anchorIface.encodeFunctionData("anchorCharter", [HASH, URI]),
  ];

  if ((await rep.delegates(signer.address)) === ethers.ZeroAddress) {
    console.log("self-delegating AREP...");
    await (await rep.delegate(signer.address)).wait();
  }
  console.log("votes:", ethers.formatEther(await rep.getVotes(signer.address)));

  const tx = await gov.propose(targets, values, calldatas, DESC);
  const rc = await tx.wait();
  const ev = rc.logs.map(l => { try { return gov.interface.parseLog(l); } catch { return null; } })
    .find(e => e && e.name === "ProposalCreated");
  console.log("proposalId:", ev.args.proposalId.toString());
  console.log("voteStart:", ev.args.voteStart.toString(), "voteEnd:", ev.args.voteEnd.toString());
  console.log("\nNext: npx hardhat run scripts/vote-genesis.js --network", hre.network.name);
}
main().catch(e => { console.error(e); process.exit(1); });
