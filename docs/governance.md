# Governance

How a jurisdiction governs itself: the Governor, its Timelock, the RepToken that carries voting power, reward epochs, and the Registry that holds the treasury and configuration. For how these contracts are deployed and wired together, see [architecture.md](architecture.md). For function-level API detail, see [technical-reference.md](technical-reference.md).

Sources: `contracts/Dao.sol`, `RepToken.sol`, `WrappedRepToken.sol`, `Registry.sol`, `IJurisdictionData.sol`, `IAdminToken.sol`, `contracts/factories/`, `contracts/debates/`. Behaviour described here is exercised by `test/dao-governance*.test.js`, `test/reward-epochs.test.js`, `test/default-delegate.test.js`, `test/treasury-spend-guard.test.js` and `test/security.test.js`.

## Contracts at a glance

| Contract | Role | Controlled by (after deployment) |
|---|---|---|
| `HomebaseDAO` (`Dao.sol`) | OpenZeppelin 5.x Governor: proposals and votes | Itself (settings changes go through proposals) |
| `TimelockController` (OZ) | Executes passed proposals after a delay; the jurisdiction's identity on-chain | Governor is the only proposer; anyone may execute |
| `RepToken` | ERC20Votes reputation token, reward epochs, minters and slashers | `admin` = Timelock, plus `timelockAddress` for epoch functions |
| `WrappedRepToken` | ERC20Votes wrapper over an existing ERC20 (wrapped-token DAOs) | `admin` = Timelock (no other admin powers) |
| `Registry` | Treasury (native, ERC20, ERC721), key/value config, earmarks, spend cap | `owner` = Timelock |

Every governance action follows the same path: **propose, vote, queue, execute**. The Timelock is the `msg.sender` of every executed action, so anything gated to "the DAO" is gated to the Timelock address.

## The Governor (`HomebaseDAO`)

`HomebaseDAO` composes these OpenZeppelin extensions. Its custom logic is early decision (step 5 below), options mode and constitutional proposals (below):

| Extension | Effect |
|---|---|
| `GovernorSettings` | `votingDelay`, `votingPeriod`, `proposalThreshold`, changeable later by proposal |
| `GovernorCountingSimple` | Against (0), For (1), Abstain (2) |
| `GovernorVotes` | Voting power from the token's `IVotes` checkpoints |
| `GovernorVotesQuorumFraction` | Quorum as a percentage of total supply at the snapshot |
| `GovernorTimelockControl` | Passed proposals are queued in and executed by the Timelock |
| `GovernorSuperQuorum` | Early success once For reaches `max(quorum, half of supply + 1)`; early defeat (custom) once Against reaches half |

Constructor:

```solidity
HomebaseDAO(
    IVotes _token,                 // RepToken or WrappedRepToken
    TimelockController _timelock,
    string memory name,
    uint48 minsDelay,              // voting delay, MINUTES (converted to seconds)
    uint32 minsVoting,             // voting period, MINUTES (converted to seconds)
    uint256 pThreshold,            // votes needed to propose (token base units)
    uint8 qvrm,                    // quorum numerator, out of 100
    address _launcher,             // the factory, which may approve option sources until the handover
    uint256 _supermajorityBps      // share of For+Against a constitutional proposal needs, 5001..10000
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
5. **Outcome.** Succeeded if `For > Against` (ties fail) and `For + Abstain >= quorum`, where `quorum = totalSupplyAtSnapshot * qvrm / 100`. A constitutional proposal needs `For * 10000 >= supermajorityBps * (For + Against)` instead of `For > Against` (below).
   **Early decision.** A proposal is decided as soon as its outcome can't change. It is Succeeded before the deadline once For reaches `superQuorum = max(quorum, totalSupplyAtSnapshot / 2 + 1)` (OpenZeppelin `GovernorSuperQuorum`), and Defeated before the deadline once Against reaches half of `totalSupplyAtSnapshot`. Votes cast after that revert. With liquid delegation a few delegates can settle a proposal in one block, leaving only the Timelock delay.
6. **Queue.** Anyone calls `queue(targets, values, calldatas, keccak256(bytes(description)))`.
7. **Execute.** After the Timelock's `minDelay`, anyone calls `execute(...)` with the same arguments.

### Options mode (single-choice elections)

A proposal whose only target is an approved option source (`IOptionSource`, for example an Autonet AnchorElection) is an election among options the source registers while the proposal is Pending. `castVote(id, i)` votes for option `i` (at most 256 options), one vote per account; the quorum counts every vote cast; the option with the most votes wins and a tie goes to the lowest `optionHash`. `proposalVotes` reports `(0, leading tally, 0)`, so early success needs one option alone at the super quorum, which no other option can then catch. Views: `optionVotes(id, i)`, `winningOption(id)` (decided once Succeeded, Queued or Executed), `optionSourceOf(id)`. Sources are approved by `setOptionSource(source, allowed)`: governance only, except that the factory that launched the DAO may call it until the Timelock makes the governor its proposer, so a module attached at launch can approve its source.

### Constitutional proposals (supermajority)

Some proposals change what makes the DAO's votes binding, or the charter its Autonet agents are judged by. These are **protected**: they pass only if For holds `supermajorityBps` of the For and Against votes (abstain is left out), `For * 10000 >= supermajorityBps * (For + Against)` with at least one For vote, and the quorum is met as usual. Each DAO sets `supermajorityBps` at creation (`CoreParams.supermajorityBps`, 5001 to 10000, 0 for the default 6667); only a protected proposal can change it (`setSupermajority`, governance only).

Protection is decided once, in `propose`, from the proposal's targets and calldata, and fixed for that proposal (a later change of the threshold doesn't affect it). `proposalSupermajority(id)` returns its threshold in basis points, 0 for an ordinary proposal, and `propose` emits `ProposalSupermajority(proposalId, bps)` for each protected one. A proposal is protected if **any** of its actions:

| Action | Why |
|---|---|
| `editRegistry` or `batchEditRegistry` writing `jurisdiction.autonet.charter` or `jurisdiction.autonet.epoch_rules`, on any target | The charter and epoch rules are the Autonet constitution. Module attach and detach proposals write these keys in their own `batchEditRegistry` action (`ModuleProcessor`), so attaching an Autonet with a charter, or detaching one, is protected too. Only the DAO's own Registry obeys its timelock, so matching any target costs nothing and needs no address |
| Any call to the DAO's Timelock | Its roles (`grantRole` would let a contract schedule calls without a vote), delay and admin are what make votes binding |
| `relay`, `updateTimelock`, `setSupermajority`, `setVotingPeriod` or `updateQuorumNumerator` on the governor | `relay` makes the governor, the Timelock's proposer, call anything; the others change the timelock, the threshold, or the voting period and quorum protected votes are decided under |
| `setAdmin` on the governance token | Handing the token over hands over minting |

**Early decision** respects the threshold. A protected proposal passes before the deadline only once `For * 10000 >= supermajorityBps * totalSupplyAtSnapshot`, so that even if every remaining vote went Against it would still pass, and is defeated early once `(totalSupplyAtSnapshot - Against) * 10000 < supermajorityBps * totalSupplyAtSnapshot`, when For can no longer reach it.

**Options mode never applies to a protected proposal**, even if its target is an approved option source: it is counted For/Against/Abstain under the supermajority.

### Timelock roles

`JurisdictionFactory` deploys the Timelock with empty proposer and executor lists and itself as temporary admin, then `finalize` sets:

| Role | Holder after deployment |
|---|---|
| `PROPOSER_ROLE` | The Governor only |
| `EXECUTOR_ROLE` | `address(0)`, i.e. anyone |
| `CANCELLER_ROLE` | The governor (standard OZ wiring). The public `cancel` only works while a proposal is Pending, so no one can stop a queued operation; the timelock administers itself, so the DAO can grant this role to a guardian by proposal |
| `DEFAULT_ADMIN_ROLE` | The Timelock itself (OZ default); the factory's grant is revoked |

Consequences: role changes are possible, but only through a proposal executed by the Timelock. A queued operation cannot be cancelled by anyone, and the Governor's own `cancel` only works while a proposal is `Pending`.

### Parameters

`JurisdictionFactory.CoreParams` carries `votingDelay` and `votingPeriod` in **minutes** (the Governor converts), `proposalThreshold`, `quorumFraction` (percent of supply), `executionDelay`, the Timelock delay, in **seconds**, and `supermajorityBps` for constitutional proposals (0 for 6667).

## RepToken

`RepToken is ERC20, ERC20Permit, ERC20Votes, IAdminToken, IJurisdictionData`, 18 decimals, timestamp clock.

### Authority

Two addresses matter, and they are set differently:

- `admin`: starts as the deployer (`RepTokenFactory`), handed to `JurisdictionFactory`, then to the Timelock in `finalize`. Module grants (`setMinter`, `setSlasher`) at origination run while the factory is still admin. `setAdmin` is admin-only and rejects `address(0)`.
- `timelockAddress`: **immutable**, set in the constructor. Reward epoch functions (`startNewRewardEpoch`, `setDelegateShareBps`) check this address, not `admin`.

| Function | Caller |
|---|---|
| `mint(to, amount)` | `admin` or an address in `minters` |
| `mintDelegated(to, amount)` | Same, and `to` votes for itself unless it already chose a delegate (used by `AutonetRepClaim`) |
| `burn(from, amount)` | `admin` only |
| `slash(from, amount)` / `reassign(to, amount)` | An address in `slashers`; `reassign` mints only out of what that slasher burned |
| `setMinter`, `setSlasher`, `setDefaultDelegate`, `setAutoDelegateExempt` | `admin` or `timelockAddress` |
| `startNewRewardEpoch`, `setDelegateShareBps` | `timelockAddress` only |
| `setAdmin` | `admin` only |

### Transferability

`isTransferable` is immutable. When false, `transfer` and `transferFrom` revert; minting and burning still work. `JurisdictionFactory` deploys a non-transferable (soulbound) RepToken for `TokenKind.Soulbound` and a transferable one for `TokenKind.Transferable`.

### Minters

`minters[account]` lets a contract mint without being admin. It exists for modules and satellites such as `EconomyRepClaim` (mints REP for Economy earnings and spendings), `AutonetRepClaim` (mints REP against Autonet earnings) and `CoinOffering` (mints to buyers up to its cap). Granting it is a governance action (a module attach proposal or a direct `setMinter`), except for modules attached at origination, whose grants the factory makes before handing the token to the Timelock. See [autonet.md](autonet.md).

### Slashers

`slashers[account]` lets a contract penalize REP without being admin (used by `ToolBond`). `slash(from, amount)` burns up to the holder's balance and adds what it burned to `slashedCredit[slasher]`; `reassign(to, amount)` mints out of that credit only, and `to` votes for itself unless it already chose a delegate. So a slasher moves existing REP and can never create it. `getPastBalance(account, timepoint)` exposes the balance snapshots verdicts weigh flags by. Granting it is a governance action, and a powerful one: a slasher can cut any holder's voting power.

### Default delegate

If `defaultDelegate != address(0)`, any account that receives tokens (mint or transfer) while it has no delegate is auto-delegated to `defaultDelegate` and `AutoDelegated` is emitted. It never fires for the default delegate itself, for accounts in `autoDelegateExempt` (inventory-holding contracts, so unsold float does not vote), or for accounts that already chose a delegate. A holder can always re-delegate; their choice is never overwritten. Disabled by default.

### Reputation from the Economy

RepToken knows nothing about any Economy. In a DAO with the `economy` [module](modules.md), `EconomyRepClaim.claim()` reads the caller's cumulative earnings and spendings per token from `Economy.getUser`, takes the increase since the last claim (watermarks `claimedEarnings` / `claimedSpendings` on the claim contract), and mints through `RepToken.mint` as a minter:

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

`ERC20 + ERC20Permit + ERC20Votes + ERC20Wrapper`, timestamp clock, decimals inherited from the underlying token. Holders call `depositFor` / `withdrawTo` to wrap and unwrap 1:1; wrapped balances are the voting power. `isTransferable` (immutable) blocks `transfer`/`transferFrom` only. `JurisdictionFactory` deploys it non-transferable. It has an `admin` (set to the Timelock) but no mint, burn, epoch, minter, slasher or Registry features. Reward epochs and modules (whose grants need a RepToken) are therefore RepToken-only.

## Registry

One contract per jurisdiction. `owner` is the Timelock after deployment.

### Access

| Modifier / check | Allowed callers | Functions |
|---|---|---|
| `_treasuryOps` | `owner` | `transferETH`, `transferERC20`, `transferERC721`, `setSpendCap`, `setWindowDuration`, `withdrawEarmarkedFunds`, `reclaimEarmarkedFunds` |
| `_regedit` | `owner` or `wrapper` | `editRegistry`, `batchEditRegistry`, `setJurisdictionAddress` |
| owner or `jurisdictionAddress` | | `earmarkFunds` |
| `jurisdictionAddress` only | | `disburseEarmarked` |
| `owner`, once | | `transferOwnership`: the factory's handover to the Timelock at creation; afterwards it always reverts (`ownershipHandedOver`), so no vote can take the Registry out of the DAO |

`wrapper` is fixed at construction: `address(0)` for DAOs from `JurisdictionFactory` (DAOs from the old standard factories have the factory). `jurisdictionAddress` is the governance token.

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
| Grant a slasher | RepToken | `setSlasher(contract, true)` |
| Attach or detach a module | as built | `ModuleProcessor.installCalls(setup, id)` / `uninstallCalls(setup, id)` (see [modules.md](modules.md)) |
| Economy parameter | Economy | `setPlatformFee(bps)` etc. (see [economy.md](economy.md)) |
| Overrule arbitration | Project | `daoOverrule(percent, rulingHash)` (inside the appeal window, or on a silent arbiter) |
| Veto a project | Project | `daoVeto()` |

An appeal is just this proposal: nothing is registered on the project. The appeal window always fits a full proposal lifecycle plus two days; see [economy.md](economy.md).

## Known caveats

- **A simple majority still controls voting power.** Minting, burning, `setMinter` and `setSlasher` are ordinary proposals, so a majority can first mint itself (or burn others) to a supermajority of the supply and then pass a constitutional proposal. Protecting them would make every mint, burn and module attach constitutional; this is left to the DAO's choice of members and minters.

- **Old standard DAOs cannot run reward epochs.** Early builds of the removed `StandardFactory*` contracts passed `address(this)` (the factory) as the RepToken's `timelockAddress`. Because it is immutable, `startNewRewardEpoch` and `setDelegateShareBps` are permanently uncallable on those DAOs. Admin-gated functions still work because `admin` is moved to the real Timelock. `JurisdictionFactory` passes the real Timelock.
- **Reward-epoch events are not indexed.** The indexer does not listen to `NewRewardEpoch` or `RewardClaimed`; apps must read them from chain.

## Further reading

- [architecture.md](architecture.md): contract graph, deployment flow, indexer and apps
- [economy.md](economy.md): projects, arbitration, appeals
- [registry-settings.md](registry-settings.md): registry keys and Economy parameters
- [technical-reference.md](technical-reference.md): full API
- [autonet.md](autonet.md): Autonet satellites (minters, Coin Offering)
- [deployments.md](deployments.md): live addresses
- [OpenZeppelin Governor 5.x](https://docs.openzeppelin.com/contracts/5.x/governance)
