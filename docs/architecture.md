# Architecture

How the contracts fit together, how a jurisdiction is deployed, and how off-chain components (indexer, Firestore, the two web apps) consume it. Governance mechanics are in [governance.md](governance.md); the marketplace is in [economy.md](economy.md); API detail is in [technical-reference.md](technical-reference.md); live addresses are in [deployments.md](deployments.md).

## System overview

A **jurisdiction** is a set of contracts sharing one Timelock as its on-chain identity:

- **Governance**: Governor, Timelock, Registry (treasury + config), RepToken (voting power).
- **Economy** (economy DAOs only): an `Economy` contract that clones escrow projects and feeds earned and spent amounts back into reputation.
- **Satellites** (optional): contracts that plug into the RepToken, Registry and Timelock, mainly for Autonet. See [autonet.md](autonet.md). Satellites that come as a set are [modules](modules.md), attached at origination or later by proposal.

## Contract graph

```
                         +-----------------------+
                         |  HomebaseDAO          |  OZ Governor (votes from RepToken)
                         |  (Governor)           |
                         +-----------+-----------+
                                     | sole PROPOSER
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
   |     |                       |   +---------+-----------+
   |     | getUser() (rep pull)  |   |  Economy            |
   |     +---------------------->|   |  clones projects,   |
   |                             |   |  user profiles      |
   |                             |   +----+-----------+----+
   |                             |        | Clones    | Clones
   |                             |        v           v
   |                             |   NativeProject  ERC20Project   (one clone per project)
   |                             +-->  daoVeto / daoOverrule gated to the Timelock
   |
   |  minters / readers
   v
Satellites: CoinOffering, AutonetRepClaim, AutonetVault
```

### Who controls what

| Contract | Control after deployment |
|---|---|
| Governor | Self-governed: settings changes are proposals executed via the Timelock |
| Timelock | Governor is the only proposer; `EXECUTOR_ROLE` is `address(0)`; its own admin; nobody can cancel queued operations |
| Registry | `owner` = Timelock (treasury ops, earmark release). `jurisdictionAddress` = RepToken (earmark, disburse). `wrapper` = factory (Standard) or none (Trustless) for registry edits |
| RepToken | `admin` = Timelock (mint, burn, setters); immutable `timelockAddress` gates reward epochs; `minters` mint |
| Economy | `onlyGovernance`: `admin` until DAO addresses are set, then the Timelock forever |
| Projects | Parties act directly; the Timelock can `daoVeto` and `daoOverrule` (in `Appeal`) |

### Economy and project clones

`Economy` holds `nativeProjectImplementation` and `erc20ProjectImplementation`. `createProject` / `createERC20Project` require the caller to hold at least `projectThreshold` REP, then `Clones.clone` the implementation (EIP-1167), initialize it with the Timelock and Governor addresses, and mark it in `isProjectContract`. Only marked projects can call `updateEarnings`, `updateSpendings`, `registerBacker` and `registerProjectRoles`, which build the per-user profile that `RepToken.claimReputationFromEconomy` reads. Platform fees go straight to the Registry.

`setImplementations` is governance-gated and affects only future projects. Existing clones keep their implementation.

**Admin hand-off.** The `Economy` constructor sets `admin = msg.sender`. `EconomyFactory` immediately calls `transferAdmin(caller)`, so the top-level factory is admin. While `timelockAddress == 0`, `onlyGovernance` means `admin`; `setDaoAddresses` (admin only, once) sets the Timelock, after which `onlyGovernance` means the Timelock and `transferAdmin` is disabled.

**Cooling-off floor.** `effectiveCoolingOffPeriod()` is `max(coolingOffPeriod, votingDelay + votingPeriod + timelock minDelay)`, read live from the Governor and Timelock, so the jurisdiction always has time to pass a veto before a contractor can sign.

### Satellites

All live in this repo and are deployed by scripts, not factories. Each needs a governance action to be wired in (minter grant, auto-delegate exemption, payment-token whitelist in the Registry).

| Contract | Relationship to the jurisdiction |
|---|---|
| `CoinOffering` | Sells a transferable RepToken for payment tokens priced by a Registry parity; payment goes straight to the Registry; mints to buyers as a RepToken minter |
| `AutonetVault` | Same shape, but mints ATN on the external Autonet `Substrate` contract; payment to the Registry |
| `AutonetRepClaim` | RepToken minter: mints REP against a user's ratified ATN earnings on `Substrate` |

`Substrate` and the ATN token live in the separate Autonet repo. Details in [autonet.md](autonet.md).

### Debates

`DebatesFactory` is one network-wide contract, not part of any suite. It deploys `Debate` instances against any `IVotes` token and has no authority over the jurisdiction. See [governance.md](governance.md#debates).

## Deployment

### Sub-factories

Top-level factories delegate bytecode to small sub-factories so no single contract exceeds the size limit:

| Sub-factory | Deploys | Notes |
|---|---|---|
| `InfrastructureFactory` | `TimelockController(delay, [], [], admin)`, `Registry(owner, wrapper)` | Caller passes itself as temporary admin/owner |
| `DAOFactory` | `HomebaseDAO` from `daoSettings[4]` = `[votingDelayMin, votingPeriodMin, threshold, quorum]` | |
| `RepTokenFactory` | `RepToken`, then `setAdmin(caller)` | |
| `WrappedRepTokenFactory` | `WrappedRepToken`, then `setAdmin(caller)` | |
| `EconomyFactory` | `Economy(arbitrationFeeBps)`, then `transferAdmin(caller)` | |

Sub-factories are permissionless; anyone can call them. The security of a suite comes from the top-level factory holding every admin role until it finalizes.

### Top-level factories

| Factory | Firestore key | Token | Transactions | Event |
|---|---|---|---|---|
| `StandardFactory` | `wrapper` | RepToken, non-transferable | 1 | `NewDaoCreated` |
| `StandardFactoryNonTransferable` | | RepToken, non-transferable | 1 | `NewDaoCreated` |
| `StandardFactoryTransferable` | `wrapper_t` | RepToken, transferable | 1 | `NewDaoCreated` |
| `StandardFactoryWrapped` | `wrapper_w` | WrappedRepToken over an existing ERC20 | 1 | `DaoWrappedDeploymentInfo` |
| `TrustlessFactory` | `wrapper_trustless` | RepToken, non-transferable, plus Economy | 3 | `SuiteConfigured`, `NewDaoCreated` |

### Single-transaction (Standard factories)

```
deployDAOwithToken(params)
  1. InfrastructureFactory.deployTimelock(this, executionDelay)
  2. InfrastructureFactory.deployRegistry(owner = this, wrapper = this)
  3. RepTokenFactory.deployRepToken(..., registry, timelockAddress = this, ...)
  4. DAOFactory.deployDAO(token, timelock, name, settings)
  5. finalize:
       registry.setJurisdictionAddress(token)          (not in the Wrapped variant)
       token.setAdmin(timelock)
       registry.transferOwnership(timelock)
       timelock: grant PROPOSER to DAO, EXECUTOR to address(0), revoke own admin
       registry.batchEditRegistry(keys, values)        (via wrapper = this)
  6. emit NewDaoCreated / DaoWrappedDeploymentInfo
```

Step 3 passes the factory, not the Timelock, as the RepToken's immutable `timelockAddress`, which permanently disables reward epochs on Standard DAOs. See [governance.md](governance.md#known-caveats).

### Multi-step (TrustlessFactory)

An economy suite is too large for one transaction, so it is built over three calls by the same deployer. Each in-progress build is stored in `pendingDeployments[msg.sender]`, and every later step checks the caller's own record:

```
tx 1  deployInfrastructure(timelockDelayMinutes, arbitrationFeeBps)
        Economy, Timelock (admin = factory), Registry (owner = factory, no wrapper)
        pendingDeployments[sender] = {economy, registry, timelock, delay}   (any older pending entry is discarded)
        emit InfrastructureDeployed

tx 2  deployDAOToken(registry, timelock, TokenParams, GovParams)
        require registry/timelock == sender's pending infrastructure, token not yet deployed
        RepToken (non-transferable, timelockAddress = real Timelock), HomebaseDAO
        store token, dao, params
        emit DAOTokenDeployed

tx 3  configureAndFinalize(AddressParams, EconomyParams, keys, values)
        require all five addresses == sender's pending record
        economy: setImplementations, fees, cooling-off, backers quorum, threshold, appeal period
        repToken.setEconomyAddress(economy); registry.setJurisdictionAddress(repToken)
        (WithGrants variant) repToken.setMinter / setSlasher for genesis satellites
        registry.batchEditRegistry(keys, values)
        economy.setDaoAddresses(timelock, registry, dao, repToken)   (Economy now Timelock-governed)
        repToken.setAdmin(timelock); registry.transferOwnership(timelock)
        timelock: PROPOSER to DAO, EXECUTOR to address(0), revoke factory admin
        emit SuiteConfigured, NewDaoCreated; delete pendingDeployments[sender]
```

Binding the build to its deployer fixes a hijack in the earlier design, where shared pending state let anyone call step 2 or 3 against someone else's half-built suite and install their own governor. `test/security.test.js` covers both attempts and an outsider configuring a half-deployed economy.

Note: `GovParams.votingDelay` is the Governor's voting delay in minutes. The Timelock delay is the `deployInfrastructure` argument.

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

- **Indexer** (`../indexer`, deployed on EC2 as `indexer@<network>`). The `homebase` app watches the four factory addresses from `contracts/<network>` (`wrapper`, `wrapper_t`, `wrapper_w`, `wrapper_trustless`) for `NewDaoCreated`, `DaoWrappedDeploymentInfo` and `SuiteConfigured`, then follows each new Governor, token and Registry (proposals, votes, delegation, transfers, `RegistryUpdated`). On `SuiteConfigured` it also writes the economy document into the trustless project. The `trustless` app then follows each Economy (`NewProject`) and every project clone (funding, signing, disputes, arbitration, appeals, payouts). It checkpoints `lastSyncedBlock` in `contracts/<network>`. Other apps (`afterme`, `autonet`) are out of scope here.
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
| Economy parameters, user earnings/spendings, project list | Economy | Chain |
| Escrow balances, stage, parties, votes | Each project clone | Chain |
| Factory and implementation addresses per network | Firestore `contracts/<network>` (both projects) | Firestore, mirrored in [deployments.md](deployments.md) |
| DAO, proposal, member and project views | Firestore collections | Derived by the indexer; rebuildable from chain |

Nothing in Firestore is authoritative for chain state: wiping a collection and replaying the indexer from the factory deployment block rebuilds it.

## Upgradeability

Nothing is upgradeable in place. Factories are replaced by deploying new ones and updating `contracts/<network>`; existing DAOs are untouched. The Economy's project implementations can be swapped by governance (`setImplementations`), affecting only new projects. Registry contents and Governor settings change through proposals.
