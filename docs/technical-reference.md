# Technical Reference

Per-contract API for the production suite: key functions, parameters, constants, events and access control. Signatures are taken from the current source. Autonet satellites are covered in [autonet.md](autonet.md); deployed addresses and scripts in [deployments.md](deployments.md); the threat model in [security.md](security.md).

- [Roles after deployment](#roles-after-deployment)
- [HomebaseDAO](#homebasedao) · [RepToken](#reptoken) · [Registry](#registry) · [Economy](#economy) · [NativeProject / ERC20Project](#nativeproject--erc20project)
- [Factories](#factories) · [WrappedRepToken](#wrappedreptoken) · [Debates](#debates)
- [Events](#events) · [Constants and defaults](#constants-and-defaults)

## Roles after deployment

| Contract | Privileged party after finalize | Notes |
|----------|----------------------------------|-------|
| TimelockController | `PROPOSER_ROLE`: the governor. `EXECUTOR_ROLE`: `address(0)` (anyone). Factory's `DEFAULT_ADMIN_ROLE` revoked | All governance actions are timelock calls |
| RepToken | `admin` = timelock; `timelockAddress` immutable | See the StandardFactory caveat below |
| Registry | `owner` = timelock; `wrapper` = StandardFactory (standard DAOs) or `address(0)` (economy DAOs); `jurisdictionAddress` = RepToken | |
| Economy | `timelockAddress` set once by `setDaoAddresses`; `admin` frozen | |
| Projects | `daoTimelock`, `daoGovernor` copied at initialization | |

---

## HomebaseDAO

`contracts/Dao.sol`. OpenZeppelin Governor with `GovernorSettings`, `GovernorCountingSimple`, `GovernorVotes`, `GovernorVotesQuorumFraction`, `GovernorTimelockControl`. No custom logic beyond the required overrides.

```solidity
constructor(IVotes _token, TimelockController _timelock, string memory name,
            uint48 minsDelay, uint32 minsVoting, uint256 pThreshold, uint8 qvrm)
```

- `minsDelay`, `minsVoting` are **minutes**, multiplied by 60 into `GovernorSettings`. RepToken uses `CLOCK_MODE() == "mode=timestamp"`, so the governor's delay and period are seconds on-chain.
- `pThreshold`: votes needed to propose (18-decimal token units). `qvrm`: quorum percent of past total supply.
- Inherited API: `propose`, `castVote`, `castVoteWithReason`, `queue`, `execute`, `cancel`, `state`, `votingDelay`, `votingPeriod`, `quorum`, `proposalThreshold`, `proposalNeedsQueuing`. States: `Pending, Active, Canceled, Defeated, Succeeded, Queued, Expired, Executed`.

---

## RepToken

`contracts/RepToken.sol`. `ERC20, ERC20Permit, ERC20Votes`, 18 decimals, timestamp clock.

```solidity
constructor(string name, string symbol, address payable _registryAddress, address _timelockAddress,
            address[] initialMembers, uint256[] initialAmounts, bool _isTransferable)
```

State: `admin`, `isTransferable` (immutable), `registryAddress` (immutable), `timelockAddress` (immutable), `economyAddress`, `defaultDelegate`, `autoDelegateExempt[account]`, `minters[account]`, `claimedEarnings[user][token]`, `claimedSpendings[user][token]`.

### Access control

| Function | Caller |
|----------|--------|
| `mint(address to, uint256 amount)` | `admin` or a `minters` entry |
| `burn(address from, uint256 amount)` | `admin` |
| `setAdmin(address newAdmin)` | `admin` (non-zero) |
| `setMinter(address account, bool allowed)` | `admin` or `timelockAddress` |
| `setEconomyAddress(address)` | `admin` or `timelockAddress`, once |
| `setDefaultDelegate(address)` | `admin` or `timelockAddress`; `address(0)` disables |
| `setAutoDelegateExempt(address account, bool exempt)` | `admin` or `timelockAddress` |
| `setDelegateShareBps(uint16)` | `timelockAddress` only, `<= MAX_DELEGATE_SHARE_BPS` |
| `startNewRewardEpoch(uint256 budget, address paymentToken)` | `timelockAddress` only |
| `transfer`, `transferFrom` | revert `"RepToken: Reputation is non-transferable"` unless `isTransferable` |

> **StandardFactory caveat.** The current source of the standard factories passes the DAO's timelock as `_timelockAddress`. Earlier builds passed `address(this)`, so DAOs created by those factories (including the Shadownet factories deployed 2026-10-11, until they are redeployed) have the factory as their immutable `timelockAddress`. In those DAOs, functions gated to `timelockAddress` only (`startNewRewardEpoch`, `setDelegateShareBps`) are unreachable; admin-or-timelock functions still work because `admin` is handed to the timelock. Economy DAOs (TrustlessFactory) always passed the real timelock.

### Reputation from the Economy

`claimReputationFromEconomy()`: reads `Economy.getUser(msg.sender)` and mints REP for the unclaimed delta of earnings and spendings per token, priced by the Registry key `jurisdiction.parity.<token>`:

```
rep = amount * parity / 1e18        (PARITY_ONE = 1e18; missing or 0 parity = no REP)
```

See [autonet.md](autonet.md#parity-one-registry-key-one-formula) for how parity values encode decimals. Emits `ReputationClaimedFromEconomy(user, amount)`.

### Reward epochs

Each REP earns its share of an epoch budget once. A holder delegated to someone else keeps `(1 - delegateShareBps)` of their share; the delegate earns the rest. Self-delegation (or no delegation) keeps 100%.

| Item | Detail |
|------|--------|
| `startNewRewardEpoch(uint256 budget, address paymentToken)` | Timelock only, `budget > 0`. Increments `currentRewardEpoch`, snapshots `delegateShareBps`, and calls `Registry.earmarkFunds(rewardPurpose(id, token), budget, token)` in the same call (reverts if the Registry lacks unreserved balance). Use `0xEeee...EEeE` for native currency |
| `rewardOf(uint256 epochId, address account) view` | `weight * budget / pastTotalSupply` at `startTimestamp - 1`, where `weight` = own balance (reduced by the delegate share if delegated elsewhere) + delegate share of votes delegated in |
| `claimReward(uint256 epochId)` | Once per epoch per account, non-zero; pays via `Registry.disburseEarmarked` |
| `rewardPurpose(uint256 epochId, address paymentToken) pure` | `keccak256(abi.encodePacked("REWARD", epochId, paymentToken))` |
| `delegateShareBps` | Default `100` (1%); max `MAX_DELEGATE_SHARE_BPS = 2500` |
| `getRewardEpochStart(uint256)`, `pastDelegatee(address, uint256)` | Views (`IJurisdictionData`) |
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
| `batchEditRegistry(string[] keys, string[] values)` | `owner` or `wrapper` | No event |
| `getRegistryValue(string)`, `getAllKeys()`, `getAllValues()` | anyone | |
| `setJurisdictionAddress(address)` | `owner` or `wrapper` | |
| `transferOwnership(address)` | `owner` | |
| `transferETH(address payable to, uint256 amount)` | `owner` | `nonReentrant`, unreserved balance only, metered |
| `transferERC20(address token, address to, uint256 amount)` | `owner` | `nonReentrant`, unreserved, metered |
| `transferERC721(address token, address to, uint256 tokenId)` | `owner` | Unmetered |
| `earmarkFunds(bytes32 purpose, uint256 amount, address token)` | `owner` or `jurisdictionAddress` | Cannot exceed unreserved balance; purpose bound to one token |
| `withdrawEarmarkedFunds(bytes32 purpose, uint256 amount)` | `owner` | Releases the reservation (funds stay) |
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

- Before `setDaoAddresses`, `admin` (the factory) configures. After it, only the timelock can; `admin` is inert.
- `transferAdmin(address newAdmin)`: only while `timelockAddress == 0` and only by `admin` (`EconomyFactory` uses it to hand admin to the calling factory). Emits `AdminTransferred`.
- `setDaoAddresses(address _timelock, address _registry, address _governor, address _repToken)`: `admin` only, once, `_timelock != 0`. Emits `DaoAddressesSet`.

### Governed setters (`onlyGovernance`)

| Function | Bounds | Event |
|----------|--------|-------|
| `setImplementations(address _native, address _erc20)` | none | none |
| `setPlatformFee(uint)` | `MIN_PLATFORM_FEE_BPS (100) <= x <= MAX_PLATFORM_FEE_BPS (5000)` | `PlatformFeeSet` |
| `setAuthorFee(uint)` | at most `MAX_AUTHOR_FEE_BPS` (2500) | `AuthorFeeSet` |
| `setArbitrationFee(uint)` | at most `MAX_ARBITRATION_FEE_BPS` (2500) | `ArbitrationFeeSet` |
| `setCoolingOffPeriod(uint)` | none (floored at read time, below) | `CoolingOffPeriodSet` |
| `setBackersVoteQuorum(uint)` | `5000..9900` | `BackersVoteQuorumSet` |
| `setProjectThreshold(uint)` | none | `ProjectThresholdSet` |
| `setAppealPeriod(uint)` | none | `AppealPeriodSet` |
| `setMaxImmediateBps(uint)` | `<= 5000` | `MaxImmediateBpsSet` |

### Cooling-off floor

```solidity
function proposalLifecycle() public view returns (uint)          // governor.votingDelay() + votingPeriod() + timelock.getMinDelay()
function effectiveCoolingOffPeriod() external view returns (uint) // max(coolingOffPeriod, proposalLifecycle() + COOLING_OFF_BUFFER)
function effectiveAppealPeriod() external view returns (uint)     // max(appealPeriod, proposalLifecycle() + APPEAL_BUFFER)
```

Projects use `effectiveCoolingOffPeriod()`, so the DAO always has time to pass a veto before the contractor can sign. Unreadable targets count as 0.

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

## NativeProject / ERC20Project

`contracts/NativeProject.sol`, `contracts/ERC20Project.sol`. Escrow clones, initialized by the Economy. ERC20Project uses `SafeERC20` for all token movements. Neither inherits `ReentrancyGuard`; state is updated before every external transfer.

Stages: `Open, Pending, Ongoing, Dispute, Appealable, Appeal, Closed`. `Appeal` is no longer entered (appeals run on the DAO side); it stays so stage numbers are stable.

| Function | Caller | Stage | Notes |
|----------|--------|-------|-------|
| `setParties(address contractor, address arbiter, string termsHash)` | author | Open | Starts cooling-off = `effectiveCoolingOffPeriod()`. Parties named at creation get the same |
| `sendFundsWithImmediate(uint immediateBps)` payable / `(uint256 amount, uint immediateBps)` | anyone | Open, Pending | `immediateBps <= maxImmediateBps` |
| `sendFunds()` payable / `sendFunds(uint256 amount)` | anyone | Open, Pending | 0% immediate |
| `signContract()` | contractor | Pending, after cooling-off | Stakes half the arbitration fee (`totalLocked * arbitrationFeeBps / 10000`); releases immediate funds with fees |
| `voteToReleasePayment()`, `voteToDispute()` | backers with locked funds | Ongoing | Weight = locked amount; quorum `backersVoteQuorumBps` of `totalLocked` |
| `disputeAsContractor()`, `reimburse()` | contractor | Ongoing | |
| `arbitrate(uint256 percent, string rulingHash)` | arbiter | Dispute | Opens the appeal window (`effectiveAppealPeriod`) |
| `daoOverrule(uint256 percent, string rulingHash)` | timelock | Appealable inside the window, or Dispute after `appealPeriod` | |
| `finalizeArbitration()` | anyone | Appealable after window | |
| `arbitrationPeriodExpired()` | anyone | Dispute after `ARBITRATION_TIMEOUT` | Closes with full refund |
| `daoVeto()` | timelock | any but Closed | Full refund of locked funds (and immediate if unsigned) |
| `withdrawAsContractor()` | contractor | Closed | Pays with fees |
| `withdrawAsContributor()` | backer | Open, Pending, Closed | Full refund pre-signing; settlement once after close |
| `reclaimArbitrationStake()` | contractor | Closed, fee not paid out | Emits `ArbitrationStakeReclaimed` |
| `sweepOrphanedTokens(address)` | timelock | any | ERC20Project only; sends untracked balance to the Registry |
| `spentBy(address) view`, `getProjectDetails() view` | anyone | | |

Fees on every reputation-accruing payout (`_payWithFees`): platform fee to the Registry first, then author fee (contractor payouts only), then the net to the payee; author and payee earnings are recorded in the Economy. Arbiter payouts pay the platform fee but no author fee. If the arbiter never ruled, the fee goes to the Registry.

---

## Factories

### StandardFactory family (single transaction)

`StandardFactory` (non-transferable, Firestore `wrapper`), `StandardFactoryTransferable` (`wrapper_t`), `StandardFactoryNonTransferable`, `StandardFactoryWrapped` (`wrapper_w`).

```solidity
function deployDAOwithToken(DaoParams memory params) public payable
function deployDAOwithToken(string name, string symbol, string description, uint8 decimals,
    uint256 executionDelay, address[] initialMembers, uint256[] initialAmounts,
    string[] keys, string[] values) public payable                      // legacy overload
function deployDAOwithWrappedToken(DaoParamsWrapped memory params) public payable   // StandardFactoryWrapped
```

- `initialAmounts` = member amounts followed by `[votingDelayMins, votingPeriodMins, proposalThreshold, quorumPercent]`.
- `executionDelay` is the timelock min delay in **seconds**.
- Finalization: `Registry.setJurisdictionAddress(token)`, token admin to timelock, Registry ownership to timelock, governor gets `PROPOSER_ROLE`, `EXECUTOR_ROLE` to `address(0)`, factory admin role revoked, then `batchEditRegistry` (allowed because the factory stays the Registry `wrapper`).
- Event: `NewDaoCreated` (`DaoWrappedDeploymentInfo` for the wrapped factory).

### TrustlessFactory (three transactions)

Each in-progress deployment is stored in `mapping(address => DeploymentData) private pendingDeployments` keyed by `msg.sender`. Steps 2 and 3 check that the caller started step 1 and that the addresses passed are the caller's own, so nobody else can finalize a half-deployed suite with their own governor.

```solidity
function deployInfrastructure(uint48 timelockDelayInMinutes, uint arbitrationFeeBps) external
function deployDAOToken(address registryAddr, address timelockAddr,
                        TokenParams calldata, GovParams calldata) external
function configureAndFinalize(AddressParams calldata, EconomyParams calldata,
                              string[] calldata _registryKeys, string[] calldata _registryValues) external
```

| Struct | Fields |
|--------|--------|
| `TokenParams` | `name, symbol, initialMembers[], initialAmounts[]` (token is always non-transferable) |
| `GovParams` | `name, votingDelay` (minutes), `votingPeriod` (minutes), `proposalThreshold, quorumFraction` |
| `AddressParams` | `implAddresses[2]` = [native, erc20]; `contractAddresses[5]` = [economy, registry, timelock, repToken, dao] |
| `EconomyParams` | `arbitrationFeeBps` (at most 2500), `initialPlatformFeeBps` (must be `>= 100`), `initialAuthorFeeBps, initialCoolingOffPeriod, initialBackersQuorumBps, initialProjectThreshold, initialAppealPeriod` |

Step 3 sets implementations and parameters, links RepToken and Registry, writes the registry keys, calls `setDaoAddresses` (freezing Economy admin), hands RepToken admin and Registry ownership to the timelock, wires timelock roles, then emits `SuiteConfigured` and `NewDaoCreated` and deletes the pending entry. `maxImmediateBps` is left at its default (2000).

### Sub-factories

| Factory | Function |
|---------|----------|
| `InfrastructureFactory` | `deployTimelock(address admin, uint256 executionDelay)`, `deployRegistry(address initialOwner, address wrapperAddress)` |
| `DAOFactory` | `deployDAO(address token, address timelock, string name, uint[] daoSettings)`; emits `Deployed` |
| `RepTokenFactory` | `deployRepToken(name, symbol, registry, timelock, members, amounts, transferrable)`; hands admin to the caller |
| `EconomyFactory` | `deployEconomy(uint arbitrationFeeBps)`; `transferAdmin(msg.sender)` |
| `WrappedRepTokenFactory` | `deployWrappedRepToken(IERC20 underlying, name, symbol, transferrable)` |

---

## WrappedRepToken

`contracts/WrappedRepToken.sol`. `ERC20Wrapper + ERC20Votes` over an existing ERC20 (deposit/withdraw 1:1), optional non-transferability, `setAdmin` by admin. Decimals follow the underlying token.

## Debates

`contracts/debates/`. `DebatesFactory.createDebate(address token, string title, string rootArgument, uint256 rootWeight)` deploys a `Debate` argument tree. `Debate.addArgument(parentId, argType, weight, content)`, `addWeight(argumentId, weight)`, `closeDebate()` (creator only), plus views (`getFullDebate`, `getDebateSentiment`, `getRemainingVotingPower`). Each account's total weight is capped by its `getPastVotes` at the token clock just before creation.

---

## Events

```solidity
// Factories
event NewDaoCreated(address indexed dao, address token, address[] initialMembers, uint256[] initialAmounts,
    string name, string symbol, string description, uint256 executionDelay, address registry,
    string[] keys, string[] values);
event InfrastructureDeployed(address economy, address registry, address timelock);           // TrustlessFactory
event DAOTokenDeployed(address repToken, address dao);                                         // TrustlessFactory
event SuiteConfigured(address deployer, address indexed economy, address registry, address timelock,
    address indexed repToken, address indexed dao);                                            // TrustlessFactory

// Economy
event NewProject(address indexed contractAddress, string projectName, address contractor, address arbiter,
    string termsHash, string repo, string description, address token);   // token = address(0) for native
event DaoAddressesSet(address timellock, address registry, address governor, address repToken);
event AdminTransferred(address newAdmin);
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
event NewRewardEpoch(uint256 indexed epochId, uint256 budget, address indexed paymentToken, uint16 delegateShareBps);
event RewardClaimed(address indexed account, uint256 indexed epochId, uint256 amount);
event DelegateShareSet(uint16 delegateShareBps);
event ReputationClaimedFromEconomy(address indexed user, uint256 amount);
event DefaultDelegateUpdated(address indexed previous, address indexed current);
event AutoDelegateExemptSet(address indexed account, bool exempt);
event MinterSet(address indexed account, bool allowed);
event AutoDelegated(address indexed account, address indexed delegatee);

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
| `ARBITRATION_TIMEOUT` | `150 days` | projects |
| `MIN_PLATFORM_FEE_BPS` / `MAX_PLATFORM_FEE_BPS` | `100` (1%) / `5000` (50%) | Economy |
| `MAX_AUTHOR_FEE_BPS` / `MAX_ARBITRATION_FEE_BPS` | `2500` (25%) each | Economy |
| `COOLING_OFF_BUFFER` | `1 days`, added to the proposal lifecycle floor | Economy |
| `APPEAL_BUFFER` | `2 days`, added to the proposal lifecycle for `effectiveAppealPeriod` | Economy |
| `NATIVE_CURRENCY` / `NATIVE_TOKEN` | `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` | Economy / Registry |
| `MAX_DELEGATE_SHARE_BPS` | `2500` | RepToken |
| `PARITY_ONE` | `1e18` | RepToken, CoinOffering, AutonetVault |

Economy constructor defaults (TrustlessFactory overrides all but `maxImmediateBps` and the arbitration fee, which comes from step 1):

| Parameter | Default |
|-----------|---------|
| `arbitrationFeeBps` | constructor arg |
| `platformFeeBps` | 100 (1%) |
| `authorFeeBps` | 100 (1%) |
| `coolingOffPeriod` | 120 s (floored by `effectiveCoolingOffPeriod`) |
| `backersVoteQuorumBps` | 7000 (70%) |
| `projectThreshold` | 0 |
| `appealPeriod` | 7 days |
| `maxImmediateBps` | 2000 (20%) |
| RepToken `delegateShareBps` | 100 (1%) |
| Registry `windowDuration` | 7 days; caps default to 0 (unmetered) |
