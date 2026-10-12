# Governance

How a jurisdiction governs itself: the Governor, its Timelock, the RepToken that carries voting power, reward epochs, and the Registry that holds the treasury and configuration. For how these contracts are deployed and wired together, see [architecture.md](architecture.md). For function-level API detail, see [technical-reference.md](technical-reference.md).

Sources: `contracts/Dao.sol`, `RepToken.sol`, `WrappedRepToken.sol`, `Registry.sol`, `IJurisdictionData.sol`, `IAdminToken.sol`, `contracts/factories/`, `contracts/debates/`. Behaviour described here is exercised by `test/dao-governance*.test.js`, `test/reward-epochs.test.js`, `test/default-delegate.test.js`, `test/treasury-spend-guard.test.js` and `test/security.test.js`.

## Contracts at a glance

| Contract | Role | Controlled by (after deployment) |
|---|---|---|
| `HomebaseDAO` (`Dao.sol`) | OpenZeppelin 5.x Governor: proposals and votes | Itself (settings changes go through proposals) |
| `TimelockController` (OZ) | Executes passed proposals after a delay; the jurisdiction's identity on-chain | Governor is the only proposer; anyone may execute |
| `RepToken` | ERC20Votes reputation token, reward epochs, Economy reputation pull | `admin` = Timelock, plus `timelockAddress` for epoch functions |
| `WrappedRepToken` | ERC20Votes wrapper over an existing ERC20 (wrapped-token DAOs) | `admin` = Timelock (no other admin powers) |
| `Registry` | Treasury (native, ERC20, ERC721), key/value config, earmarks, spend cap | `owner` = Timelock |

Every governance action follows the same path: **propose, vote, queue, execute**. The Timelock is the `msg.sender` of every executed action, so anything gated to "the DAO" is gated to the Timelock address.

## The Governor (`HomebaseDAO`)

`HomebaseDAO` composes these OpenZeppelin extensions with no custom logic beyond the required overrides:

| Extension | Effect |
|---|---|
| `GovernorSettings` | `votingDelay`, `votingPeriod`, `proposalThreshold`, changeable later by proposal |
| `GovernorCountingSimple` | Against (0), For (1), Abstain (2) |
| `GovernorVotes` | Voting power from the token's `IVotes` checkpoints |
| `GovernorVotesQuorumFraction` | Quorum as a percentage of total supply at the snapshot |
| `GovernorTimelockControl` | Passed proposals are queued in and executed by the Timelock |

Constructor:

```solidity
HomebaseDAO(
    IVotes _token,                 // RepToken or WrappedRepToken
    TimelockController _timelock,
    string memory name,
    uint48 minsDelay,              // voting delay, MINUTES (converted to seconds)
    uint32 minsVoting,             // voting period, MINUTES (converted to seconds)
    uint256 pThreshold,            // votes needed to propose (token base units)
    uint8 qvrm                     // quorum numerator, out of 100
)
```

**Clock.** Both token types use `CLOCK_MODE() = "mode=timestamp"`, so every snapshot, delay and period is in seconds of `block.timestamp`, not block numbers.

### Proposal lifecycle

```
            propose()                    votingDelay elapses
  ------------------------> Pending ---------------------------> Active
                              |                                    |
                    cancel()  |                     votingPeriod   |
                (proposer,    v                       elapses      v
                 Pending only) Canceled          +-----------------+-----------------+
                                                 |                                   |
                                     quorum met AND For > Against           otherwise
                                                 v                                   v
                                             Succeeded                           Defeated
                                                 | queue()  (anyone)
                                                 v
                                               Queued
                                                 | Timelock minDelay elapses, execute() (anyone)
                                                 v
                                              Executed
```

There is no `Expired` state in practice: the OZ `TimelockController` has no grace period, so a queued proposal stays executable indefinitely.

1. **Delegate.** Voting power is `getVotes`, which only counts delegated balances. A holder must call `delegate(self)` or `delegate(rep)`. The exception is a RepToken with a `defaultDelegate` configured (see below), which auto-delegates new holders.
2. **Propose.** `propose(targets, values, calldatas, description)`. The proposer needs `getVotes(proposer, now - 1) >= proposalThreshold`. Multiple actions in one proposal execute atomically.
3. **Voting delay.** The snapshot timepoint is `proposal time + votingDelay`. Delegations made during the delay still count.
4. **Vote.** `castVote`, `castVoteWithReason`, `castVoteWithReasonAndParams`, or `castVoteBySig`. Weight is the voter's votes at the snapshot. Delegation is one hop: a delegate cannot pass received votes on.
5. **Outcome.** Succeeded if `For > Against` (ties fail) and `For + Abstain >= quorum`, where `quorum = totalSupplyAtSnapshot * qvrm / 100`.
6. **Queue.** Anyone calls `queue(targets, values, calldatas, keccak256(bytes(description)))`.
7. **Execute.** After the Timelock's `minDelay`, anyone calls `execute(...)` with the same arguments.

### Timelock roles

The factories deploy the Timelock with empty proposer and executor lists and the factory as temporary admin, then finalize:

| Role | Holder after deployment |
|---|---|
| `PROPOSER_ROLE` | The Governor only |
| `EXECUTOR_ROLE` | `address(0)`, i.e. anyone |
| `CANCELLER_ROLE` | The governor (standard OZ wiring). The public `cancel` only works while a proposal is Pending, so no one can stop a queued operation; the timelock administers itself, so the DAO can grant this role to a guardian by proposal |
| `DEFAULT_ADMIN_ROLE` | The Timelock itself (OZ default); the factory's grant is revoked |

Consequences: role changes are possible, but only through a proposal executed by the Timelock. A queued operation cannot be cancelled by anyone, and the Governor's own `cancel` only works while a proposal is `Pending`.

### Parameters by factory

Voting delay and period are always minutes (the Governor converts). Timelock delay units differ by factory:

| Factory | Voting delay / period / threshold / quorum | Timelock delay |
|---|---|---|
| `StandardFactory`, `StandardFactoryNonTransferable`, `StandardFactoryTransferable` | Last four entries of `initialAmounts` (appended after the member amounts) | `executionDelay`, passed straight through, seconds |
| `StandardFactoryWrapped` | `governanceSettings[4]` | `executionDelay`, seconds |
| `TrustlessFactory` | `GovParams.votingDelay` (minutes) | `deployInfrastructure(timelockDelayInMinutes, ...)`, minutes |

## RepToken

`RepToken is ERC20, ERC20Permit, ERC20Votes, IAdminToken, IJurisdictionData`, 18 decimals, timestamp clock.

### Authority

Two addresses matter, and they are set differently:

- `admin`: starts as the deployer (`RepTokenFactory`), handed to the calling top-level factory, then to the Timelock in finalization. `setAdmin` is admin-only and rejects `address(0)`.
- `timelockAddress`: **immutable**, set in the constructor. Reward epoch functions (`startNewRewardEpoch`, `setDelegateShareBps`) check this address, not `admin`.

| Function | Caller |
|---|---|
| `mint(to, amount)` | `admin` or an address in `minters` |
| `burn(from, amount)` | `admin` only |
| `setMinter`, `setDefaultDelegate`, `setAutoDelegateExempt` | `admin` or `timelockAddress` |
| `setEconomyAddress` | `admin` or `timelockAddress`, once only |
| `startNewRewardEpoch`, `setDelegateShareBps` | `timelockAddress` only |
| `setAdmin` | `admin` only |

### Transferability

`isTransferable` is immutable. When false, `transfer` and `transferFrom` revert; minting and burning still work. `TrustlessFactory` always deploys non-transferable tokens; `StandardFactory` and `StandardFactoryNonTransferable` deploy non-transferable; `StandardFactoryTransferable` deploys transferable.

### Minters

`minters[account]` lets a contract mint without being admin. It exists for satellites such as `CoinOffering` (mints to buyers up to its cap) and `AutonetRepClaim` (mints REP against Autonet earnings). Granting it is a governance action. See [autonet.md](autonet.md).

### Default delegate

If `defaultDelegate != address(0)`, any account that receives tokens (mint or transfer) while it has no delegate is auto-delegated to `defaultDelegate` and `AutoDelegated` is emitted. It never fires for the default delegate itself, for accounts in `autoDelegateExempt` (inventory-holding contracts, so unsold float does not vote), or for accounts that already chose a delegate. A holder can always re-delegate; their choice is never overwritten. Disabled by default.

### Reputation from the Economy

In Economy DAOs, `claimReputationFromEconomy()` reads the caller's cumulative earnings and spendings per token from `Economy.getUser`, takes the increase since the last claim, and mints:

```
reputation = unclaimedAmount * parity / 1e18
parity     = Registry["jurisdiction.parity.<lowercase token hex address>"]
```

Parity is an 18-decimal fixed-point multiplier (`1e18` = 1:1, and a 6-decimal token at 1:1 uses `1e30`). A missing or zero parity mints nothing for that token, but the claimed watermark still advances. See [registry-settings.md](registry-settings.md) and [economy.md](economy.md).

### Reward epochs

There is one reward pool per epoch. Each REP earns its share of the budget exactly once; delegation only moves a small cut from the holder to their delegate. The old split into passive-income and delegate-reward epochs no longer exists.

```solidity
uint16 public constant MAX_DELEGATE_SHARE_BPS = 2500;  // 25%
uint16 public delegateShareBps = 100;                   // 1% default

function setDelegateShareBps(uint16 newShareBps) external;              // timelock only, <= 2500
function startNewRewardEpoch(uint256 budget, address paymentToken) external;  // timelock only
function rewardOf(uint256 epochId, address account) public view returns (uint256);
function claimReward(uint256 epochId) external;
function pastDelegatee(address account, uint256 timepoint) public view returns (address);
function rewardPurpose(uint256 epochId, address paymentToken) public pure returns (bytes32);
    // keccak256(abi.encodePacked("REWARD", epochId, paymentToken))
```

**Starting.** `startNewRewardEpoch` increments `currentRewardEpoch`, records `{budget, paymentToken, startTimestamp, delegateShareBps}` (the share is frozen per epoch), and calls `Registry.earmarkFunds(rewardPurpose(...), budget, paymentToken)` in the same transaction. There is no separate earmark step; the call reverts if the Registry's unreserved balance of that token is below `budget`. `paymentToken` may be `Registry.NATIVE_TOKEN` (`0xEeee...EEeE`) for the native currency.

**Computing.** All inputs are read at `snapshot = startTimestamp - 1`:

```
s          = epoch.delegateShareBps
balance    = past balance of account
delegatee  = pastDelegatee(account, snapshot)
weight     = balance                       if delegatee is 0 or account
           = balance * (10000 - s) / 10000 otherwise
delegatedIn = getPastVotes(account, snapshot) - (delegatee == account ? balance : 0)
weight    += delegatedIn * s / 10000
reward     = weight * budget / getPastTotalSupply(snapshot)
```

Summed over all holders the weights equal total supply, so payouts never exceed the budget. Delegating to your own second wallet returns exactly what you would have had. `pastDelegatee` is backed by a per-account delegatee checkpoint trace written on every `_delegate` (including auto-delegation); balances use a separate `_balanceHistory` trace written in `_update`.

**Claiming.** `claimReward(epochId)` marks `hasClaimedReward[epochId][caller]`, then calls `Registry.disburseEarmarked`, which pays ERC20 or native currency. Zero rewards revert.

**Unclaimed funds.** After the next epoch has started and `benefits.claim.gracePeriod` seconds have passed since that start, the Timelock can call `Registry.reclaimEarmarkedFunds(epochId, paymentToken)` to release the remaining reservation back to the free treasury balance. The money never leaves the Registry; only the earmark is lifted.

`getRewardEpochStart(epochId)` is the only `IJurisdictionData` function and is what the Registry uses for that grace-period check.

## WrappedRepToken

`ERC20 + ERC20Permit + ERC20Votes + ERC20Wrapper`, timestamp clock, decimals inherited from the underlying token. Holders call `depositFor` / `withdrawTo` to wrap and unwrap 1:1; wrapped balances are the voting power. `isTransferable` (immutable) blocks `transfer`/`transferFrom` only. It has an `admin` (set to the Timelock) but no mint, burn, epoch, Economy or Registry features, and `StandardFactoryWrapped` does not set the Registry's `jurisdictionAddress`. Reward epochs and the Economy reputation pull are therefore RepToken-only.

## Registry

One contract per jurisdiction. `owner` is the Timelock after deployment.

### Access

| Modifier / check | Allowed callers | Functions |
|---|---|---|
| `_treasuryOps` | `owner` | `transferETH`, `transferERC20`, `transferERC721`, `setSpendCap`, `setWindowDuration`, `withdrawEarmarkedFunds`, `reclaimEarmarkedFunds` |
| `_regedit` | `owner` or `wrapper` | `editRegistry`, `batchEditRegistry`, `setJurisdictionAddress` |
| owner or `jurisdictionAddress` | | `earmarkFunds` |
| `jurisdictionAddress` only | | `disburseEarmarked` |
| `owner` | | `transferOwnership` |

`wrapper` is fixed at construction: the factory address for the Standard factories, `address(0)` for `TrustlessFactory`. `jurisdictionAddress` is the RepToken.

### Configuration store

`editRegistry(key, value)` (emits `RegistryUpdated`), `batchEditRegistry(keys, values)` (emits `RegistryUpdated` per key; arrays must match in length), `getRegistryValue`, `getAllKeys`, `getAllValues`. Values are strings; consumers parse them. Keys in use are listed in [registry-settings.md](registry-settings.md).

### Earmarks

Earmarks reserve real balance, per token:

- `earmarkedFunds[purpose]`, `earmarkToken[purpose]` (a purpose is bound to one token forever), `totalEarmarked[token]`.
- `earmarkFunds` requires `balance(token) >= totalEarmarked[token] + amount`, so the same funds cannot be promised twice.
- `transferETH` and `transferERC20` require `balance >= totalEarmarked[token] + amount`, so ordinary spending cannot touch reserved funds.
- `withdrawEarmarkedFunds(purpose, amount)` (owner) releases a reservation without moving funds. It refuses purposes the jurisdiction earmarked (reward epochs, tracked in `rewardEarmark`); those only come back through `reclaimEarmarkedFunds` after the grace period, so members always get their full claim window.
- `disburseEarmarked` pays from a reservation (ERC20 `transfer` or native `call`) and is `nonReentrant`.

### Spend cap

A per-token fixed-window rate limit on outflows: `maxPerWindow[token]` (0 = unmetered, the default), `windowDuration` (default 7 days), `windowStart`, `spentInWindow`, `remainingInWindow(token)`. It meters `transferETH`, `transferERC20` and `disburseEarmarked` against the same per-token window; ERC721 transfers are not metered. Being fixed-window, up to 2x the cap can leave across a window boundary, so size the cap at half the tolerable burst.

## Debates

`contracts/debates/` is independent of the Governor: a signalling tool that any `IVotes` + `IERC6372` token can use.

- `DebatesFactory.createDebate(token, title, rootArgument, rootWeight)` deploys a `Debate` and indexes it globally and per token (`getDebates`, `getDebatesByToken`, `getDebateList*`).
- A `Debate` snapshots at `token.clock() - 1`. Each address gets a budget equal to its past votes; staking weight on new arguments (`addArgument(parentId, PRO|CON, weight, content)`) or existing ones (`addWeight`) spends from it, and nothing is refunded.
- `netScore = directWeight + sum(PRO children netScore) - sum(CON children netScore)`, recomputed up the tree on each change. `getDebateSentiment()` is the root's score.
- Only the creator can `closeDebate()`. Nothing on-chain acts on the result.

## Common proposals

All are `dao.propose([target], [0], [calldata], description)`.

| Action | Target | Calldata |
|---|---|---|
| Pay from treasury | Registry | `transferERC20(token, to, amount)` or `transferETH(to, amount)` |
| Mint / burn REP | RepToken | `mint(to, amount)` / `burn(from, amount)` |
| Set a parity | Registry | `editRegistry("jurisdiction.parity.0x...", "1000000000000000000")` |
| Start a reward epoch | RepToken | `startNewRewardEpoch(budget, token)` |
| Change delegate share | RepToken | `setDelegateShareBps(bps)` |
| Arm the spend cap | Registry | `setSpendCap(token, cap)` |
| Grant a minter | RepToken | `setMinter(contract, true)` |
| Economy parameter | Economy | `setPlatformFee(bps)` etc. (see [economy.md](economy.md)) |
| Overrule arbitration | Project | `daoOverrule(percent, rulingHash)` (inside the appeal window, or on a silent arbiter) |
| Veto a project | Project | `daoVeto()` |

An appeal is just this proposal: nothing is registered on the project. The appeal window always fits a full proposal lifecycle plus two days; see [economy.md](economy.md).

## Known caveats

- **Standard DAOs cannot run reward epochs.** All three `StandardFactory*` contracts pass `address(this)` (the factory) as the RepToken's `timelockAddress`. Because it is immutable, `startNewRewardEpoch` and `setDelegateShareBps` are permanently uncallable on those DAOs. Admin-gated functions still work because `admin` is moved to the real Timelock. `TrustlessFactory` passes the real Timelock and is unaffected.
- **Reward-epoch events are not indexed.** The indexer does not listen to `NewRewardEpoch` or `RewardClaimed`; apps must read them from chain.

## Further reading

- [architecture.md](architecture.md): contract graph, deployment flow, indexer and apps
- [economy.md](economy.md): projects, arbitration, appeals
- [registry-settings.md](registry-settings.md): registry keys and Economy parameters
- [technical-reference.md](technical-reference.md): full API
- [autonet.md](autonet.md): Autonet satellites (minters, Coin Offering)
- [deployments.md](deployments.md): live addresses
- [OpenZeppelin Governor 5.x](https://docs.openzeppelin.com/contracts/5.x/governance)
