/**
 * Deploy an Autonet jurisdiction: a trustless-economy DAO plus its whole Autonet layer (Substrate,
 * AutonetVault, AutonetRepClaim, ToolBond, ServiceRegistry, PaymentChannel, VentureVaultFactory,
 * CharterAnchor), the same path the werule wizard takes:
 *
 *   1. TrustlessFactory.deployInfrastructure   (Economy, Timelock, Registry)
 *   2. TrustlessFactory.deployDAOToken         (RepToken, governor)
 *   3. AutonetGenesis.launch                   (the Autonet layer, one tx)
 *   4. TrustlessFactory.configureAndFinalizeWithGrants
 *        registry keys: jurisdiction.name, parities, jurisdiction.autonet.* (from the launch)
 *        grants:        REP claim -> RepToken minter, ToolBond -> RepToken slasher
 *
 * Nothing needs a proposal afterwards. The factory suite (and AutonetGenesis, deployed here if the
 * suite file lacks it) comes from deployments/<network>-trustless.json or
 * deployments/etherlink-shadownet-trustless.json. Run scripts/sync-autonet-artifacts.js first so the
 * genesis code blobs hold the current autonet contracts.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-autonet-jurisdiction.js --network ets
 *
 * Environment (all optional):
 *   VOTING_DELAY_SECS (60) VOTING_PERIOD_SECS (604800) TIMELOCK_DELAY_SECS (60): whole minutes,
 *     the factories take minutes. Test networks: 0 / 120 / 0.
 *   PARITY_TOKENS=0x..,0x..  PARITY_VALUES=<18dp>,<18dp>: vault payment tokens (1 USDC(6d) = 1e30)
 *   ANCHOR_QUORUM_BPS (5000), GENESIS_SIGNERS (none; comma list), GENESIS_QUORUM (0)
 *   CHALLENGE_WINDOW_SECS (3600), CHARTER_HASH (none), CHARTER_URI
 *   TOOLBOND_MIN_STAKE (100 ATN) TOOLBOND_THRESHOLD_BPS (500) TOOLBOND_REVIEW_WINDOW_SECS (14d)
 *   TOOLBOND_REVEAL_WINDOW_SECS (2d) TOOLBOND_FINDER_BPS (5000) TOOLBOND_DEGRADE_BPS (1000)
 *   TOOLBOND_AUTHOR_SLASH_BPS (10000) TOOLBOND_AUDITOR_SHARE_BPS (4000) TOOLBOND_UNBOND_DELAY_SECS (30d)
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deployAutonetGenesis } = require("./lib/autonet-genesis");

const JURISDICTION_NAME = "Autonet";
const TOKEN_NAME = "Autonet Rep";
const TOKEN_SYMBOL = "AREP";
const PROPOSAL_THRESHOLD = ethers.parseEther("10");
const QUORUM_FRACTION = 4;

const ECONOMY = {
  arbitrationFeeBps: 250,
  initialPlatformFeeBps: 250,
  initialAuthorFeeBps: 500,
  initialCoolingOffPeriod: 259200,
  initialBackersQuorumBps: 5100,
  initialProjectThreshold: ethers.parseEther("10"),
  initialAppealPeriod: 604800,
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

function event(receipt, contract, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === name) return parsed.args;
    } catch (e) { /* another contract's log */ }
  }
  throw new Error(`${name} event not found`);
}

function suiteFile(network) {
  for (const name of [`${network.name}-trustless.json`, "etherlink-shadownet-trustless.json", "localhost-trustless.json"]) {
    const p = path.join(__dirname, "..", "deployments", name);
    if (fs.existsSync(p) && BigInt(JSON.parse(fs.readFileSync(p, "utf8")).chainId) === network.chainId) return p;
  }
  throw new Error("No TrustlessFactory suite for this chain in deployments/; deploy the suite first");
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log(`Autonet jurisdiction on ${network.name} (chain ${network.chainId}), deployer ${deployer.address}`);

  const suitePath = suiteFile(network);
  const suite = JSON.parse(fs.readFileSync(suitePath, "utf8"));
  const factory = await ethers.getContractAt("TrustlessFactory", suite.contracts.trustlessFactory);
  let genesis;
  if (suite.contracts.autonetGenesis) {
    genesis = await ethers.getContractAt("AutonetGenesis", suite.contracts.autonetGenesis);
  } else {
    console.log("Deploying AutonetGenesis (not in the suite file yet)...");
    genesis = await deployAutonetGenesis(ethers, deployer, console.log);
    suite.contracts.autonetGenesis = await genesis.getAddress();
    fs.writeFileSync(suitePath, JSON.stringify(suite, null, 2));
  }
  console.log(`  TrustlessFactory: ${await factory.getAddress()}`);
  console.log(`  AutonetGenesis:   ${await genesis.getAddress()}`);

  // 1. Infrastructure
  const infra = event(await (await factory.deployInfrastructure(minutes("TIMELOCK_DELAY_SECS", 60), ECONOMY.arbitrationFeeBps)).wait(),
    factory, "InfrastructureDeployed");
  console.log(`1. Economy ${infra.economy}, Registry ${infra.registry}, Timelock ${infra.timelock}`);

  // 2. RepToken + governor
  const tok = event(await (await factory.deployDAOToken(infra.registry, infra.timelock,
    { name: TOKEN_NAME, symbol: TOKEN_SYMBOL, initialMembers: [deployer.address], initialAmounts: [ethers.parseEther("1000")] },
    { name: `${JURISDICTION_NAME} DAO`, votingDelay: minutes("VOTING_DELAY_SECS", 60), votingPeriod: minutes("VOTING_PERIOD_SECS", 604800),
      proposalThreshold: PROPOSAL_THRESHOLD, quorumFraction: QUORUM_FRACTION })).wait(), factory, "DAOTokenDeployed");
  console.log(`2. RepToken ${tok.repToken}, DAO ${tok.dao}`);

  // 3. Autonet layer
  const reviewWindow = envBig("TOOLBOND_REVIEW_WINDOW_SECS", 14 * 86400);
  const revealWindow = envBig("TOOLBOND_REVEAL_WINDOW_SECS", 2 * 86400);
  const bondParams = {
    minStake: envBig("TOOLBOND_MIN_STAKE", 100_000_000n),
    thresholdBps: envBig("TOOLBOND_THRESHOLD_BPS", 500),
    reviewWindow,
    revealWindow,
    finderBps: envBig("TOOLBOND_FINDER_BPS", 5000),
    degradeBps: envBig("TOOLBOND_DEGRADE_BPS", 1000),
    authorSlashBps: envBig("TOOLBOND_AUTHOR_SLASH_BPS", 10000),
    // Long enough for a review, a reveal and an appeal (the appeal window is set at finalize)
    unbondDelay: envBig("TOOLBOND_UNBOND_DELAY_SECS", 30 * 86400),
    auditorShareBps: envBig("TOOLBOND_AUDITOR_SHARE_BPS", 4000),
  };
  const signers = env("GENESIS_SIGNERS", "").split(",").map((s) => s.trim()).filter(Boolean);
  const autonetParams = {
    anchorQuorumBps: Number(env("ANCHOR_QUORUM_BPS", 5000)),
    genesisSigners: signers,
    genesisQuorum: Number(env("GENESIS_QUORUM", 0)),
    challengeWindow: envBig("CHALLENGE_WINDOW_SECS", 3600),
    charterHash: env("CHARTER_HASH", ethers.ZeroHash),
    charterUri: env("CHARTER_URI", ""),
  };
  const j = { registry: infra.registry, timelock: infra.timelock, repToken: tok.repToken, economy: infra.economy, dao: tok.dao };
  await (await genesis.launch(j, autonetParams, bondParams)).wait();
  const d = await genesis.deploymentOf(tok.repToken);
  console.log("3. Autonet layer:");
  for (const k of ["substrate", "vault", "repClaim", "toolBond", "serviceRegistry", "paymentChannel", "ventureVaultFactory", "charterAnchor"]) {
    console.log(`     ${k.padEnd(20)} ${d[k]}`);
  }

  // 4. Finalize with registry entries and grants
  const [autonetKeys, autonetValues] = await genesis.registryEntries(tok.repToken);
  const keys = ["jurisdiction.name", ...autonetKeys];
  const values = [JURISDICTION_NAME, ...autonetValues];
  const pTokens = env("PARITY_TOKENS", "").split(",").filter(Boolean);
  const pValues = env("PARITY_VALUES", "").split(",").filter(Boolean);
  if (pTokens.length !== pValues.length) throw new Error("PARITY_TOKENS and PARITY_VALUES length mismatch");
  pTokens.forEach((t, i) => { keys.push(`jurisdiction.parity.${t.trim().toLowerCase()}`); values.push(pValues[i].trim()); });
  await (await factory.configureAndFinalizeWithGrants(
    { implAddresses: [suite.projectImplementations.nativeProject, suite.projectImplementations.erc20Project],
      contractAddresses: [infra.economy, infra.registry, infra.timelock, tok.repToken, tok.dao] },
    ECONOMY, keys, values, [d.repClaim], [d.toolBond])).wait();
  console.log("4. Finalized: timelock owns everything; REP claim is a minter, ToolBond a slasher.");

  const out = {
    jurisdiction: JURISDICTION_NAME,
    network: network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    autonetGenesis: await genesis.getAddress(),
    dao: { governor: tok.dao, repToken: tok.repToken, economy: infra.economy, registry: infra.registry, timelock: infra.timelock },
    autonet: {
      substrate: d.substrate, vault: d.vault, repClaim: d.repClaim, toolBond: d.toolBond,
      serviceRegistry: d.serviceRegistry, paymentChannel: d.paymentChannel,
      ventureVaultFactory: d.ventureVaultFactory, charterAnchor: d.charterAnchor,
    },
  };
  const outPath = path.join(__dirname, "..", "deployments", `autonet-jurisdiction-${network.name}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Saved ${outPath}`);
  console.log("The 1000 AREP genesis allocation is the deployer's: delegate it (e.g. to the anchor agent) so anchors reach quorum.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
