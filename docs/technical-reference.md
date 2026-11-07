# Technical Reference

Per-contract API for the production suite: key functions, parameters, constants, events and access control. Signatures are taken from the current source. Autonet satellites are covered in [autonet.md](autonet.md); deployed addresses and scripts in [deployments.md](deployments.md); the threat model in [security.md](security.md).

- [Roles after deployment](#roles-after-deployment)
- [HomebaseDAO](#homebasedao) · [RepToken](#reptoken) · [Registry](#registry) · [Economy](#economy) · [EconomyRepClaim](#economyrepclaim) · [NativeProject / ERC20Project](#nativeproject--erc20project)
- [Factories](#factories) (JurisdictionFactory, modules) · [Debates](#debates)
- [Events](#events) · [Constants and defaults](#constants-and-defaults)

## Roles after deployment

| Contract | Privileged party after finalize | Notes |
|----------|----------------------------------|-------|
| TimelockController | `PROPOSER_ROLE`, `CANCELLER_ROLE`: the governor. `EXECUTOR_ROLE`: `address(0)` (anyone). Factory's `DEFAULT_ADMIN_ROLE` revoked | All governance actions are timelock calls |
| RepToken | `admin` = timelock; `timelockAddress` immutable (the timelock); `minters` and `slashers` granted by modules or proposals | See the old-factory caveat below |
| Registry | `owner` = timelock; `wrapper` = `address(0)`; `jurisdictionAddress` = the token | Old standard-factory DAOs have the factory as `wrapper` |
| Economy | `timelockAddress` set once by `setDaoAddresses` (inside `EconomySetup.prepareInstallation`); `admin` frozen | `economy` module |
| Projects | `daoTimelock`, `daoGovernor` copied at initialization | |

---

## HomebaseDAO

`contracts/Dao.sol`. OpenZeppelin Governor with `GovernorSettings`, `GovernorCountingSimple`, `GovernorVotes`, `GovernorVotesQuorumFraction`, `GovernorTimelockControl`, `GovernorSuperQuorum`, plus early decision, options mode and constitutional proposals ([governance.md](governance.md)).

```solidity
constructor(IVotes _token, TimelockController _timelock, string memory name,
            uint48 minsDelay, uint32 minsVoting, uint256 pThreshold, uint8 qvrm,
            address _launcher, uint256 _supermajorityBps)
```

- `supermajorityBps()` (5001..10000): the share of all REP at the snapshot a protected proposal needs. `setSupermajority(bps)`: governance only, and itself protected. Emits `SupermajoritySet(oldBps, newBps)`.
- `proposalSupermajority(proposalId)`: the threshold fixed for a protected proposal at `propose`, 0 for an ordinary one. Protected: any call to the timelock or the governor, any call to the token but `startPassiveEpoch`, `startDelegateEpoch` and `setDelegateBar`, and Registry edits of `jurisdiction.autonet.charter` or `jurisdiction.autonet.epoch_rules`. `propose` emits `ProposalSupermajority(proposalId, bps)` for each protected proposal.

- `minsDelay`, `minsVoting` are **minutes**, multiplied by 60 into `GovernorSettings`. RepToken uses `CLOCK_MODE() == "mode=timestamp"`, so the governor's delay and period are seconds on-chain.
- `pThreshold`: votes needed to propose (18-decimal token units). `qvrm`: quorum percent of past total supply.
- Inherited API: `propose`, `castVote`, `castVoteWithReason`, `queue`, `execute`, `cancel`, `state`, `votingDelay`, `votingPeriod`, `quorum`, `proposalThreshold`, `proposalNeedsQueuing`. States: `Pending, Active, Canceled, Defeated, Succeeded, Queued, Expired, Executed`.

---

## RepToken

`contracts/RepToken.sol`. `ERC20, ERC20Permit, ERC20Votes`, 18 decimals, timestamp clock.

```solidity
constructor(string name, string symbol, address payable _registryAddress, address _timelockAddress,
            address[] initialMembers, uint256[] initialAmounts)
```

State: `admin`, `registryAddress` (immutable), `timelockAddress` (immutable), `defaultDelegate`, `autoDelegateExempt[account]`, `minters[account]`, `slashers[account]`, `slashedCredit[slasher]`. RepToken has no Economy link; see [EconomyRepClaim](#economyrepclaim).

### Access control

| Function | Caller |
|----------|--------|
| `mint(address to, uint256 amount)` | `admin` or a `minters` entry |
| `mintDelegated(address to, uint256 amount)` | `admin` or a `minters` entry; makes `to` its own delegate first unless it already chose one |
| `burn(address from, uint256 amount)` | `admin` |
| `setAdmin(address newAdmin)` | `admin` (non-zero) |
| `setMinter(address account, bool allowed)` | `admin` or `timelockAddress` |
| `setSlasher(address account, bool allowed)` | `admin` or `timelockAddress` |
| `slash(address from, uint256 amount)`, `reassign(address to, uint256 amount)` | a `slashers` entry; `reassign` up to that slasher's `slashedCredit` |
| `setDefaultDelegate(address)` | `admin` or `timelockAddress`; `address(0)` disables |
| `setAutoDelegateExempt(address account, bool exempt)` | `admin` or `timelockAddress` |
| `setDelegateBar(uint16)` | `timelockAddress` only, `<= 10000` |
| `startPassiveEpoch`, `startDelegateEpoch` (`uint256 budget, address paymentToken`) | `timelockAddress` only |
| `transfer`, `transferFrom` | always revert `"RepToken: Reputation is non-transferable"` |
| `isTransferable` | always false, for readers that also follow older tokens |

> **Old-factory caveat.** `JurisdictionFactory` passes the DAO's timelock as `_timelockAddress`. Early builds of the removed standard factories passed `address(this)`, so DAOs created by those builds (including standard DAOs created on Shadownet before the 2026-10-12 redeploy) have the factory as their immutable `timelockAddress`. In those DAOs, functions gated to `timelockAddress` only (`startPassiveEpoch`, `startDelegateEpoch`, `setDelegateBar`) are unreachable; admin-or-timelock functions still work because `admin` is handed to the timelock. Economy DAOs always had the real timelock.

### Reward epochs

Two pools with their own budgets, numbered together. See [governance.md](governance.md).

| Item | Detail |
|------|--------|
| `startPassiveEpoch(uint256 budget, address paymentToken)` | Timelock only, `budget > 0`. Increments `currentRewardEpoch` and calls `Registry.earmarkFunds(rewardPurpose(id, token), budget, token)` |
| `startDelegateEpoch(uint256 budget, address paymentToken)` | The same, and fixes the epoch's `delegateBarBps` |
| `receivedWeight(address, uint256 timepoint) view` | Past votes, less the account's own balance if it delegated to itself |
| `rewardOf(uint256 epochId, address account) view` | At `startTimestamp - 1`. Passive: `pastBalance * budget / pastTotalSupply`. Delegate: `received * budget / pastTotalSupply` if `received` reaches the bar, else 0 |
| `claimReward(uint256 epochId)` | Once per epoch per account, non-zero; pays via `Registry.disburseEarmarked` |
| `rewardPurpose(uint256 epochId, address paymentToken) pure` | `keccak256(abi.encodePacked("REWARD", epochId, paymentToken))` |
| `delegateBarBps` | Default `100` (1% of all REP); up to `10000`. Set by `setDelegateBar` |
| `getRewardEpochStart(uint256)`, `pastDelegatee(address, uint256)` | Views (`IJurisdictionData`, plus the delegatee history) |
| Unclaimed remainder | `Registry.reclaimEarmarkedFunds(epochId, token)` after the next epoch starts plus `benefits.claim.gracePeriod` |

### Auto-delegation

On any receipt, if `defaultDelegate != 0`, the recipient is not the default delegate, is not exempt, and has no delegate, the recipient is delegated to `defaultDelegate` (`AutoDelegated`). A holder's own `delegate()` call is never reset.

---

## Registry

`contracts/Registry.sol`. Treasury (native, ERC20, ERC721) and string key-value store. `ReentrancyGuard`.

```solidity
constructor(address _owner, address _wrapper)
```

| Function | Caller | Notes |
|----------|--------|-------|
| `editRegistry(string key, string value)` | `owner` or `wrapper` | Emits `RegistryUpdated` |
| `batchEditRegistry(string[] keys, string[] values)` | `owner` or `wrapper` | `RegistryUpdated` per key |
| `getRegistryValue(string)`, `getAllKeys()`, `getAllValues()` | anyone | |
| `setJurisdictionAddress(address)` | `owner` or `wrapper` | |
| `transferOwnership(address)` | `owner` | Once: the factory's handover to the Timelock; reverts afterwards |
| `transferETH(address payable to, uint256 amount)` | `owner` | `nonReentrant`, unreserved balance only, metered |
| `transferERC20(address token, address to, uint256 amount)` | `owner` | `nonReentrant`, unreserved, metered |
| `transferERC721(address token, address to, uint256 tokenId)` | `owner` | Unmetered |
| `earmarkFunds(bytes32 purpose, uint256 amount, address token)` | `owner` or `jurisdictionAddress` | Cannot exceed unreserved balance; purpose bound to one token |
| `withdrawEarmarkedFunds(bytes32 purpose, uint256 amount)` | `owner` | Releases the reservation (funds stay); not for reward earmarks |
| `disburseEarmarked(address recipient, uint256 amount, bytes32 purpose, address token)` | `jurisdictionAddress` | `nonReentrant`, metered |
| `reclaimEarmarkedFunds(uint256 epochId, address paymentToken)` | `owner` | Requires `benefits.claim.gracePeriod` |
| `setSpendCap(address token, uint256 cap)` | `owner` | `0` = unmetered (default) |
| `setWindowDuration(uint256)` | `owner` | Default `7 days`, `> 0` |
| `remainingInWindow(address token) view` | anyone | `type(uint256).max` if unmetered |

Spend guard: a fixed (not sliding) window per token. Worst case across a boundary is 2x the cap; size caps at half the tolerable burst. `NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`. Configuration keys are listed in [registry-settings.md](registry-settings.md).

---

## Economy

`contracts/Economy.sol`. Deploys project clones (`Clones.clone`) and keeps the earnings/spendings ledgers that RepToken reads.

```solidity
constructor(uint _arbitrationFeeBps)   // admin = msg.sender
```

### Admin and governance handover

```solidity
modifier onlyGovernance() {
    if (timelockAddress == address(0)) require(msg.sender == admin, "Protected");
    else                               require(msg.sender == timelockAddress, "Protected");
}
```

- Before `setDaoAddresses`, `admin` (`EconomySetup`) configures. After it, only the timelock can; `admin` is inert.
- `transferAdmin(address newAdmin)`: only while `timelockAddress == 0` and only by `admin`. Emits `AdminTransferred`.
- `setDaoAddresses(address _timelock, address _registry, address _governor, address _repToken)`: `admin` only, once, `_timelock != 0`. Emits `DaoAddressesSet`.
- `setMinCoolingOffPeriod(uint)`: only while `timelockAddress == 0` and only by `admin` (`EconomySetup` applies its immutable `minCoolingOffPeriod`). Default 1 day; raises `coolingOffPeriod` if below. Emits `MinCoolingOffPeriodSet`. The DAO can't lower it.

### Governed setters (`onlyGovernance`)

| Function | Bounds | Event |
|----------|--------|-------|
| `setImplementations(address _native, address _erc20)` | none | none |
| `setPlatformFee(uint)` | `MIN_PLATFORM_FEE_BPS (100) <= x <= MAX_PLATFORM_FEE_BPS (5000)` | `PlatformFeeSet` |
| `setAuthorFee(uint)` | at most `MAX_AUTHOR_FEE_BPS` (2500) | `AuthorFeeSet` |
| `setArbitrationFee(uint)` | at most `MAX_ARBITRATION_FEE_BPS` (2500) | `ArbitrationFeeSet` |
| `setCoolingOffPeriod(uint)` | at least `minCoolingOffPeriod` ("Cooling-off below the minimum") | `CoolingOffPeriodSet` |
| `setBackersVoteQuorum(uint)` | `5000..9900` | `BackersVoteQuorumSet` |
| `setProjectThreshold(uint)` | none | `ProjectThresholdSet` |
| `setAppealPeriod(uint)` | none | `AppealPeriodSet` |
| `setMaxImmediateBps(uint)` | `<= 5000` | `MaxImmediateBpsSet` |

### Proposal lifecycle

```solidity
function proposalLifecycle() public view returns (uint) // governor.votingDelay() + votingPeriod() + timelock.getMinDelay()
```

It calls the `ProposalLifecycle` library (`contracts/ProposalLifecycle.sol`), which ContentCourt also uses for its appeal floor: `appealWindow() = max(appealPeriod, total(governor, timelock) + APPEAL_BUFFER)`, since its verdicts can't hold for a proposal. Projects and ToolBond use their periods as set and hold instead (below). Unreadable targets count as 0.

### Projects and ledgers

| Function | Caller | Notes |
|----------|--------|-------|
| `createProject(string name, address contractor, address arbiter, string termsHash, string repo, string description) payable` | REP balance `>= projectThreshold` | Native clone; `msg.value` is the author's locked contribution |
| `createERC20Project(..., string description, address tokenAddress)` | same | ERC20 clone |
| `updateEarnings`, `updateSpendings`, `registerBacker`, `registerProjectRoles` | project clones only (`isProjectContract`) | |
| `getUser(address) view` | anyone | Earnings, spendings (recorded plus `spentBy` on closed projects backed), role lists |
| `getConfig() view`, `getNumberOfProjects() view` | anyone | |
| `withdrawNative()`, `withdrawTokens(address)` | timelock | Sweep stray funds to the Registry |

---

## EconomyRepClaim

`contracts/EconomyRepClaim.sol`. One per Economy, deployed by `EconomySetup` and granted RepToken minter rights when the `economy` module is attached (revoked on detach). Registry key `jurisdiction.economy.rep_claim`.

```solidity
constructor(address _economy, address _repToken, address payable _registry)
function claim() external returns (uint256 amount)
function claimable(address user) external view returns (uint256 amount)
mapping(address => mapping(address => uint256)) public claimedEarnings;   // [user][token]
mapping(address => mapping(address => uint256)) public claimedSpendings;  // [user][token]
```

`claim()` reads `Economy.getUser(msg.sender)` and mints REP (`RepToken.mint`) for the unclaimed delta of earnings and spendings per token, priced by the Registry key `jurisdiction.parity.<token>`:

```
rep = amount * parity / 1e18        (PARITY_ONE = 1e18; missing or 0 parity = no REP)
```

The watermark advances even when parity is missing. See [autonet.md](autonet.md#parity-one-registry-key-one-formula) for how parity values encode decimals. Emits `ReputationClaimedFromEconomy(user, amount)`.

---

## NativeProject / ERC20Project

`contracts/NativeProject.sol`, `contracts/ERC20Project.sol`. Escrow clones, initialized by the Economy. ERC20Project uses `SafeERC20` for all token movements. Neither inherits `ReentrancyGuard`; state is updated before every external transfer.

Stages: `Open, Pending, Ongoing, Dispute, Appealable, Appeal, Closed`. `Appeal` is no longer entered (appeals run on the DAO side); it stays so stage numbers are stable.

| Function | Caller | Stage | Notes |
|----------|--------|-------|-------|
| `setParties(address contractor, address arbiter, string termsHash)` | author | Open | Starts cooling-off = `coolingOffPeriod()`. Parties named at creation get the same |
| `sendFundsWithImmediate(uint immediateBps)` payable / `(uint256 amount, uint immediateBps)` | anyone | Open, Pending | `immediateBps <= maxImmediateBps` |
| `sendFunds()` payable / `sendFunds(uint256 amount)` | anyone | Open, Pending | 0% immediate |
| `signContract()` | contractor | Pending, after cooling-off, not held | Stakes half the arbitration fee (`totalLocked * arbitrationFeeBps / 10000`); releases immediate funds with fees |
| `voteToReleasePayment()`, `voteToDispute()` | backers with locked funds | Ongoing | Weight = locked amount; quorum `backersVoteQuorumBps` of `totalLocked` |
| `disputeAsContractor()`, `reimburse()` | contractor | Ongoing | |
| `arbitrate(uint256 percent, string rulingHash)` | arbiter | Dispute | Opens the appeal window (`appealEnds = now + appealPeriod`) |
| `registerDaoProposal(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash)` | anyone | Pending until `coolingOffPeriodEnds`, Dispute until `arbitrationDeadline`, Appealable until `appealEnds` | Checks via `governor.hashProposal` that the proposal is live and calls `daoVeto` or `daoOverrule` on this project; raises `heldUntil`. Emits `DaoProposalRegistered(proposalId, overrule, heldUntil)` |
| `daoOverrule(uint256 percent, string rulingHash)` | timelock | Appealable inside the window (or later if an overrule was registered in Dispute or Appealable: `overruleFiled`), or Dispute after `appealPeriod` | |
| `finalizeArbitration()` | anyone | Appealable after window, not held | |
| `arbitrationPeriodExpired()` | anyone | Dispute after `arbitrationDeadline` (set at dispute start from the Economy's `arbitrationTimeout`), not held | Closes with full refund |
| `daoVeto()` | timelock | any but Closed | Refund of locked funds (and immediate if unsigned), less `platformFeeBps`, which goes to the Registry at once (`vetoFeeBps`) |
| `withdrawAsContractor()` | contractor | Closed | Pays with fees |
| `withdrawAsContributor()` | backer | Open, Pending, Closed | Full refund pre-signing; settlement once after close |
| `reclaimArbitrationStake()` | contractor | Closed, fee not paid out | Emits `ArbitrationStakeReclaimed` |
| `sweepOrphanedTokens(address)` | timelock | any | ERC20Project only; sends the balance above `escrowed` to the Registry |
| `spentBy(address) view`, `getProjectDetails() view` | anyone | | |
| `heldByDao() view`, `heldUntil() view` | anyone | | Whether a hold is in force; when it ends |

Holds (`contracts/DaoProposalHold.sol`): until `heldUntil`, `signContract`, `finalizeArbitration` and `arbitrationPeriodExpired` revert with "A DAO proposal about this project is pending". Registration needs the proposal live (Pending or Active, Succeeded until `proposalDeadline + GRACE`, Queued until `eta + GRACE`; `GRACE = 1 days`) and sets `heldUntil` to at least `proposalDeadline + GRACE + minDelay + GRACE`, or `eta + GRACE` once queued. ToolBond has the same per round: `registerDaoProposal(bytes32 digest, uint256 epoch, ...)` while Cooling and until `appealEnds`, for a proposal calling `daoOverrule(digest, epoch, harm)` on it, and `heldUntil(digest, epoch)`. The indexer registers proposals on `ProposalCreated` (`INDEXER_RELAYER_KEY`, gas only); anyone can if it is down.

Fees on every reputation-accruing payout (`_payWithFees`): platform fee to the Registry first, then author fee (contractor payouts only), then the net to the payee; author and payee earnings are recorded in the Economy. Arbiter payouts pay the platform fee but no author fee. If the arbiter never ruled, the fee goes to the Registry.

---

## Factories

### JurisdictionFactory

`contracts/factories/JurisdictionFactory.sol`. Creates every DAO (Firestore `jurisdictionFactory`). Flow and rationale: [architecture.md](architecture.md#jurisdictionfactory), [modules.md](modules.md).

```solidity
struct CoreParams {
    string name; string symbol; string description;
    address[] initialMembers;
    uint256[] initialAmounts;
    uint48 votingDelay;          // minutes
    uint32 votingPeriod;         // minutes
    uint256 proposalThreshold;
    uint8 quorumFraction;        // percent of supply
    uint256 executionDelay;      // seconds (timelock min delay)
}
struct ModuleRef { IModuleSetup setup; uint256 id; }

function deploy(CoreParams calldata, string[] calldata keys, string[] calldata values) external returns (Core memory)
function deployCore(CoreParams calldata) public returns (Core memory)
function finalize(Core memory core, ModuleRef[] memory modules, string[] calldata keys, string[] calldata values) public
function pendingOf(address registry) external view returns (address originator, Core memory core)
```

- `deployCore`: Timelock (admin = factory), Registry (owner = factory, no wrapper), token (RepToken with `timelockAddress` = the Timelock), Governor, `setJurisdictionAddress(token)`. Records the pending core under its Registry, bound to `msg.sender`. Emits `CoreDeployed`.
- `finalize`: originator only. Writes `keys`/`values`, then for each module in order runs `ModuleProcessor.checkInstall`, executes its `install` actions (only against this token or Registry), writes its entries and emits `ModuleAttached`. Then token admin and Registry ownership to the timelock, governor gets `PROPOSER_ROLE` and `CANCELLER_ROLE`, `EXECUTOR_ROLE` to `address(0)`, factory admin role revoked. Emits `NewDaoCreated` and deletes the pending entry.
- `deploy`: `deployCore` plus `finalize` with no modules.
- Errors: `BadParams` (member and amount lengths differ), `NotPending`, `NotOriginator`, `WrongCore`, `ForeignTarget(target)`, `ActionFailed(index)`.

### Modules

`contracts/modules/`. Concepts, checks and the module table: [modules.md](modules.md).

```solidity
struct Core { address payable registry; address timelock; address token; address governor; }
struct Action { address target; bytes data; }
struct Dependency { string name; address module; }
struct Prepared { address module; address[] helpers; Action[] install; Action[] uninstall;
                  string[] registryKeys; string[] registryValues; Dependency[] dependencies; }

// IModuleSetup (ModuleSetup implements it)
function moduleName() external view returns (string memory);
function prepareInstallation(Core calldata core, bytes calldata data) external returns (uint256 id);
function installationOf(uint256 id) external view returns (Core memory core, Prepared memory p);
function lastPreparedBy(address preparer) external view returns (uint256);
function installations() external view returns (uint256);

// ModuleProcessor (no state, no rights)
function checkCore(Core memory c) public view;
function checkInstall(IModuleSetup setup, uint256 id, address registry) public view returns (Core memory, Prepared memory);
function attachedModule(address registry, string memory name) public view returns (bool, address);
function installCalls(IModuleSetup setup, uint256 id) external view returns (address[] targets, uint256[] values, bytes[] calldatas);
function uninstallCalls(IModuleSetup setup, uint256 id) external view returns (address[] targets, uint256[] values, bytes[] calldatas);
```

- `ModuleRepo(name, maintainer)`: `createVersion(release, setup, buildMetadata, releaseMetadata)` (owner), `updateReleaseMetadata`, `getVersion(release, build)`, `latestVersion()`, `versionOf(setup)`, `isPublished(setup)`.
- `ModuleCatalog`: `register(repo)`, `remove(name)` (owner, the curator), `names()`, `isPublished(setup)`.
- Setups: `EconomySetup(nativeProjectImpl, erc20ProjectImpl, minCoolingOffPeriod)` (deploy scripts pass 60 s on chain 31337, 1 day elsewhere) with `data = abi.encode(EconomySetup.Params)` and `claimOf(id)`; `ContentCourtSetup` with `data = abi.encode(ContentCourt.Params)`; `AutonetSetup(5 code blobs)` with `data = abi.encode(AutonetParams, ToolBond.Params)` and `deploymentOf(id)` ([autonet.md](autonet.md#genesis-autonetsetup)).
- No published module declares a dependency; `Dependency` and the checks below are there for future modules.
- ModuleProcessor errors: `NotPublished`, `WrongCore`, `NotAJurisdiction`, `AlreadyAttached`, `NotAttached`, `MissingDependency(name)`, `HasDependents(name)`.

### Sub-factories

| Factory | Function |
|---------|----------|
| `InfrastructureFactory` | `deployTimelock(address admin, uint256 executionDelay)`, `deployRegistry(address initialOwner, address wrapperAddress)` |
| `DAOFactory` | `deployDAO(address token, address timelock, string name, uint[] daoSettings)`; emits `Deployed` |
| `RepTokenFactory` | `deployRepToken(name, symbol, registry, timelock, members, amounts, transferrable)`; hands admin to the caller |

---

## Debates

`contracts/debates/`. `DebatesFactory.createDebate(address token, string title, string rootArgument, uint256 rootWeight)` deploys a `Debate` argument tree. `Debate.addArgument(parentId, argType, weight, content)`, `addWeight(argumentId, weight)`, `closeDebate()` (creator only), plus views (`getFullDebate`, `getDebateSentiment`, `getRemainingVotingPower`). Each account's total weight is capped by its `getPastVotes` at the token clock just before creation.

---

## Events

```solidity
// Factories
event NewDaoCreated(address indexed dao, address token, address[] initialMembers, uint256[] initialAmounts,
    string name, string symbol, string description, uint256 executionDelay, address registry,
    string[] keys, string[] values);
event CoreDeployed(address indexed originator, address registry, address timelock, address token,
    address indexed governor);                                                                 // JurisdictionFactory
event ModuleAttached(address indexed governor, string name, address setup, uint256 id);       // JurisdictionFactory

// Modules
event InstallationPrepared(uint256 indexed id, address indexed registry, address indexed preparer, address module); // setups
event VersionCreated(uint8 release, uint16 build, address indexed setup, string buildMetadata);                    // ModuleRepo
event ReleaseMetadataUpdated(uint8 release, string releaseMetadata);                                               // ModuleRepo
event RepoRegistered(string name, address repo); event RepoRemoved(string name, address repo);                     // ModuleCatalog

// Economy
event NewProject(address indexed contractAddress, string projectName, address contractor, address arbiter,
    string termsHash, string repo, string description, address token);   // token = address(0) for native
event DaoAddressesSet(address timellock, address registry, address governor, address repToken);
event AdminTransferred(address newAdmin); event MinCoolingOffPeriodSet(uint newMin);
event PlatformFeeSet(uint); event AuthorFeeSet(uint); event ArbitrationFeeSet(uint);
event CoolingOffPeriodSet(uint); event BackersVoteQuorumSet(uint); event ProjectThresholdSet(uint);
event AppealPeriodSet(uint); event MaxImmediateBpsSet(uint); event InboundValue();

// Projects
event SetParties(address _contractor, address _arbiter, string _termsHash);
event SendFunds(address who, uint256 howMuch, uint256 immediateBps);
event ContractSigned(address contractor);
event ImmediateFundsReleased(address contractor, uint256 amount);
event BackerVoteCast(address indexed voter, uint256 votingPower, bool forDispute);
event ProjectDisputed(address by);
event ArbitrationDecision(address arbiter, uint256 percent, string rulingHash);
event DaoProposalRegistered(uint256 indexed proposalId, bool overrule);
event ArbitrationFinalized(address indexed finalizer);
event DaoOverruled(address indexed timelock, uint256 percent, string rulingHash);
event VetoedByDao(address indexed timelock);
event ContractorPaid(address contractor, uint256 amount);
event AuthorPaid(address author, uint256 amount);
event ContributorWithdrawn(address contributor, uint256 amount);
event ArbitrationStakeReclaimed(address contractor, uint256 amount);
event ProjectClosed(address by);
event OrphanedTokensSwept(address indexed token, uint256 amount);      // ERC20Project only

// RepToken (plus ERC20Votes DelegateChanged / DelegateVotesChanged)
event NewRewardEpoch(uint256 indexed epochId, RewardPool pool, uint256 budget, address indexed paymentToken, uint16 delegateBarBps);
event RewardClaimed(address indexed account, uint256 indexed epochId, uint256 amount);
event DelegateBarSet(uint16 delegateBarBps);
event DefaultDelegateUpdated(address indexed previous, address indexed current);
event AutoDelegateExemptSet(address indexed account, bool exempt);
event MinterSet(address indexed account, bool allowed);
event SlasherSet(address indexed account, bool allowed);
event Slashed(address indexed slasher, address indexed from, uint256 amount);
event Reassigned(address indexed slasher, address indexed to, uint256 amount);
event AutoDelegated(address indexed account, address indexed delegatee);

// EconomyRepClaim
event ReputationClaimedFromEconomy(address indexed user, uint256 amount);

// Registry
event RegistryUpdated(string key, string value);
event ReceivedETH(address indexed from, uint256 amount);
event ReceivedERC721(address indexed from, address indexed token, uint256 tokenId);
event TransferredETH(address indexed to, uint256 amount);
event TransferredERC20(address indexed token, address indexed to, uint256 amount);
event TransferredERC721(address indexed token, address indexed to, uint256 tokenId);
event JurisdictionAddressSet(address indexed jurisdiction);
event FundsEarmarked(bytes32 indexed purpose, uint256 amount);
event EarmarkedFundsWithdrawn(bytes32 indexed purpose, uint256 amount);
event EarmarkedFundsDisbursed(address indexed recipient, bytes32 indexed purpose, uint256 amount);
event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
event SpendCapSet(address indexed token, uint256 maxPerWindow);
event WindowDurationSet(uint256 windowDuration);
event SpendWindowReset(address indexed token, uint256 windowStart);

// Governor (OpenZeppelin): ProposalCreated, VoteCast, VoteCastWithParams, ProposalQueued,
// ProposalExecuted, ProposalCanceled
```

---

## Constants and defaults

| Constant | Value | Where |
|----------|-------|-------|
| `MIN_PLATFORM_FEE_BPS` / `MAX_PLATFORM_FEE_BPS` | `100` (1%) / `5000` (50%) | Economy |
| `MAX_AUTHOR_FEE_BPS` / `MAX_ARBITRATION_FEE_BPS` | `2500` (25%) each | Economy |
| `APPEAL_BUFFER` | `2 days`, added to the proposal lifecycle for the court's `appealWindow()` | ProposalLifecycle |
| `GRACE` | `1 days`, DAO proposal holds | DaoProposalHold |
| `NATIVE_CURRENCY` / `NATIVE_TOKEN` | `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` | Economy / Registry |
| `MAX_DELEGATE_SHARE_BPS` | `2500` | RepToken |
| `PARITY_ONE` | `1e18` | EconomyRepClaim, AutonetVault |

Economy constructor defaults (`EconomySetup` sets all but `maxImmediateBps` from its `Params`, the arbitration fee through the constructor):

| Parameter | Default |
|-----------|---------|
| `arbitrationFeeBps` | constructor arg |
| `platformFeeBps` | 100 (1%) |
| `authorFeeBps` | 100 (1%) |
| `minCoolingOffPeriod` | 1 day (set by `EconomySetup` before hand-over) |
| `coolingOffPeriod` | 1 day (at least `minCoolingOffPeriod`) |
| `backersVoteQuorumBps` | 7000 (70%) |
| `projectThreshold` | 0 |
| `appealPeriod` | 7 days |
| `maxImmediateBps` | 2000 (20%) |
| RepToken `delegateBarBps` | 100 (1% of all REP) |
| Registry `windowDuration` | 7 days; caps default to 0 (unmetered) |
