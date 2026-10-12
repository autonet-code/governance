# Economy DAO Settings

Every configurable value of an economy DAO, where it lives, and how to change it. Values live in two places: typed parameters on the Economy contract, and string key/value pairs in the Registry. After deployment both are changed only by DAO proposals executed by the Timelock (see [governance.md](governance.md)).

Related: [economy.md](economy.md) (what the parameters do in the project lifecycle), [immediate-release.md](immediate-release.md), [technical-reference.md](technical-reference.md), [architecture.md](architecture.md).

## Economy contract parameters

Setters are `onlyGovernance`: the Economy's `admin` until `setDaoAddresses` runs, the Timelock after. The TrustlessFactory sets the initial values (except `maxImmediateBps`) inside `configureAndFinalize`, then sets the DAO addresses.

| Parameter | Unit | Default | Bounds | Setter | Read by projects |
|-----------|------|---------|--------|--------|------------------|
| `platformFeeBps` | bps | 100 (1%) | 100 (`MIN_PLATFORM_FEE_BPS`) to 5000 | `setPlatformFee(uint)` | On every fee-path payout |
| `authorFeeBps` | bps of payout after platform fee | 100 (1%) | at most 2500 (`MAX_AUTHOR_FEE_BPS`) | `setAuthorFee(uint)` | On every contractor payout |
| `arbitrationFeeBps` | bps of `totalLocked` | `EconomyParams.arbitrationFeeBps` in `configureAndFinalize` | at most 2500 (`MAX_ARBITRATION_FEE_BPS`) | `setArbitrationFee(uint)` | Once, at signing |
| `coolingOffPeriod` | seconds | 120 | none; effective value is `max(coolingOffPeriod, proposalLifecycle() + 1 day)` | `setCoolingOffPeriod(uint)` | Once, when parties are set |
| `backersVoteQuorumBps` | bps of `totalLocked` | 7000 (70%) | 5000 to 9900 | `setBackersVoteQuorum(uint)` | On each backer vote |
| `projectThreshold` | REP (18 decimals) | 0 | none | `setProjectThreshold(uint)` | REP balance to create a project |
| `appealPeriod` | seconds | 604800 (7 days) | none | `setAppealPeriod(uint)` | At ruling (floored at `proposalLifecycle() + 2 days`); also the arbiter's exclusive window |
| `maxImmediateBps` | bps per contribution | 2000 (20%) | 0 to 5000 | `setMaxImmediateBps(uint)` | On each contribution |
| implementations | addresses | unset | none | `setImplementations(native, erc20)` | New projects only |

Fixed constants on projects: `ARBITRATION_TIMEOUT = 150 days`.

`proposalLifecycle()` is `governor.votingDelay() + governor.votingPeriod() + timelock.getMinDelay()`; `effectiveCoolingOffPeriod()` exposes the result. Both use seconds (the Governor clock is timestamp based).

`deployInfrastructure` also takes an arbitration fee for the Economy constructor; `configureAndFinalize` then sets `EconomyParams.arbitrationFeeBps`, which is the value that sticks.

### Example proposal

```
Target:   Economy (0x...)
Value:    0
Calldata: setPlatformFee(200)        // 2%
```

A value outside the bounds makes the proposal revert at execution.

## Registry keys

The Registry stores string keys and string values. Edits are allowed from the `owner` (the Timelock after deployment) or the `wrapper`. Initial keys can be passed to `configureAndFinalize` as `_registryKeys` / `_registryValues`.

### `jurisdiction.parity.<token>`

REP minted per unit of a payment token. Read by `RepToken.claimReputationFromEconomy()` (and by the CoinOffering and AutonetVault contracts, which use the same convention).

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
| Economy | `PlatformFeeSet`, `AuthorFeeSet`, `ArbitrationFeeSet`, `CoolingOffPeriodSet`, `BackersVoteQuorumSet`, `ProjectThresholdSet`, `AppealPeriodSet`, `MaxImmediateBpsSet`, `DaoAddressesSet`, `AdminTransferred` |
| Registry | `RegistryUpdated(key, value)` from `editRegistry` only. `batchEditRegistry` emits nothing, so indexers must read batched keys from the transaction or the factory's `NewDaoCreated` event |
