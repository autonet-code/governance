/** Flag-day proposal (2026-07-10): fees-only emission + REP-from-earnings wiring.
 * ONE governor proposal, FOUR calls:
 *   a. RepToken.setMinter(AutonetRepClaim, true)
 *   b. RepToken.setMinter(ReputationMirror, false)   (mirror currently IS a minter)
 *   c. RepToken.mint(DEV_WALLET, 1000e18)            (genesis REP seed)
 *   d. Registry.editRegistry("jurisdiction.parity.<usdc lc>", "1e18")
 *
 * Env:
 *   GOV, REP, REGISTRY, CLAIM, MIRROR, DEV_WALLET, USDC_LC (lowercase), PARITY
 */
const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const [signer] = await ethers.getSigners();
  const GOV = process.env.GOV;
  const REP = process.env.REP;
  const REGISTRY = process.env.REGISTRY;
  const CLAIM = process.env.CLAIM;
  const MIRROR = process.env.MIRROR;
  const DEV = process.env.DEV_WALLET;
  const USDC_LC = process.env.USDC_LC;   // lowercase hex
  const PARITY = process.env.PARITY;     // "1000000000000000000"
  for (const [k, v] of Object.entries({ GOV, REP, REGISTRY, CLAIM, MIRROR, DEV, USDC_LC, PARITY }))
    if (!v) throw new Error(`missing env ${k}`);

  const DESC = "Flag-day 2026-07-10: grant AutonetRepClaim minter, revoke ReputationMirror, seed 1000 REP to dev wallet, whitelist test-USDC parity 1:1";

  const rep = await ethers.getContractAt("RepToken", REP);
  const reg = await ethers.getContractAt("Registry", REGISTRY);
  const gov = await ethers.getContractAt("HomebaseDAO", GOV);

  const seed = ethers.parseEther("1000"); // 1000e18
  const targets = [REP, REP, REP, REGISTRY];
  const values = [0, 0, 0, 0];
  const calldatas = [
    rep.interface.encodeFunctionData("setMinter", [CLAIM, true]),
    rep.interface.encodeFunctionData("setMinter", [MIRROR, false]),
    rep.interface.encodeFunctionData("mint", [DEV, seed]),
    reg.interface.encodeFunctionData("editRegistry", [`jurisdiction.parity.${USDC_LC}`, PARITY]),
  ];

  console.log("targets:", targets);
  calldatas.forEach((c, i) => console.log(`calldata[${i}]:`, c));

  if ((await rep.delegates(signer.address)) === ethers.ZeroAddress) {
    console.log("self-delegating AREP...");
    await (await rep.delegate(signer.address)).wait();
  }
  console.log("votes:", ethers.formatEther(await rep.getVotes(signer.address)));

  const tx = await gov.propose(targets, values, calldatas, DESC);
  const rc = await tx.wait();
  const ev = rc.logs.map(l => { try { return gov.interface.parseLog(l); } catch { return null; } })
    .find(e => e && e.name === "ProposalCreated");
  console.log("PROPOSAL_ID=" + ev.args.proposalId.toString());
  console.log("PROPOSAL_BLOCK=" + rc.blockNumber);
  console.log("voteStart:", ev.args.voteStart.toString(), "voteEnd:", ev.args.voteEnd.toString());
  console.log("DESC_HASH=" + ethers.keccak256(ethers.toUtf8Bytes(DESC)));
}
main().catch(e => { console.error(e); process.exit(1); });
