# Deployments

Addresses, build commands, deploy scripts and the local end-to-end harnesses. API details are in [technical-reference.md](technical-reference.md); the Autonet genesis flow is in [autonet.md](autonet.md).

## Deployed addresses

### Etherlink Shadownet (chainId 127823)

> **Pre-modules suite, pending redeploy.** The live Shadownet contracts below are the suite deployed 2026-10-13, before the [module](modules.md) refactor: per-kind factories (StandardFactory family, TrustlessFactory with EconomyFactory) that no longer exist in this repo. A redeploy with `scripts/deploy-jurisdiction-suite.js` replaces them with JurisdictionFactory, ModuleCatalog, ModuleProcessor and the module setups, under the new Firestore fields listed below.

Deployed 2026-10-13. **The source of truth is Firestore `contracts/Etherlink-Shadownet`** (in both `homebase-6907d` and `trustless-58262`); the web apps and the indexer read factory and implementation addresses from there. The old Ghostnet testnet (chainId 128123) is retired.

| Contract | Firestore field | Address |
|----------|-----------------|---------|
| StandardFactory | `wrapper` | `0x60E813F889c4c29eB4FB8614fa37fFA7587e305B` |
| StandardFactoryTransferable | `wrapper_t` | `0xAffB86fD7C552c1313C5ACF17fCCA38f3846319A` |
| StandardFactoryWrapped | `wrapper_w` | `0xd8dfad1Aae03BF9b193eE362e7764CEa2c7A0f1B` |
| TrustlessFactory | `wrapper_trustless` | `0xd3aDda8626C18ec4E85985cc6B489d96D836C07f` |
| NativeProject implementation | `nativeProjectImpl` | `0x97969B2dE8C60A94Dc2Ee6019aD7E3C5Ef119E4B` |
| ERC20Project implementation | `erc20ProjectImpl` | `0x0f607F4dFD86EA3FA0155576b1d22EaA8A72A0Fa` |
| InfrastructureFactory | | `0xC32Dd770Aad25d3693fA8C36f7E6D9Fc9874F667` |
| DAOFactory | | `0xE6c4A9c8cb7a5872Ac9Bdd2b6916b75576Dd263F` |
| RepTokenFactory | | `0x42998c90EE035F3FB89C222b519C4553bE886ed7` |
| EconomyFactory | | `0x5675e32c042eeeF863F7B06FB3cEbb48D1175FDb` |
| WrappedRepTokenFactory | | `0x4d14Fd053337D467C625057780d1b258F84FF4Aa` |

Everything was deployed together by the since-removed full-suite script (output in `deployments/etherlink-shadownet-full-suite.json`). Economies created through the web app take implementation addresses from Firestore, so project-only changes do not need a factory redeploy (on the pre-modules suite).

After the redeploy, `contracts/<network>` holds these fields (written to `deployments/<etherlink-shadownet|localhost>-jurisdiction.json` by `scripts/deploy-jurisdiction-suite.js`); `wrapper`, `wrapper_t`, `wrapper_w`, `wrapper_trustless` and `autonetGenesis` go away:

| Field | Contract |
|-------|----------|
| `jurisdictionFactory` | JurisdictionFactory (the indexer watches its `NewDaoCreated`) |
| `moduleCatalog` | ModuleCatalog (modules, versions, metadata; werule lists modules from it) |
| `moduleProcessor` | ModuleProcessor (builds attach and detach proposals) |
| `nativeProject`, `erc20Project` | Project implementations (EconomySetup also holds them as immutables) |

The JSON file also records the sub-factories and each module's setup, repo and version.

Autonet satellites on Shadownet (vault, REP claim, Substrate) are recorded in each jurisdiction's own Registry under `jurisdiction.autonet.substrate`, `jurisdiction.autonet.vault` and `jurisdiction.autonet.rep_claim`. Read them from there rather than from `deployments/autonet-jurisdiction-ets.json`, which records an earlier (2026-07-08) attachment with different addresses.

### Networks (`hardhat.config.js`)

| Name | Chain ID | RPC | Status |
|------|----------|-----|--------|
| `ets` | 127823 | `https://node.shadownet.etherlink.com` | **Current testnet** |
| `etm` | 42793 | `https://node.mainnet.etherlink.com` | Mainnet |
| `et` | 128123 | `https://node.ghostnet.etherlink.com` | Retired (Ghostnet) |
| `baseSepolia` | 84532 | `https://sepolia.base.org` | Not in use |
| `sepolia` | 11155111 | Infura | |
| `localhost` / `hardhat` | 31337 | `http://127.0.0.1:8545` | Local |
| `ganache` | 1337 | `http://127.0.0.1:7545` | Local |

Block explorer verification (`npx hardhat verify`) is configured for `et`, `ets` and `etm` via Blockscout.

## Prerequisites

- Node.js 18+ and npm.
- `config.js` in the repo root (gitignored) exporting `INFURA_API_KEY`, `SEPOLIA_PRIVATE_KEY` and `PRIVATE_KEY` (hex, without `0x`). `hardhat.config.js` requires it even for local runs.
- For the indexer harnesses: Python 3 with the indexer's requirements, the Firebase CLI (Firestore emulator), and the indexer's service-account files (`homebase.json`, `secrets/trustless.json`). The UI harness also needs Flutter and chromedriver.

## Build and test

```bash
npm install
npx hardhat compile          # solc 0.8.26, cancun, optimizer 200 runs, viaIR
npx hardhat test             # all tests
npx hardhat test test/security.test.js
```

`npm test` is a placeholder in `package.json` and fails; use `npx hardhat test`.

## Deploy scripts

Run with `npx hardhat run <script> --network <name>`.

| Script | What it does |
|--------|--------------|
| `scripts/deploy-jurisdiction-suite.js` | **Current.** Fresh suite on `ets` or a local node: JurisdictionFactory and its sub-factories, project implementations, ModuleCatalog, ModuleProcessor and the [module](modules.md) setups (EconomySetup, ContentCourtSetup, AutonetSetup) with version 1.1 of each published. `CURATOR` hands the catalog and repos to another address. Writes `deployments/<etherlink-shadownet\|localhost>-jurisdiction.json` with the Firestore field mapping |
| `scripts/deployProjectImplsShadownet.js` | Redeploys only `NativeProject` and `ERC20Project` (refuses any chain but 127823). Update `nativeProjectImpl` / `erc20ProjectImpl` in Firestore afterwards. Pre-modules suite only: with the module suite, new economies take the implementations held by `EconomySetup`, so a project change needs a new EconomySetup version (existing economies switch by proposal with `setImplementations`) |
| `scripts/deploy-autonet-jurisdiction.js` | Autonet jurisdiction on the suite from `deployments/<network>-jurisdiction.json`: `deployCore`, `EconomySetup.prepareInstallation`, `AutonetSetup.prepareInstallation`, then `finalize` attaching both, no follow-up proposals. See [autonet.md](autonet.md#genesis-autonetsetup) |
| `scripts/deploy-autonet-vault.js`, `deploy-autonet-rep-claim.js` | Individual Autonet satellites; print the governance calldata they need |
| `scripts/updateFirestoreShadownet.js`, `backupFirestoreAddresses.js` | Write / back up Firestore address docs |

Older one-off scripts (`redeploy*`, `check*`, `debug*`, `updateTrustlessFactory.js` and similar) are historical and target previous deployments or removed factories.

Factory timing units: `CoreParams.votingDelay` and `votingPeriod` are **minutes** (multiplied by 60 on-chain, timestamp clock); `executionDelay` (the timelock delay) is **seconds**. `deploy-autonet-jurisdiction.js` takes seconds via env and converts.

## Local end-to-end harnesses

### `scripts/e2eLocal.js`

Contracts-only smoke run against a live node. **Being ported:** it still deploys the removed TrustlessFactory and does not run against the current contracts until the port lands.

```bash
npx hardhat node
npx hardhat run scripts/e2eLocal.js --network localhost
```

Deploys the factory suite, creates an economy DAO, sets parities with werule's encoding (`parity * 10^(36 - decimals)`), runs a native and a 6-decimal ERC20 project with immediate release, and checks: Economy admin frozen, cooling-off at least the fixed minimum, treasury platform fees, and contractor and backer REP. Prints `PASS`/`FAIL` per check and exits non-zero on any failure.

### `scripts/indexer-e2e/` (contracts plus indexer plus Firestore emulator)

**Being ported** to JurisdictionFactory and the module setups, like `e2eLocal.js`; the descriptions below are of the harness's shape. All Firestore writes go to the emulator (`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` is forced), never production.

| File | Role |
|------|------|
| `run.sh <indexer dir> [--replay]` | Needs `npx hardhat node` and `firebase emulators:start --only firestore` running. Clears both emulator projects and the indexer's local state, runs `deploy.js` and `seed_emulator.py`, starts the indexer (`app.py localhost homebase trustless --no-alerts`), runs `events.js`, waits until the indexer log is quiet for 15 s, then runs `verify.py`. `--replay` rewinds both checkpoints to block 1, restarts the indexer and verifies again to catch double counting |
| `deploy.js` | Deploys the factories and project implementations to the local node; writes `out/deployment.json` in the Firestore `contracts/<network>` shape |
| `seed_emulator.py <indexer dir>` | Writes `out/deployment.json` to `contracts/Localhost` in both emulator projects (`homebase`, `trustless`) |
| `events.js` | Emits every DAO and trustless event type the indexer handles (standard and economy DAOs; proposals through execute; delegation; project flows) and records expectations in `out/manifest.json` |
| `verify.py <indexer dir>` | Compares emulator documents (`idaosLocalhost`, members, proposals, votes, registry, economy and project docs) with the manifest. `PASS`/`FAIL` lines, exit 1 on any failure |
| `ui.sh <indexer dir> <app dir> <integration test>` | UI write flows. Needs the emulator and chromedriver (port 4444). Restarts the hardhat node so chain time matches the browser, deploys, seeds, starts the indexer with `--skip-historical`, runs `ui_setup.js`, then `flutter drive` on Chrome with the addresses passed as `--dart-define`s |
| `ui_setup.js` | On a fresh chain without time travel: an economy DAO for trustless flows and a standard DAO with an open proposal for werule voting. Writes `out/ui.json` |

The shell scripts use PowerShell to stop the indexer and free ports, so they are written for Git Bash on Windows.
