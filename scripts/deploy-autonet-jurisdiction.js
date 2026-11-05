/**
 * Deploy an Autonet jurisdiction: a core DAO with the economy and autonet modules attached at
 * origination, the same path the werule wizard takes (docs/modules.md):
 *
 *   1. JurisdictionFactory.deployCore            (Governor, Timelock, Registry, RepToken)
 *   2. EconomySetup.prepareInstallation          (Economy + EconomyRepClaim)
 *   3. AutonetSetup.prepareInstallation          (Substrate, AutonetVault, AutonetRepClaim, ToolBond,
 *                                                 ServiceRegistry, PaymentChannel, AnchorElection;
 *                                                 one tx)
 *   4. JurisdictionFactory.finalize              (jurisdiction.name, parities; attaches both modules:
 *                                                 their grants and jurisdiction.* / modules.* entries,
 *                                                 including jurisdiction.autonet.charter)
 *
 * Autonet doesn't need the Economy; this reference jurisdiction has both.
 *
 * Nothing needs a proposal afterwards. The suite comes from deployments/<etherlink-shadownet|localhost>-jurisdiction.json
 * (scripts/deploy-jurisdiction-suite.js). On a local chain (31337) without a suite (no file, or a file
 * from an earlier node), a fresh suite is deployed first and its addresses go to the output file only.
 * Run scripts/sync-autonet-artifacts.js before deploying the suite so the autonet code blobs hold the
 * current autonet contracts.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-autonet-jurisdiction.js --network ets
 *   Local, everything in one command on a running `npx hardhat node`, with 3-minute epochs possible
 *   (an anchor's lifecycle is the voting delay + period + timelock delay, 2 minutes here):
 *   VOTING_DELAY_SECS=60 VOTING_PERIOD_SECS=60 TIMELOCK_DELAY_SECS=0 EPOCH_TARGET_SHARE=1000  *     BOOTSTRAP=/ip4/127.0.0.1/tcp/4001/p2p/<relay id>  *     npx hardhat run scripts/deploy-autonet-jurisdiction.js --network localhost
 *   Writes deployments/autonet-jurisdiction-<network>.json (OUT overrides the path).
 *
 * Environment (all optional):
 *   VOTING_DELAY_SECS (60) VOTING_PERIOD_SECS (604800): whole minutes. TIMELOCK_DELAY_SECS (60).
 *     Test networks: 0 / 120 / 0.
 *   PARITY_TOKENS=0x..,0x..  PARITY_VALUES=<18dp>,<18dp>: vault payment tokens (1 USDC(6d) = 1e30)
 *   CHALLENGE_WINDOW_SECS (3600), CHARTER (JSON text; default the v1 charter from the module metadata), EPOCH_RULES (the metadata's fixed version)
 *   GENESIS_ROOT (bytes32): the ATN genesis claim root of a fork or split (autonet scripts/build_atn_genesis.py); default none
 *   TOOLBOND_MIN_STAKE (100 ATN) TOOLBOND_REVEAL_WINDOW_SECS (1d) TOOLBOND_DEGRADE_BPS (1000)
 *   TOOLBOND_AUTHOR_SLASH_BPS (10000) TOOLBOND_REVIEWER_SHARE_BPS (4000) TOOLBOND_UNBOND_DELAY_SECS (30d)
 *   TOOLBOND_HARM_WEIGHT_BPS (20000: harm counts twice a charter axis in a review's accuracy)
 *   TOOLBOND_HARM_QUORUM_BPS (10: harm settles once 0.1% of the epoch's REP supply scored it)
 *   TOOLBOND_APPEAL_PERIOD_SECS (10d; never less than one proposal lifecycle plus 2 days)
 *   MEMBERS=0x..,0x..  AMOUNTS=<18dp>,<18dp>: genesis REP (default 1000 AREP to the deployer)
 *   Registry keys recorded at genesis when given (the DAO changes them by proposal):
 *     EPOCH_TARGET_SHARE -> jurisdiction.autonet.epoch_target_share (ppm of the ATN supply burned in
 *       fees that ends an epoch), BOOTSTRAP -> jurisdiction.autonet.bootstrap (comma-separated multiaddrs)
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { encodeInstallData, metadata, deployJurisdictionSuite } = require("./lib/modules");

const JURISDICTION_NAME = "Autonet";
const TOKEN_SYMBOL = "AREP";
const PROPOSAL_THRESHOLD = ethers.parseEther("10");
const QUORUM_FRACTION = 4;

const ECONOMY = {
  arbitrationFeeBps: 250,
  platformFeeBps: 250,
  authorFeeBps: 500,
  coolingOffPeriod: 259200,
  backersQuorumBps: 5100,
  projectThreshold: ethers.parseEther("10"),
  appealPeriod: 604800,
};

const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);
const envBig = (k, d) => BigInt(env(k, d));

// Governor and timelock timing are whole minutes in the factories (x60 inside, timestamp clock)
function minutes(name, d) {
  const secs = Number(env(name, d));
  if (!Number.isInteger(secs) || secs < 0 || secs % 60 !== 0) {
    throw new Error(`${name} must be a whole number of minutes in seconds, got "${env(name, d)}"`);
  }
  return secs / 60;
}

// The suite's factory and setups: from deployments/, or freshly deployed on a local chain
async function loadSuite(network, deployer) {
  for (const name of ["etherlink-shadownet-jurisdiction.json", "localhost-jurisdiction.json"]) {
    const p = path.join(__dirname, "..", "deployments", name);
    if (!fs.existsSync(p)) continue;
    const f = JSON.parse(fs.readFileSync(p, "utf8"));
    if (BigInt(f.chainId) !== network.chainId) continue;
    if ((await ethers.provider.getCode(f.firestoreFields.jurisdictionFactory)) === "0x") continue;
    return { factory: f.firestoreFields.jurisdictionFactory, economy: f.modules.economy.setup, autonet: f.modules.autonet.setup };
  }
  if (network.chainId !== 31337n) {
    throw new Error("No jurisdiction suite for this chain in deployments/; run scripts/deploy-jurisdiction-suite.js first");
  }
  console.log("  No suite on this chain: deploying one");
  const s = await deployJurisdictionSuite(ethers, deployer);
  return { factory: await s.jurisdictionFactory.getAddress(), economy: await s.setups.economy.getAddress(),
    autonet: await s.setups.autonet.getAddress(), fresh: true };
}

async function prepare(setup, from, core, name, values) {
  await (await setup.prepareInstallation(core, encodeInstallData(ethers, name, values))).wait();
  const id = await setup.lastPreparedBy(from.address);
  const [, p] = await setup.installationOf(id);
  return { id, module: p.module };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log(`Autonet jurisdiction on ${network.name} (chain ${network.chainId}), deployer ${deployer.address}`);

  const suite = await loadSuite(network, deployer);
  const factory = await ethers.getContractAt("JurisdictionFactory", suite.factory);
  const economySetup = await ethers.getContractAt("EconomySetup", suite.economy);
  const autonetSetup = await ethers.getContractAt("AutonetSetup", suite.autonet);
  console.log(`  JurisdictionFactory: ${await factory.getAddress()}`);

  // 1. Core
  const params = {
    name: JURISDICTION_NAME, symbol: TOKEN_SYMBOL, description: "", tokenKind: 0, underlying: ethers.ZeroAddress,
    initialMembers: env("MEMBERS", deployer.address).split(",").map((a) => a.trim()),
    initialAmounts: env("AMOUNTS", ethers.parseEther("1000").toString()).split(",").map((a) => BigInt(a.trim())),
    votingDelay: minutes("VOTING_DELAY_SECS", 60), votingPeriod: minutes("VOTING_PERIOD_SECS", 604800),
    proposalThreshold: PROPOSAL_THRESHOLD, quorumFraction: QUORUM_FRACTION,
    executionDelay: Number(env("TIMELOCK_DELAY_SECS", 60)),
    // Share of all REP a constitutional proposal (charter, epoch rules, timelock) needs, 0 = 6667
    supermajorityBps: Number(env("SUPERMAJORITY_BPS", 0)),
  };
  if (params.initialMembers.length !== params.initialAmounts.length) throw new Error("MEMBERS and AMOUNTS length mismatch");
  const c = await factory.deployCore.staticCall(params);
  const deployBlock = (await (await factory.deployCore(params)).wait()).blockNumber;
  const core = { registry: c.registry, timelock: c.timelock, token: c.token, governor: c.governor };
  console.log(`1. Governor ${core.governor}, RepToken ${core.token}, Registry ${core.registry}, Timelock ${core.timelock}`);

  // 2. Economy
  const economy = await prepare(economySetup, deployer, core, "economy", { params: ECONOMY });
  console.log(`2. Economy ${economy.module} (installation ${economy.id})`);

  // 3. Autonet layer
  const bondParams = {
    minStake: envBig("TOOLBOND_MIN_STAKE", 100_000_000n),
    revealWindow: envBig("TOOLBOND_REVEAL_WINDOW_SECS", 86400),
    degradeBps: envBig("TOOLBOND_DEGRADE_BPS", 1000),
    authorSlashBps: envBig("TOOLBOND_AUTHOR_SLASH_BPS", 10000),
    unbondDelay: envBig("TOOLBOND_UNBOND_DELAY_SECS", 30 * 86400),
    reviewerShareBps: envBig("TOOLBOND_REVIEWER_SHARE_BPS", 4000),
    harmWeightBps: envBig("TOOLBOND_HARM_WEIGHT_BPS", 20000),
    harmQuorumBps: envBig("TOOLBOND_HARM_QUORUM_BPS", 10),
    appealPeriod: envBig("TOOLBOND_APPEAL_PERIOD_SECS", 10 * 86400),
  };
  // The current charter, as the module metadata records it
  const charterUi = (name) => metadata("autonet", "build").pluginSetup.prepareInstallation.inputs
    .find((i) => i.name === "substrate").components.find((c) => c.name === name)["x-ui"];
  const autonetParams = {
    challengeWindow: envBig("CHALLENGE_WINDOW_SECS", 3600),
    charter: env("CHARTER", charterUi("charter").default),
    epochRules: env("EPOCH_RULES", charterUi("epochRules").fixed),
    genesisRoot: env("GENESIS_ROOT", ethers.ZeroHash),
    serviceFeeBps: envBig("SERVICE_FEE_BPS", 250),
    feeTreasuryBps: envBig("FEE_TREASURY_BPS", 5000),
  };
  const autonet = await prepare(autonetSetup, deployer, core, "autonet",
    { substrate: autonetParams, toolBond: bondParams });
  const d = await autonetSetup.deploymentOf(autonet.id);
  console.log(`3. Autonet layer (installation ${autonet.id}):`);
  for (const k of ["substrate", "vault", "repClaim", "toolBond", "serviceRegistry", "paymentChannel", "anchorElection"]) {
    console.log(`     ${k.padEnd(20)} ${d[k]}`);
  }

  // 4. Finalize: name, parities, both modules attached
  const keys = ["jurisdiction.name"];
  const values = [JURISDICTION_NAME];
  const pTokens = env("PARITY_TOKENS", "").split(",").filter(Boolean);
  const pValues = env("PARITY_VALUES", "").split(",").filter(Boolean);
  if (pTokens.length !== pValues.length) throw new Error("PARITY_TOKENS and PARITY_VALUES length mismatch");
  pTokens.forEach((t, i) => { keys.push(`jurisdiction.parity.${t.trim().toLowerCase()}`); values.push(pValues[i].trim()); });
  for (const [k, e] of [["epoch_target_share", "EPOCH_TARGET_SHARE"], ["bootstrap", "BOOTSTRAP"]]) {
    if (env(e, "") !== "") { keys.push(`jurisdiction.autonet.${k}`); values.push(env(e, "").trim()); }
  }
  await (await factory.finalize(core, [
    { setup: await economySetup.getAddress(), id: economy.id },
    { setup: await autonetSetup.getAddress(), id: autonet.id },
  ], keys, values)).wait();
  console.log("4. Finalized: timelock owns everything; economy and autonet attached.");

  const out = {
    jurisdiction: JURISDICTION_NAME,
    network: network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    deployBlock,
    suite: { jurisdictionFactory: suite.factory, economySetup: suite.economy, autonetSetup: suite.autonet },
    registryKeys: Object.fromEntries(keys.map((k, i) => [k, values[i]])),
    dao: { governor: core.governor, repToken: core.token, registry: core.registry, timelock: core.timelock },
    economy: { economy: economy.module, installation: Number(economy.id) },
    autonet: {
      installation: Number(autonet.id),
      substrate: d.substrate, vault: d.vault, repClaim: d.repClaim, toolBond: d.toolBond,
      serviceRegistry: d.serviceRegistry, paymentChannel: d.paymentChannel,
      anchorElection: d.anchorElection, charter: d.charter, epochRules: d.epochRules,
    },
  };
  const outPath = env("OUT", path.join(__dirname, "..", "deployments", `autonet-jurisdiction-${network.name}.json`));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Saved ${outPath}`);
  console.log("The 1000 AREP genesis allocation is the deployer's: delegate it (e.g. to the anchor agent) so anchors reach quorum.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
