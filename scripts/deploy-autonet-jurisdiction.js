/**
 * Deploy Autonet Jurisdiction — the DAO suite wired for the Autonet network.
 *
 * NOTE: the legacy jurisdiction-local token (Autonet.sol, the "RPB") was DELETED
 * from this suite — ATN lives on the external autonet Substrate contract, and
 * this script never deploys a local ATN token. The jurisdiction's Autonet
 * integration surface is the genesis satellites: AutonetVault (sells Substrate
 * ATN for whitelisted ERC20s) and AutonetRepClaim (REP for ATN earned on
 * the Substrate).
 *
 * This script performs the full deployment flow:
 *   1. Deploy TrustlessFactory + sub-factories (if not already deployed)
 *   2. 3-step DAO deployment (Infrastructure → DAOToken → Configure & Finalize)
 *   3. Genesis satellites (AutonetVault + AutonetRepClaim) — see the GENESIS
 *      block below for the PREDICT_VAULT / RESUME cross-repo choreography
 *
 * Usage:
 *   npx hardhat run scripts/deploy-autonet-jurisdiction.js --network localhost
 *   npx hardhat run scripts/deploy-autonet-jurisdiction.js --network ets
 *
 * Governance timing (all in SECONDS, no hidden multipliers — see the units
 * note at the constants below):
 *   VOTING_DELAY_SECS    delay between propose and vote start (default 60)
 *   VOTING_PERIOD_SECS   voting window (default 604800 = 1 week)
 *   TIMELOCK_DELAY_SECS  timelock execution delay (default 60)
 *
 * TEST NETWORKS (shadownet genesis): the proposal lifecycle must be FAST —
 * no voting delay, ~2 minute voting window, no execution delay:
 *   VOTING_DELAY_SECS=0 VOTING_PERIOD_SECS=120 TIMELOCK_DELAY_SECS=0 \
 *   npx hardhat run scripts/deploy-autonet-jurisdiction.js --network ets
 *
 * Prerequisites:
 *   - For localhost: `npx hardhat node` running in another terminal
 *   - For ets/etm: PRIVATE_KEY in .env
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// Configuration — adjust these for your jurisdiction
// ─────────────────────────────────────────────────────────────────────────────

const JURISDICTION_NAME = "Autonet";
const TOKEN_NAME = "Autonet Rep";
const TOKEN_SYMBOL = "AREP";

// ─── Governance timing — UNITS PATH (read before changing) ──────────────────
//
// The factories interpret governor timing values as MINUTES, and the governor
// clock is TIMESTAMP-based — two facts that combined to turn the old constant
// `VOTING_PERIOD = 50400` ("~1 week in blocks", a block-count figure from OZ
// docs) into 3,024,000 SECONDS (35 days) on-chain:
//
//   script seconds/60 → govParams.votingPeriod → TrustlessFactory.deployDAOToken
//   → daoSettings[1] → DAOFactory.deployDAO (names it `minsVoting`)
//   → HomebaseDAO constructor: GovernorSettings(minsDelay * 1 minutes,
//     minsVoting * 1 minutes, …)                      ← the hidden ×60
//
//   RepToken.CLOCK_MODE() == "mode=timestamp" (RepToken.sol:283), so
//   GovernorSettings values are SECONDS, not blocks: 50400 × 60 = 3,024,000 s.
//
//   The governor's votingDelay rides the SAME ×60: govParams.votingDelay
//   (misleadingly named — it is the VOTING DELAY, not the timelock's) →
//   daoSettings[0] → `minsDelay * 1 minutes`. The old hardcoded 1 → 60 s.
//
//   The TIMELOCK minDelay takes a separate ×60 path: script minutes →
//   TrustlessFactory.deployInfrastructure(timelockDelayInMinutes) →
//   InfrastructureFactory.deployTimelock(admin, timelockDelayInMinutes *
//   1 minutes). The old TIMELOCK_DELAY_MINUTES = 1 → minDelay 60 s.
//
// The env vars below are SECONDS with no hidden multipliers: the script
// divides by 60 (rounding UP — the factories cannot express sub-minute
// granularity; 0 stays 0) before handing values to the minutes-based factory.
//
// Shadownet/test-network genesis (fast lifecycle, per user ruling):
//   VOTING_DELAY_SECS=0 VOTING_PERIOD_SECS=120 TIMELOCK_DELAY_SECS=0

function envSeconds(name, defaultSecs) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultSecs;
  const secs = Number(raw);
  if (!Number.isInteger(secs) || secs < 0) {
    throw new Error(`${name} must be a non-negative integer (seconds), got "${raw}"`);
  }
  return secs;
}

// Seconds → the factories' whole-minute unit (rounded up; warn on remainder).
function toFactoryMinutes(name, secs) {
  if (secs % 60 !== 0) {
    const mins = Math.ceil(secs / 60);
    console.warn(`  WARNING: ${name}=${secs}s is not a whole minute — the ` +
      `factory only takes minutes; rounding UP to ${mins} min (${mins * 60}s).`);
    return mins;
  }
  return secs / 60;
}

const VOTING_DELAY_SECS = envSeconds("VOTING_DELAY_SECS", 60);        // was govParams.votingDelay=1 (min)
const VOTING_PERIOD_SECS = envSeconds("VOTING_PERIOD_SECS", 604800);  // ~1 week INTENT, correctly expressed
const TIMELOCK_DELAY_SECS = envSeconds("TIMELOCK_DELAY_SECS", 60);    // was TIMELOCK_DELAY_MINUTES=1

const PROPOSAL_THRESHOLD = ethers.parseEther("10"); // 10 tokens to propose
const QUORUM_FRACTION = 4;             // 4% — one 1000-AREP voter clears it (needs 40)

// Economy parameters
const ARBITRATION_FEE_BPS = 250;       // 2.5%
const PLATFORM_FEE_BPS = 250;         // 2.5%
const AUTHOR_FEE_BPS = 500;           // 5%
const COOLING_OFF_PERIOD = 259200;     // 3 days
const BACKERS_QUORUM_BPS = 5100;      // 51%
const PROJECT_THRESHOLD = ethers.parseEther("10");
const APPEAL_PERIOD = 604800;          // 7 days

// ─────────────────────────────────────────────────────────────────────────────
// Helper: parse event from receipt
// ─────────────────────────────────────────────────────────────────────────────

function findEvent(receipt, contract, eventName) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed.name === eventName) return parsed;
    } catch (e) {
      // Not from this contract
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GENESIS — AutonetVault + AutonetRepClaim + cross-repo choreography
// ─────────────────────────────────────────────────────────────────────────────
//
// The full genesis is a TWO-RUN flow because of a circular address dependency:
//   - Substrate.sol (autonet repo) has NO admin keys, so the address allowed to
//     call mintFromVault (VAULT_MINTER) must be a CONSTRUCTOR arg;
//   - AutonetVault stores the Substrate address as an IMMUTABLE constructor arg.
// Neither contract CALLS the other at construction, so the cycle is broken by
// PREDICTING the vault address from (deployer, nonce) before Substrate deploys:
//
//   run 1 (this script, no env):        DAO suite                [phase 1]
//   run 2 (PREDICT_VAULT=1):            prints predicted vault    [no txs]
//   autonet repo:                       deploy Substrate with
//                                       VAULT_MINTER=<predicted>
//   run 3 (RESUME=1 SUBSTRATE_ADDRESS=0x.. [EXPECTED_VAULT=..]):
//                                       vault (asserted) + claim  [phase 2]
//
// NONCE CAVEAT: between PREDICT_VAULT and RESUME, the deployer account must
// send NO transactions — the vault MUST be the next CREATE from that account.
//
// For local/test networks where the Substrate stand-in does not gate the
// minter, a single fresh run with SUBSTRATE_ADDRESS (+DEPLOY_VAULT=1) does
// everything in one go (the prediction step is unnecessary there).

function jurisdictionJsonPath(network) {
  return path.join(__dirname, "..", "deployments",
    `autonet-jurisdiction-${network.name}.json`);
}

function loadJurisdiction(network) {
  const p = jurisdictionJsonPath(network);
  if (!fs.existsSync(p)) {
    throw new Error(
      `No jurisdiction deployment at ${p} — run phase 1 first ` +
      `(this script without PREDICT_VAULT/RESUME).`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// PREDICT_VAULT=1 — print the address the AutonetVault WILL get if it is the
// next CREATE from the deployer (i.e. the first tx of the RESUME run). No txs.
async function predictVault(deployer, network) {
  loadJurisdiction(network); // asserts phase 1 is done
  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const predicted = ethers.getCreateAddress({ from: deployer.address, nonce });
  console.log("=== VAULT ADDRESS PREDICTION (no transactions sent) ===");
  console.log(`  deployer: ${deployer.address}`);
  console.log(`  nonce:    ${nonce}`);
  console.log(`  PREDICTED AutonetVault address: ${predicted}`);
  console.log();
  console.log("Use this as Substrate's VAULT_MINTER constructor arg (autonet repo).");
  console.log("CAVEAT: send NO transactions from this deployer until the RESUME run,");
  console.log("or the nonce shifts and the prediction is wrong. Then run:");
  console.log(`  RESUME=1 SUBSTRATE_ADDRESS=0x... EXPECTED_VAULT=${predicted} \\`);
  console.log("  npx hardhat run scripts/deploy-autonet-jurisdiction.js --network <net>");
  return { predicted };
}

// Deploy the genesis satellites: AutonetVault first (so the PREDICT_VAULT
// prediction holds on a RESUME run), then AutonetRepClaim (needs the external
// Substrate address). Returns addresses + the timelock grant calldata.
async function deployGenesisSatellites(deployer, params) {
  const { substrateAddr, atnAddr, registryAddr, timelockAddr, repTokenAddr, economyAddr } = params;
  const out = { vault: null, repClaim: null };

  // ── AutonetVault ──────────────────────────────────────────────────────────
  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const predicted = ethers.getCreateAddress({ from: deployer.address, nonce });
  const Vault = await ethers.getContractFactory("AutonetVault");
  const vault = await Vault.deploy(atnAddr, registryAddr, timelockAddr);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  if (vaultAddr.toLowerCase() !== predicted.toLowerCase()) {
    throw new Error(`Vault address ${vaultAddr} != predicted ${predicted} (nonce race?)`);
  }
  if (process.env.EXPECTED_VAULT &&
      vaultAddr.toLowerCase() !== process.env.EXPECTED_VAULT.toLowerCase()) {
    throw new Error(
      `AutonetVault deployed at ${vaultAddr}, but Substrate was constructed with ` +
      `VAULT_MINTER=${process.env.EXPECTED_VAULT}. The deployer nonce moved between ` +
      `PREDICT_VAULT and RESUME — this vault can NEVER mint. Redeploy Substrate with ` +
      `the new vault address, or re-run prediction and redo the autonet-side deploy.`);
  }
  console.log(`  AutonetVault:      ${vaultAddr}`);
  console.log(`    atn (mint target): ${atnAddr}`);
  console.log(`    admin (timelock):  ${timelockAddr}`);
  out.vault = { address: vaultAddr, atn: atnAddr };

  // ── AutonetRepClaim ───────────────────────────────────────────────────────
  // Mints REP to agents 1:1 for ATN they earned on the Substrate. Replaces the
  // retired ReputationMirror. Deployed with an empty genesis seed, so the minter
  // grant can follow (see scripts/deploy-autonet-rep-claim.js).
  if (substrateAddr) {
    const Claim = await ethers.getContractFactory("AutonetRepClaim");
    const claim = await Claim.deploy(substrateAddr, repTokenAddr, [], []);
    await claim.waitForDeployment();
    const claimAddr = await claim.getAddress();
    console.log(`  AutonetRepClaim:   ${claimAddr}`);
    console.log(`    substrate: ${substrateAddr}`);

    // RepToken.admin goes RepTokenFactory -> TrustlessFactory -> Timelock and
    // never the deployer, so the minter grant is a governance proposal.
    const rep = await ethers.getContractAt("RepToken", repTokenAddr);
    const grantCalldata = rep.interface.encodeFunctionData(
      "setMinter", [claimAddr, true]);
    out.repClaim = { address: claimAddr, grantCalldata };

    // ── ToolBond ────────────────────────────────────────────────────────────
    // ATN stakes behind tools that replace a core harness part. The arbiter
    // defaults to the timelock (the DAO rules itself until it appoints one).
    // Amounts are ATN base units (1 ATN = 1e6).
    const economy = await ethers.getContractAt("Economy", economyAddr);
    const arbiterWindow = BigInt(process.env.TOOLBOND_ARBITER_WINDOW_SECS || 7 * 86400);
    const unbondDelay = arbiterWindow + (await economy.effectiveAppealPeriod()) + 86400n;
    const Bond = await ethers.getContractFactory("ToolBond");
    const toolBond = await Bond.deploy(
      substrateAddr, economyAddr, timelockAddr,
      process.env.TOOLBOND_ARBITER || timelockAddr,
      process.env.TOOLBOND_MIN_STAKE || 100_000_000n,
      process.env.TOOLBOND_COUNTER_BOND || 10_000_000n,
      arbiterWindow, unbondDelay);
    await toolBond.waitForDeployment();
    out.toolBond = { address: await toolBond.getAddress() };
    console.log(`  ToolBond:          ${out.toolBond.address}`);
  } else {
    console.log("  AutonetRepClaim, ToolBond: SKIPPED (set SUBSTRATE_ADDRESS to deploy them)");
  }
  return out;
}

// Print Registry.editRegistry calldata for post-finalize parity whitelisting
// (on a fresh run, prefer folding parities into configureAndFinalize via
// PARITY_TOKENS/PARITY_VALUES instead — no proposal needed).
async function printParityCalldata(registryAddr) {
  const tokens = (process.env.PARITY_TOKENS || "").split(",").filter(Boolean);
  const values = (process.env.PARITY_VALUES || "").split(",").filter(Boolean);
  if (!tokens.length) return;
  if (tokens.length !== values.length) {
    throw new Error("PARITY_TOKENS and PARITY_VALUES length mismatch");
  }
  const reg = await ethers.getContractAt("Registry", registryAddr);
  console.log("\n  Parity whitelist calldata (Registry is timelock-owned — DAO proposals):");
  for (let i = 0; i < tokens.length; i++) {
    const key = `jurisdiction.parity.${tokens[i].trim().toLowerCase()}`;
    const cd = reg.interface.encodeFunctionData("editRegistry", [key, values[i].trim()]);
    console.log(`    ${tokens[i]} -> ${values[i]}`);
    console.log(`      Target: ${registryAddr}  Value: 0`);
    console.log(`      Calldata: ${cd}`);
  }
}

// The ordered cross-repo genesis choreography. Printed at the end of every run
// so the operator always sees where they are and what remains.
function printGenesisChecklist(ctx) {
  const { registryAddr, timelockAddr, repTokenAddr, vault, repClaim, substrateAddr } = ctx;
  const done = (cond) => (cond ? "[DONE]" : "[TODO]");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   AUTONET GENESIS — CROSS-REPO CHOREOGRAPHY (in order)   ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`
 1. ${done(true)} [THIS REPO] DAO suite deployed & finalized.
       Timelock ${timelockAddr} owns Registry, RepToken and Economy.

 2. ${done(!!vault)} [THIS REPO] Predict the vault address:
       PREDICT_VAULT=1 npx hardhat run scripts/deploy-autonet-jurisdiction.js --network <net>
       NONCE CAVEAT: after predicting, send NO txs from the deployer until step 4.

 3. ${done(!!substrateAddr)} [AUTONET REPO] Deploy Substrate with the predicted vault:
       scripts/deploy_substrate.js there, constructor (all immutable, no admin keys):
         treasury = ${registryAddr}  (Registry)
         vaultMinter = <predicted vault>
         governor = ${timelockAddr}  (Timelock, retunes the service fee)
         REP_TOKEN = ${repTokenAddr}  (anchor signatures are weighed in its votes)
         ANCHOR_QUORUM_BPS (5000 = more than half of REP votes must sign)
         GENESIS_SIGNERS / GENESIS_QUORUM (only used while no REP exists)
       Anchor signers are registered agents: REP held by members only counts
       once delegated to an agent.
       CIRCULAR-ADDRESS NOTE: Substrate needs the vault address at construction
       and the vault needs Substrate's address at construction. Neither calls
       the other in its constructor, so the cycle is broken by deploying
       Substrate FIRST against the nonce-predicted vault address (step 2).

 4. ${done(!!vault)} [THIS REPO] Deploy the satellites (vault MUST be the first tx):
       RESUME=1 SUBSTRATE_ADDRESS=<substrate> EXPECTED_VAULT=<predicted> \\
       npx hardhat run scripts/deploy-autonet-jurisdiction.js --network <net>
       ${vault ? `AutonetVault:     ${vault.address}` : ""}
       ${repClaim ? `AutonetRepClaim:  ${repClaim.address}` : ""}
       ${ctx.toolBond ? `ToolBond:         ${ctx.toolBond.address}` : ""}

 5. [AUTONET REPO] Deploy CharterAnchor governed by THIS jurisdiction.
       CharterAnchor.governor is an IMMUTABLE constructor arg with NO transfer
       path (verified: contracts/core/CharterAnchor.sol — \`address public
       immutable governor\`, no setter). A jurisdiction-governed anchor
       therefore requires a (re)deploy with EXACTLY these constructor args:
         new CharterAnchor(${timelockAddr})   // governor = this timelock
       Then anchor charter v1 via a DAO proposal:
         target=CharterAnchor, calldata=anchorCharter(<sha256 hash>, <uri>).

 6. ${repClaim ? "[TODO]" : "[TODO after step 4]"} [DAO GOVERNANCE] Grant the rep claim mint rights (proposal -> queue -> execute):
       Target : ${repTokenAddr}
       Value  : 0
       Calldata (RepToken.setMinter(repClaim, true)):
       ${repClaim ? repClaim.grantCalldata : "<printed by the RESUME run>"}
       (Not executable by the deployer at any point: RepToken.admin goes
        RepTokenFactory -> TrustlessFactory -> Timelock, never the EOA.)

 7. [DAO GOVERNANCE] Whitelist vault payment tokens (if not folded into
    finalize with PARITY_TOKENS/PARITY_VALUES on the phase-1 run):
       Registry.editRegistry("jurisdiction.parity.<lowercase token>", "<parity>")
       parity is the jurisdiction-wide value in 18-dec REP units; 1 ATN prices
       like 1 REP (1 USDC(6d) -> 1 REP or 1 ATN: 1e30; 1 DAI(18d): 1e18).

 After 1-7 the jurisdiction is fully wired: vault sells ATN for whitelisted
 tokens (payment -> Registry treasury, ATN minted on Substrate), rep claim turns
 earned ATN into agent RepToken, charter is anchored under DAO control.`);
}

// RESUME=1 — phase 2: load the phase-1 deployment and deploy vault + rep claim.
async function resumeGenesis(deployer, network) {
  const substrateAddr = process.env.SUBSTRATE_ADDRESS;
  if (!substrateAddr) {
    throw new Error("RESUME=1 requires SUBSTRATE_ADDRESS=0x... (the deployed autonet Substrate)");
  }
  const info = loadJurisdiction(network);
  const { registry, timelock, repToken, economy } = info.dao;

  console.log("=== GENESIS RESUME (phase 2): AutonetVault + AutonetRepClaim ===");
  console.log(`  jurisdiction: ${info.jurisdiction} (${network.name})`);
  const sat = await deployGenesisSatellites(deployer, {
    substrateAddr,
    atnAddr: substrateAddr, // the vault mints on the external Substrate
    registryAddr: registry,
    timelockAddr: timelock,
    repTokenAddr: repToken,
    economyAddr: economy,
  });

  info.substrate = substrateAddr;
  info.vault = { autonetVault: sat.vault.address, atn: substrateAddr };
  if (sat.repClaim) {
    info.repClaim = { autonetRepClaim: sat.repClaim.address, substrate: substrateAddr };
    info.toolBond = sat.toolBond.address;
  }
  fs.writeFileSync(jurisdictionJsonPath(network), JSON.stringify(info, null, 2));
  console.log(`  Deployment JSON updated: ${jurisdictionJsonPath(network)}`);

  await printParityCalldata(registry);
  printGenesisChecklist({
    registryAddr: registry,
    timelockAddr: timelock,
    repTokenAddr: repToken,
    vault: sat.vault,
    repClaim: sat.repClaim,
    toolBond: sat.toolBond,
    substrateAddr,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);

  // Genesis sub-modes (see GENESIS block above): prediction and phase-2 resume.
  if (process.env.PREDICT_VAULT === "1") {
    await predictVault(deployer, network);
    return;
  }
  if (process.env.RESUME === "1") {
    await resumeGenesis(deployer, network);
    return;
  }

  // Fail fast, before any gas is spent: the vault mints on the EXTERNAL
  // Substrate — there is no local ATN token to fall back to (Autonet.sol was
  // deleted; Substrate's ATN is THE token).
  if (process.env.DEPLOY_VAULT === "1" && !process.env.SUBSTRATE_ADDRESS) {
    throw new Error(
      "DEPLOY_VAULT=1 requires SUBSTRATE_ADDRESS=0x... — the jurisdiction has no " +
      "local ATN token (Autonet.sol was removed; Substrate's ATN is THE token). " +
      "Deploy/locate the autonet Substrate first, or use the PREDICT_VAULT/RESUME " +
      "choreography (see the GENESIS block in this script).");
  }

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║       AUTONET JURISDICTION DEPLOYMENT                   ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  Network:  ${network.name} (chain ${network.chainId})`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`  Balance:  ${ethers.formatEther(balance)} ETH`);
  console.log();

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 0: Deploy factories (or load existing)
  // ═══════════════════════════════════════════════════════════════════════════

  let trustlessFactory;
  let nativeProjectAddr, erc20ProjectAddr;

  // Check for existing factory deployment
  const existingPath = path.join(__dirname, "..", "deployments",
    `etherlink-shadownet-trustless.json`);
  const localhostPath = path.join(__dirname, "..", "deployments",
    `localhost-trustless.json`);

  let factoryDeployment = null;
  for (const p of [existingPath, localhostPath]) {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      if (BigInt(data.chainId) === network.chainId) {
        factoryDeployment = data;
        break;
      }
    }
  }

  if (factoryDeployment) {
    console.log("Step 0: Using existing TrustlessFactory deployment");
    console.log(`  TrustlessFactory: ${factoryDeployment.contracts.trustlessFactory}`);

    const TrustlessFactory = await ethers.getContractFactory("TrustlessFactory");
    trustlessFactory = TrustlessFactory.attach(factoryDeployment.contracts.trustlessFactory);
    nativeProjectAddr = factoryDeployment.projectImplementations.nativeProject;
    erc20ProjectAddr = factoryDeployment.projectImplementations.erc20Project;
  } else {
    console.log("Step 0: Deploying fresh TrustlessFactory suite...");

    // Project implementations
    const NativeProject = await ethers.getContractFactory("NativeProject");
    const nativeProject = await NativeProject.deploy();
    await nativeProject.waitForDeployment();
    nativeProjectAddr = await nativeProject.getAddress();
    console.log(`  NativeProject:          ${nativeProjectAddr}`);

    const ERC20Project = await ethers.getContractFactory("ERC20Project");
    const erc20Project = await ERC20Project.deploy();
    await erc20Project.waitForDeployment();
    erc20ProjectAddr = await erc20Project.getAddress();
    console.log(`  ERC20Project:           ${erc20ProjectAddr}`);

    // Sub-factories
    const InfrastructureFactory = await ethers.getContractFactory("InfrastructureFactory");
    const infraFactory = await InfrastructureFactory.deploy();
    await infraFactory.waitForDeployment();
    console.log(`  InfrastructureFactory:  ${await infraFactory.getAddress()}`);

    const DAOFactory = await ethers.getContractFactory("DAOFactory");
    const daoFactory = await DAOFactory.deploy();
    await daoFactory.waitForDeployment();
    console.log(`  DAOFactory:             ${await daoFactory.getAddress()}`);

    const EconomyFactory = await ethers.getContractFactory("EconomyFactory");
    const economyFactory = await EconomyFactory.deploy();
    await economyFactory.waitForDeployment();
    console.log(`  EconomyFactory:         ${await economyFactory.getAddress()}`);

    const RepTokenFactory = await ethers.getContractFactory("RepTokenFactory");
    const repTokenFactory = await RepTokenFactory.deploy();
    await repTokenFactory.waitForDeployment();
    console.log(`  RepTokenFactory:        ${await repTokenFactory.getAddress()}`);

    // TrustlessFactory wrapper
    const TrustlessFactory = await ethers.getContractFactory("TrustlessFactory");
    trustlessFactory = await TrustlessFactory.deploy(
      await infraFactory.getAddress(),
      await daoFactory.getAddress(),
      await economyFactory.getAddress(),
      await repTokenFactory.getAddress()
    );
    await trustlessFactory.waitForDeployment();
    console.log(`  TrustlessFactory:       ${await trustlessFactory.getAddress()}`);

    // Save factory deployment
    const factoryInfo = {
      network: network.name,
      chainId: Number(network.chainId),
      deployer: deployer.address,
      timestamp: new Date().toISOString(),
      projectImplementations: {
        nativeProject: nativeProjectAddr,
        erc20Project: erc20ProjectAddr,
      },
      contracts: {
        infrastructureFactory: await infraFactory.getAddress(),
        daoFactory: await daoFactory.getAddress(),
        economyFactory: await economyFactory.getAddress(),
        repTokenFactory: await repTokenFactory.getAddress(),
        trustlessFactory: await trustlessFactory.getAddress(),
      },
    };
    const factoryOutputPath = path.join(__dirname, "..", "deployments",
      `${network.name}-trustless.json`);
    const deploymentsDir = path.dirname(factoryOutputPath);
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }
    fs.writeFileSync(factoryOutputPath, JSON.stringify(factoryInfo, null, 2));
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: Deploy Infrastructure (Economy, Timelock, Registry)
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("Step 1: Deploying infrastructure (Economy, Timelock, Registry)...");
  console.log(`  Timing: votingDelay=${VOTING_DELAY_SECS}s votingPeriod=${VOTING_PERIOD_SECS}s timelockDelay=${TIMELOCK_DELAY_SECS}s`);
  const tx1 = await trustlessFactory.deployInfrastructure(
    toFactoryMinutes("TIMELOCK_DELAY_SECS", TIMELOCK_DELAY_SECS), // ×60 inside the factory
    ARBITRATION_FEE_BPS
  );
  const receipt1 = await tx1.wait();

  const infraEvent = findEvent(receipt1, trustlessFactory, "InfrastructureDeployed");
  if (!infraEvent) throw new Error("InfrastructureDeployed event not found");

  const economyAddr = infraEvent.args.economy;
  const registryAddr = infraEvent.args.registry;
  const timelockAddr = infraEvent.args.timelock;

  console.log(`  Economy:   ${economyAddr}`);
  console.log(`  Registry:  ${registryAddr}`);
  console.log(`  Timelock:  ${timelockAddr}`);
  console.log();

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: Deploy DAO Token (RepToken + HomebaseDAO)
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("Step 2: Deploying DAO token and Governor...");

  const tokenParams = {
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    initialMembers: [deployer.address],
    initialAmounts: [ethers.parseEther("1000")],  // 1000 AREP to deployer
  };

  const govParams = {
    name: `${JURISDICTION_NAME} DAO`,
    // The governor's voting delay (not the timelock minDelay). Both governor values are in
    // the factory's MINUTES unit (x60 in HomebaseDAO's constructor, timestamp clock); see
    // the units-path note at the constants.
    votingDelay: toFactoryMinutes("VOTING_DELAY_SECS", VOTING_DELAY_SECS),
    votingPeriod: toFactoryMinutes("VOTING_PERIOD_SECS", VOTING_PERIOD_SECS),
    proposalThreshold: PROPOSAL_THRESHOLD,
    quorumFraction: QUORUM_FRACTION,
  };

  const tx2 = await trustlessFactory.deployDAOToken(
    registryAddr,
    timelockAddr,
    tokenParams,
    govParams
  );
  const receipt2 = await tx2.wait();

  const daoTokenEvent = findEvent(receipt2, trustlessFactory, "DAOTokenDeployed");
  if (!daoTokenEvent) throw new Error("DAOTokenDeployed event not found");

  const repTokenAddr = daoTokenEvent.args.repToken;
  const daoAddr = daoTokenEvent.args.dao;

  console.log(`  RepToken:  ${repTokenAddr}`);
  console.log(`  DAO:       ${daoAddr}`);
  console.log();

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: Configure & Finalize
  // ═══════════════════════════════════════════════════════════════════════════

  console.log("Step 3: Configuring and finalizing DAO suite...");

  const addressParams = {
    implAddresses: [nativeProjectAddr, erc20ProjectAddr],
    contractAddresses: [economyAddr, registryAddr, timelockAddr, repTokenAddr, daoAddr],
  };

  const economyParams = {
    arbitrationFeeBps: ARBITRATION_FEE_BPS,
    initialPlatformFeeBps: PLATFORM_FEE_BPS,
    initialAuthorFeeBps: AUTHOR_FEE_BPS,
    initialCoolingOffPeriod: COOLING_OFF_PERIOD,
    initialBackersQuorumBps: BACKERS_QUORUM_BPS,
    initialProjectThreshold: PROJECT_THRESHOLD,
    initialAppealPeriod: APPEAL_PERIOD,
  };

  // Registry entries: parity for native currency + jurisdiction name
  const NATIVE_CURRENCY = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const registryKeys = [
    `jurisdiction.parity.${NATIVE_CURRENCY}`,
    "jurisdiction.name",
  ];
  const registryValues = [
    "1000000000000000000",  // 1:1 parity
    JURISDICTION_NAME,
  ];

  // Fold vault payment-token parities into finalize (the Registry is still
  // factory-owned here — after finalize, parity edits need a DAO proposal).
  // PARITY_TOKENS=0x..,0x..  PARITY_VALUES=<18dp>,<18dp>
  // REMINDER: ATN is 6-decimal; bake the decimal adjustment into the value.
  if (process.env.PARITY_TOKENS && process.env.PARITY_VALUES) {
    const pTokens = process.env.PARITY_TOKENS.split(",").filter(Boolean);
    const pValues = process.env.PARITY_VALUES.split(",").filter(Boolean);
    if (pTokens.length !== pValues.length) {
      throw new Error("PARITY_TOKENS and PARITY_VALUES length mismatch");
    }
    for (let i = 0; i < pTokens.length; i++) {
      registryKeys.push(`jurisdiction.parity.${pTokens[i].trim().toLowerCase()}`);
      registryValues.push(pValues[i].trim());
      console.log(`  Folding parity into finalize: ${pTokens[i]} -> ${pValues[i]}`);
    }
  }

  const tx3 = await trustlessFactory.configureAndFinalize(
    addressParams,
    economyParams,
    registryKeys,
    registryValues
  );
  await tx3.wait();
  console.log("  DAO suite finalized. Timelock is now admin of all contracts.");
  console.log();

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4 (optional): Genesis satellites — AutonetVault + AutonetRepClaim
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // The jurisdiction has NO local ATN token (Autonet.sol was deleted from the
  // suite) — ATN is the external Substrate's, so both satellites REQUIRE
  // SUBSTRATE_ADDRESS:
  //
  // SUBSTRATE_ADDRESS=0x..— the external autonet Substrate. The vault mints on
  //                         it (IAutonetATN.mintFromVault) and the
  //                         AutonetRepClaim reads agent earnings from it.
  // DEPLOY_VAULT=1        — attach an AutonetVault (CoinOffering-shaped router:
  //                         sells Substrate ATN for registry-whitelisted ERC20s,
  //                         payment -> Registry treasury). Admin = timelock.
  //
  // On a REAL network, prefer the two-run choreography (PREDICT_VAULT/RESUME —
  // see the GENESIS block at the top): Substrate must be constructed with the
  // vault address as VAULT_MINTER, which requires predicting it first. The
  // single-run path here is for local/test networks (mock Substrate).

  const SUBSTRATE_ADDRESS = process.env.SUBSTRATE_ADDRESS || null;
  // (DEPLOY_VAULT=1 without SUBSTRATE_ADDRESS already failed fast at the top of main.)
  let satellites = { vault: null, repClaim: null };
  if (SUBSTRATE_ADDRESS) {
    console.log("Step 4: Deploying genesis satellites (vault + rep claim)...");
    satellites = await deployGenesisSatellites(deployer, {
      substrateAddr: SUBSTRATE_ADDRESS,
      atnAddr: SUBSTRATE_ADDRESS, // the vault mints on the external Substrate
      registryAddr,
      timelockAddr,
      repTokenAddr,
      economyAddr,
    });
    console.log();
  } else {
    console.log("Step 4: satellites SKIPPED (set SUBSTRATE_ADDRESS, or use PREDICT_VAULT/RESUME).");
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SAVE DEPLOYMENT INFO
  // ═══════════════════════════════════════════════════════════════════════════

  const deploymentInfo = {
    jurisdiction: JURISDICTION_NAME,
    network: network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    dao: {
      governor: daoAddr,
      repToken: repTokenAddr,
      economy: economyAddr,
      registry: registryAddr,
      timelock: timelockAddr,
    },
    substrate: SUBSTRATE_ADDRESS,
    vault: satellites.vault
      ? { autonetVault: satellites.vault.address, atn: satellites.vault.atn }
      : null,
    repClaim: satellites.repClaim
      ? { autonetRepClaim: satellites.repClaim.address, substrate: SUBSTRATE_ADDRESS }
      : null,
    toolBond: satellites.toolBond ? satellites.toolBond.address : null,
  };

  // Save jurisdiction deployment
  const outputDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const outputPath = path.join(outputDir,
    `autonet-jurisdiction-${network.name}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(deploymentInfo, null, 2));
  console.log(`Deployment saved to: ${outputPath}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════

  console.log();
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║       AUTONET JURISDICTION DEPLOYED                     ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  DAO Governor:    ${daoAddr}  ║`);
  console.log(`║  RepToken:        ${repTokenAddr}  ║`);
  console.log(`║  Economy:         ${economyAddr}  ║`);
  console.log(`║  Registry:        ${registryAddr}  ║`);
  console.log(`║  Timelock:        ${timelockAddr}  ║`);
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log();

  // (Parities given via PARITY_TOKENS/PARITY_VALUES were folded into finalize
  // above — no proposal needed on a fresh run.)
  printGenesisChecklist({
    registryAddr,
    timelockAddr,
    repTokenAddr,
    vault: satellites.vault,
    repClaim: satellites.repClaim,
    toolBond: satellites.toolBond,
    substrateAddr: SUBSTRATE_ADDRESS,
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
