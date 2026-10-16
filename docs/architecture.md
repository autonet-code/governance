# Architecture

How the contracts fit together, how a jurisdiction is deployed, and how off-chain components (indexer, Firestore, the two web apps) consume it. Governance mechanics are in [governance.md](governance.md); the marketplace is in [economy.md](economy.md); API detail is in [technical-reference.md](technical-reference.md); live addresses are in [deployments.md](deployments.md).

## System overview

A **jurisdiction** is a set of contracts sharing one Timelock as its on-chain identity:

- **Core** (every DAO): Governor, Timelock, Registry (treasury + config), and a governance token (soulbound or transferable RepToken, or a WrappedRepToken).
- **Modules** (optional, see [modules.md](modules.md)): the `economy` module (an `Economy` that clones escrow projects, plus an `EconomyRepClaim` that mints REP for what members earn and spend in it), `content_court` and `autonet`. Attached at origination or later by proposal. A DAO has an Economy when its Registry has `jurisdiction.economy`.
- **Satellites** (optional): standalone contracts that plug into the RepToken, Registry and Timelock, such as `CoinOffering`. See [autonet.md](autonet.md).

## Contract graph

```
                         +-----------------------+
                         |  HomebaseDAO          |  OZ Governor (votes from RepToken)
                         |  (Governor)           |
                         +-----------+-----------+
                                     | PROPOSER, CANCELLER
                                     v
+-----------------+  admin   +-------+---------------+  owner   +-------------------+
|  RepToken       |<---------+  TimelockController   +--------->|  Registry         |
|  ERC20Votes,    |          |  executes everything; |          |  treasury, config,|
|  reward epochs, |          |  anyone may execute   |          |  earmarks, cap    |
|  minters        |          +---+-------------+-----+          +---------+---------+
+--+-----+----+---+              |             |                          ^
   |     |    |   jurisdiction   |             | onlyGovernance           | fees, sweeps,
   |     |    +------------------|-------------|--------------------------+ earmarks /
   |     |      earmark/disburse |             v                            disbursements
   |     |                       |   +---------+-----------+   getUser()   +----------------+
   |     |                       |   |  Economy            +-------------->| EconomyRepClaim|
   |     |                       |   |  (economy module)   |               | (minter)       |
   |     |                       |   |  clones projects,   |               +-------+--------+
   |     |                       |   |  user profiles      |                       |
   |     |                       |   +----+-----------+----+                       |
   |     |                       |        | Clones    | Clones                     |
   |     |                       |        v           v                            |
   |     |                       |   NativeProject  ERC20Project                   |
   |     |                       +-->  daoVeto / daoOverrule gated to the Timelock |
   |     +<----------------------------------------------------------------- mint -+
   |
   |  minters / slashers / readers
   v
Modules: EconomyRepClaim, AutonetRepClaim, ToolBond, ContentCourt; satellites: CoinOffering
```

### Who controls what

| Contract | Control after deployment |
|---|---|
| Governor | Self-governed: settings changes are proposals executed via the Timelock |
| Timelock | Governor holds `PROPOSER_ROLE` and `CANCELLER_ROLE`; `EXECUTOR_ROLE` is `address(0)`; its own admin (see [governance.md](governance.md) for what cancelling can reach) |
| Registry | `owner` = Timelock (treasury ops, earmark release, registry edits). `jurisdictionAddress` = the token (earmark, disburse). No `wrapper` |
| RepToken | `admin` = Timelock (mint, burn, setters); immutable `timelockAddress` (the real Timelock) gates reward epochs; `minters` mint, `slashers` slash |
| Economy | `onlyGovernance`: `admin` until DAO addresses are set, then the Timelock forever |
| Projects | Parties act directly; the Timelock can `daoVeto` and `daoOverrule` (in `Appeal`) |

### Economy and project clones

`Economy` holds `nativeProjectImplementation` and `erc20ProjectImplementation`. `createProject` / `createERC20Project` require the caller to hold at least `projectThreshold` REP, then `Clones.clone` the implementation (EIP-1167), initialize it with the Timelock and Governor addresses, and mark it in `isProjectContract`. Only marked projects can call `updateEarnings`, `updateSpendings`, `registerBacker` and `registerProjectRoles`, which build the per-user profile that `EconomyRepClaim.claim` reads. Platform fees go straight to the Registry.

`setImplementations` is governance-gated and affects only future projects. Existing clones keep their implementation.

**Admin hand-off.** The `Economy` constructor sets `admin = msg.sender`, here `EconomySetup`. While `timelockAddress == 0`, `onlyGovernance` means `admin`; `EconomySetup.prepareInstallation` configures the Economy and calls `setDaoAddresses` (admin only, once) in the same transaction, after which `onlyGovernance` means the Timelock and `transferAdmin` is disabled. A prepared but unattached Economy is already Timelock-governed; attaching only grants its `EconomyRepClaim` minter rights and records the Registry keys.

**Cooling-off floor.** `effectiveCoolingOffPeriod()` is `max(coolingOffPeriod, votingDelay + votingPeriod + timelock minDelay)`, read live from the Governor and Timelock, so the jurisdiction always has time to pass a veto before a contractor can sign.

### Modules and satellites

Modules are prepared by a `ModuleSetup` and attached by `JurisdictionFactory.finalize` or by a proposal built by `ModuleProcessor`; attaching executes the setup's RepToken grants and records its Registry keys. See [modules.md](modules.md).

| Contract | Comes from | Relationship to the jurisdiction |
|---|---|---|
| `Economy`, `EconomyRepClaim` | `economy` module (`EconomySetup`) | Marketplace governed by the Timelock; the claim is a RepToken minter |
| `ContentCourt` | `content_court` module | RepToken slasher. See [content-court.md](content-court.md) |
| `AutonetVault`, `AutonetRepClaim`, `ToolBond`, ... | `autonet` module (`AutonetSetup`) | Vault mints ATN on the Autonet `Substrate`, payment to the Registry; the REP claim is a minter against ratified ATN earnings; ToolBond is a slasher |
| `CoinOffering` | Standalone, deployed by script | Sells a transferable RepToken for payment tokens priced by a Registry parity; payment goes straight to the Registry; mints to buyers as a RepToken minter granted by proposal |

`Substrate` and the ATN token come from the separate Autonet repo. Details in [autonet.md](autonet.md).

### Debates

`DebatesFactory` is one network-wide contract, not part of any suite. It deploys `Debate` instances against any `IVotes` token and has no authority over the jurisdiction. See [governance.md](governance.md#debates).

## Deployment

### Sub-factories

`JurisdictionFactory` delegates bytecode to small sub-factories so no single contract exceeds the size limit:

| Sub-factory | Deploys | Notes |
|---|---|---|
| `InfrastructureFactory` | `TimelockController(delay, [], [], admin)`, `Registry(owner, wrapper)` | Caller passes itself as temporary admin/owner, and no wrapper |
| `DAOFactory` | `HomebaseDAO` from `daoSettings[4]` = `[votingDelayMin, votingPeriodMin, threshold, quorum]` | |
| `RepTokenFactory` | `RepToken`, then `setAdmin(caller)` | |
| `WrappedRepTokenFactory` | `WrappedRepToken`, then `setAdmin(caller)` | |

Sub-factories are permissionless; anyone can call them. The security of a DAO comes from `JurisdictionFactory` holding every admin role until it finalizes.

### JurisdictionFactory

One factory creates every DAO (Firestore `jurisdictionFactory`). `CoreParams` holds `name`, `symbol`, `description`, `tokenKind` (`Soulbound`, `Transferable` or `Wrapped`), `underlying` (Wrapped only), `initialMembers`, `initialAmounts`, `votingDelay` and `votingPeriod` (minutes), `proposalThreshold`, `quorumFraction` (percent) and `executionDelay` (seconds).

```
deployCore(params)                                  (tx 1, by the originator)
  InfrastructureFactory.deployTimelock(this, executionDelay)
  InfrastructureFactory.deployRegistry(owner = this, wrapper = 0)
  RepTokenFactory.deployRepToken(..., registry, timelockAddress = timelock, ...)
    or WrappedRepTokenFactory.deployWrappedRepToken(underlying, ...)
  DAOFactory.deployDAO(token, timelock, name, settings)
  registry.setJurisdictionAddress(token)
  record the pending core under the registry, bound to msg.sender
  emit CoreDeployed

setup.prepareInstallation(core, data)               (per module, by anyone; see modules.md)

finalize(core, modules, keys, values)               (last tx, originator only)
  require pending, caller == originator, core matches  (NotPending, NotOriginator, WrongCore)
  registry.batchEditRegistry(keys, values)
  for each module, in order:
    ModuleProcessor.checkInstall(setup, id, registry)
    execute its install actions against this token or Registry only  (ForeignTarget, ActionFailed)
    registry.batchEditRegistry(module entries)
    emit ModuleAttached
  token.setAdmin(timelock); registry.transferOwnership(timelock)
  timelock: PROPOSER and CANCELLER to the Governor, EXECUTOR to address(0), revoke factory admin
  emit NewDaoCreated; delete the pending core
```

`deploy(params, keys, values)` runs `deployCore` and `finalize` with no modules in one transaction. An economy DAO is `deployCore`, `EconomySetup.prepareInstallation`, then `finalize` with that installation (`scripts/deploy-autonet-jurisdiction.js` adds the Autonet module after it).

Binding the pending core to its originator stops anyone else from finalizing a half-built DAO with their own modules or keys. `test/factory-deployment.test.js` and `test/modules.test.js` cover it.

## Off-chain: indexer, Firestore, apps

```
     Etherlink (Shadownet today)
   factories  Governors  RepTokens  Registries  Economies  Projects
        \         |          |          |           |         /
         +--------+----------+----------+-----------+--------+
                                 | events (RPC polling)
                                 v
                  +----------------------------------+
                  |  Python indexer (EC2,            |
                  |  one service per network)        |
                  |  apps: homebase, trustless, ...  |
                  +---------+--------------+---------+
                            |              |
             Firestore homebase-6907d    Firestore trustless-58262
             contracts/<network>         contracts/<network>
             idaos<network>/<dao>/...    <network>/<economy>/projects/<project>
                            |              |
                            v              v
                       werule.io      trustless.business
                       (DAOs, votes,  (economies, projects,
                        treasury)      disputes)
                            \              /
                             +-- wallets --+--> transactions go straight to the contracts
```

- **Indexer** (`../indexer`, deployed on EC2 as `indexer@<network>`). The `homebase` app watches `jurisdictionFactory` from `contracts/<network>` for `NewDaoCreated`, then follows each new Governor, token and Registry (proposals, votes, delegation, transfers, `RegistryUpdated`). A DAO with a `jurisdiction.economy` Registry key is an economy DAO, and its Economy document goes into the trustless project. (The indexer is being ported from the old per-kind factory fields to this; the live Shadownet suite still predates it, see [deployments.md](deployments.md).) The `trustless` app then follows each Economy (`NewProject`) and every project clone (funding, signing, disputes, arbitration, appeals, payouts). It checkpoints `lastSyncedBlock` in `contracts/<network>`. Other apps (`afterme`, `autonet`) are out of scope here.
- **Firestore**. Two Firebase projects, one per web app. `contracts/<network>` is the per-network config both the indexer and the apps read (RPC, factory and implementation addresses). Shadownet uses `contracts/Etherlink-Shadownet`, `idaosEtherlink-Shadownet` and `Etherlink-Shadownet/<economy>/projects`. Schema: [firestore-schema.md](firestore-schema.md).
- **Apps**. werule.io is the DAO app (create DAOs, propose, vote, delegate, treasury). trustless.business is the economy app (create economies, projects, fund, sign, dispute, appeal). Both read indexed state from Firestore and send transactions from the user's wallet directly to the contracts.

## Where state lives

| State | Location | Source of truth |
|---|---|---|
| Votes, delegation, balances, delegatee history | RepToken / WrappedRepToken checkpoints | Chain |
| Proposals and vote tallies | Governor | Chain |
| Queued operations | Timelock | Chain |
| Treasury balances, earmarks, spend-cap windows | Registry | Chain |
| Jurisdiction config (parities, grace period, descriptions) | Registry key/value store | Chain ([registry-settings.md](registry-settings.md)) |
| Reward epochs and claims | RepToken | Chain (not indexed) |
| Attached modules | Registry `modules.<name>` = `"<setup>:<id>"` | Chain ([modules.md](modules.md)) |
| Economy REP claim watermarks | `EconomyRepClaim` | Chain |
| Economy parameters, user earnings/spendings, project list | Economy | Chain |
| Escrow balances, stage, parties, votes | Each project clone | Chain |
| Factory and implementation addresses per network | Firestore `contracts/<network>` (both projects) | Firestore, mirrored in [deployments.md](deployments.md) |
| DAO, proposal, member and project views | Firestore collections | Derived by the indexer; rebuildable from chain |

Nothing in Firestore is authoritative for chain state: wiping a collection and replaying the indexer from the factory deployment block rebuilds it.

## Upgradeability

Nothing is upgradeable in place. Factories are replaced by deploying new ones and updating `contracts/<network>`; existing DAOs are untouched. New module versions are published in `ModuleCatalog` and affect only installations prepared afterwards. The Economy's project implementations can be swapped by governance (`setImplementations`), affecting only new projects. Registry contents and Governor settings change through proposals.
