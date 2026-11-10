# Economy Settings

Every configurable value of a DAO with the `economy` [module](modules.md), where it lives, and how to change it. Values live in two places: typed parameters on the Economy contract, and string key/value pairs in the Registry. After deployment both are changed only by DAO proposals executed by the Timelock (see [governance.md](governance.md)).

Related: [economy.md](economy.md) (what the parameters do in the project lifecycle), [immediate-release.md](immediate-release.md), [technical-reference.md](technical-reference.md), [architecture.md](architecture.md).

## Economy contract parameters

Setters are `onlyGovernance`: the Economy's `admin` until `setDaoAddresses` runs, the Timelock after. `EconomySetup.prepareInstallation` sets the initial values (except `maxImmediateBps`) from `EconomySetup.Params`, then sets the DAO addresses, in the same transaction.

| Parameter | Unit | Default | Bounds | Setter | Read by projects |
|-----------|------|---------|--------|--------|------------------|
| `platformFeeBps` | bps | 100 (1%) | 100 (`MIN_PLATFORM_FEE_BPS`) to 5000 | `setPlatformFee(uint)` | On every fee-path payout |
| `authorFeeBps` | bps of payout after platform fee | 100 (1%) | at most 2500 (`MAX_AUTHOR_FEE_BPS`) | `setAuthorFee(uint)` | On every contractor payout |
| `arbitrationFeeBps` | bps of `totalLocked` | `EconomySetup.Params.arbitrationFeeBps` | at most 2500 (`MAX_ARBITRATION_FEE_BPS`) | `setArbitrationFee(uint)` | Once, at signing |
| `coolingOffPeriod` | seconds | 86400 (1 day) | at least `minCoolingOffPeriod` | `setCoolingOffPeriod(uint)` | Once, when parties are set |
| `backersVoteQuorumBps` | bps of `totalLocked` | 7000 (70%) | 5000 to 9900 | `setBackersVoteQuorum(uint)` | On each backer vote |
| `projectThreshold` | REP (18 decimals) | 0 | none | `setProjectThreshold(uint)` | REP balance to create a project |
| `appealPeriod` | seconds | 604800 (7 days) | none | `setAppealPeriod(uint)` | At ruling, as set; also the arbiter's exclusive window. Projects only; ContentCourt has its own `appealPeriod` |
| `arbitrationTimeout` | seconds | 2592000 (30 days) | none | `setArbitrationTimeout(uint)` | When a dispute starts, as `arbitrationDeadline`; after it anyone can close an unruled dispute with a full refund |
| `maxImmediateBps` | bps per contribution | 2000 (20%) | 0 to 5000 | `setMaxImmediateBps(uint)` | On each contribution |
| implementations | addresses | unset | none | `setImplementations(native, erc20)` | New projects only |

`minCoolingOffPeriod` is not governed: `EconomySetup` sets it from its immutable before the hand-over (`setMinCoolingOffPeriod`, admin only), 1 day by default and 60 seconds on chain 31337. Projects don't floor cooling-off or the appeal window at a proposal lifecycle; a DAO proposal registered inside them holds them instead ([economy.md](economy.md#dao-proposal-holds)).

`proposalLifecycle()` is `governor.votingDelay() + governor.votingPeriod() + timelock.getMinDelay()`, in seconds (the Governor clock is timestamp based).

`EconomySetup` passes `arbitrationFeeBps` to the Economy constructor. `coolingOffPeriod` and `appealPeriod` in `Params` are seconds; `coolingOffPeriod` must be at least the setup's `minCoolingOffPeriod`. The setup also sets the implementations it holds; `maxImmediateBps` keeps the constructor default until a proposal changes it.

### Example proposal

```
Target:   Economy (0x...)
Value:    0
Calldata: setPlatformFee(200)        // 2%
```

A value outside the bounds makes the proposal revert at execution.

## Registry keys

The Registry stores string keys and string values. Edits are allowed from the `owner` (the Timelock after deployment) or the `wrapper` (none for DAOs from `JurisdictionFactory`). Initial keys can be passed to `JurisdictionFactory.deploy` or `finalize` as `keys` / `values`.

### Module entries

Attaching a module records its entries; detaching clears them. See [modules.md](modules.md).

| Key | Value |
|-----|-------|
| `modules.<name>` | `"<setup>:<id>"` for each attached module (`economy`, `content_court`, `autonet`) |
| `jurisdiction.economy` | The Economy. Its presence marks an economy DAO |
| `jurisdiction.economy.rep_claim` | The Economy's `EconomyRepClaim` |
| `jurisdiction.content_court.court` | The ContentCourt ([content-court.md](content-court.md)) |
| `jurisdiction.autonet.*` | The Autonet layer ([autonet.md](autonet.md#genesis-autonetsetup)) |

### `jurisdiction.parity.<token>`

REP minted per unit of a payment token. Read by `EconomyRepClaim.claim()` (and by the AutonetVault, which uses the same convention).

| | |
|---|---|
| Key | `jurisdiction.parity.` + lowercase `0x` hex address (`Strings.toHexString`) |
| Native currency | `jurisdiction.parity.0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` |
| Value | decimal string, 18-decimal fixed point: `reputation = amount * parity / 1e18` |
| Missing or `0` | No REP for that token |

The decimal adjustment is baked into the value:

| Token | Desired rate | Value |
|-------|--------------|-------|
| Native (18 decimals) | 1 token = 1 REP | `1000000000000000000` |
| Native | 1 token = 0.5 REP | `500000000000000000` |
| 6-decimal stablecoin | 1 token = 1 REP | `1000000000000000000000000000000` (1e30) |

Parity is applied when the user claims, to the unclaimed delta of their earnings and spending in that token, so a parity change affects only amounts not yet claimed.

### `jurisdiction.economy.rep_rate_bps`

One rate on all the REP `EconomyRepClaim` mints: `reputation = amount * parity / 1e18 * rate / 10000`, summed across tokens first. The parity keeps its meaning, so the AutonetVault is unaffected, and AutonetRepClaim does not read this key.

| | |
|---|---|
| Value | decimal string, basis points |
| Missing | `10000`, the full amount |
| `0` | No REP from the economy |

It applies when the user claims, like the parity, so a change also reaches REP earned but not yet claimed. Editing it is a constitutional proposal (see [governance.md](governance.md)).

`EconomyRepClaim` mints with plain `mint`, so a member's economy REP votes only once they delegate (Claim Voting Power). `AutonetRepClaim` uses `mintDelegated` because agents need their own weight to sign anchors.

### `benefits.claim.gracePeriod`

Seconds after the next reward epoch starts before `Registry.reclaimEarmarkedFunds(epochId, token)` can release an epoch's unclaimed budget. Required: reclaim reverts while it is unset. Example `2592000` (30 days).

### Treasury inflows from the economy

Not settings, but the Registry is where economy money lands: platform fees and forfeited arbitration fees are sent directly from projects; `Economy.withdrawNative()` / `withdrawTokens(token)` (Timelock only) sweep anything sent to the Economy itself; `ERC20Project.sweepOrphanedTokens(token)` sends stray tokens. Outflows are subject to the Registry's spend caps and earmarks (see [governance.md](governance.md)).

### Example proposals

```
Target:   Registry (0x...)
Calldata: editRegistry("jurisdiction.parity.0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "1000000000000000000")
```

```
Target:   Registry (0x...)
Calldata: batchEditRegistry(
  ["jurisdiction.parity.0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "benefits.claim.gracePeriod"],
  ["1000000000000000000", "2592000"])
```

## Events

| Contract | Event |
|----------|-------|
| Economy | `PlatformFeeSet`, `AuthorFeeSet`, `ArbitrationFeeSet`, `MinCoolingOffPeriodSet`, `CoolingOffPeriodSet`, `BackersVoteQuorumSet`, `ProjectThresholdSet`, `AppealPeriodSet`, `MaxImmediateBpsSet`, `DaoAddressesSet`, `AdminTransferred` |
| Registry | `RegistryUpdated(key, value)` from `editRegistry` and once per key from `batchEditRegistry` |
