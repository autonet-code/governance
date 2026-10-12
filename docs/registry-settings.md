# Economy DAO Settings Reference

This document describes all configurable parameters for an Economy DAO, where they are stored, and how they are modified through governance.

---

## Parameters Stored on the Economy Contract

These parameters are stored directly on the Economy contract and are modified by calling setter functions through DAO proposals targeting the Economy contract.

| Parameter | Type | Description | Default | Setter Function |
|-----------|------|-------------|---------|-----------------|
| `platformFeeBps` | uint | Platform fee on project completions (basis points) | 100 (1%) | `setPlatformFee(uint)` |
| `authorFeeBps` | uint | Fee paid to project authors (basis points) | 100 (1%) | `setAuthorFee(uint)` |
| `nativeArbitrationFee` | uint | Arbitration fee for native currency projects (wei) | 0 | `setNativeArbitrationFee(uint)` |
| `coolingOffPeriod` | uint | Time before funds release after completion (seconds) | 120 (2 min) | `setCoolingOffPeriod(uint)` |
| `appealPeriod` | uint | Time to appeal arbiter decisions (seconds) | 604800 (7 days) | `setAppealPeriod(uint)` |
| `projectThreshold` | uint | Min RepToken balance to create projects (wei) | 0 | `setProjectThreshold(uint)` |
| `backersVoteQuorumBps` | uint | Quorum for backer dispute votes (basis points, 50-99%) | 7000 (70%) | `setBackersVoteQuorum(uint)` |

### Example Proposal: Update Platform Fee

```
Title: Update Platform Fee to 2%
Type: Contract Call
Target: Economy Contract (0x...)
Function: setPlatformFee(uint newFeeBps)
Calldata: setPlatformFee(200)
```

---

## Parameters Stored in the DAO Registry

These parameters are stored in the Registry contract as key-value string pairs. The RepToken contract reads these values when calculating reputation from economic activity.

### Token Parity Settings

Used by RepToken to convert token amounts to reputation when users claim reputation from their economic activity.

| Registry Key Format | Value Type | Description |
|---------------------|------------|-------------|
| `jurisdiction.parity.{tokenAddress}` | uint as string (18 decimals) | Reputation multiplier for earnings/spendings in this token |

**Key Format**: `jurisdiction.parity.` + lowercase hex address of the token

**Value Format**: String representation of uint256 with 18 decimal precision
- `"1000000000000000000"` = 1:1 parity (1 token = 1 reputation)
- `"2000000000000000000"` = 2:1 parity (1 token = 2 reputation)
- `"500000000000000000"` = 0.5:1 parity (1 token = 0.5 reputation)

**Special Address for Native Currency**: `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`

### Example Registry Entries

#### Native Currency (XTZ) Parity
```
Key:   jurisdiction.parity.0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
Value: "1000000000000000000"
```
This means: 1 XTZ earned/spent = 1 RepToken

#### USDC Token Parity (example address)
```
Key:   jurisdiction.parity.0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
Value: "1000000000000000000000000000000"
```
This means: 1 USDC (6 decimals) = 1 RepToken (adjusted for decimal difference)

### Benefits Claim Grace Period

Used by the Registry's `reclaimEarmarkedFunds` function to determine when unclaimed epoch rewards can be reclaimed by the DAO.

| Registry Key | Value Type | Description |
|--------------|------------|-------------|
| `benefits.claim.gracePeriod` | uint as string (seconds) | Time after epoch ends before DAO can reclaim unclaimed funds |

```
Key:   benefits.claim.gracePeriod
Value: "2592000"
```
This means: 30 days grace period for members to claim rewards

---

## How to Set Registry Values

Registry entries are modified through DAO proposals that call the Registry contract.

### Single Entry Update

```
Title: Set XTZ Parity to 1:1
Type: Contract Call
Target: Registry Contract (0x...)
Function: editRegistry(string key, string value)
Calldata: editRegistry("jurisdiction.parity.0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "1000000000000000000")
```

### Batch Update (Multiple Entries)

```
Title: Configure Token Parities
Type: Contract Call
Target: Registry Contract (0x...)
Function: batchEditRegistry(string[] keys, string[] values)
Calldata: batchEditRegistry(
  ["jurisdiction.parity.0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "jurisdiction.parity.0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
  ["1000000000000000000", "1000000000000000000000000000000"]
)
```

---

## Summary: Where to Find Each Setting

| Setting | Location | How to Modify |
|---------|----------|---------------|
| Platform fee | Economy contract | Proposal → `economy.setPlatformFee()` |
| Author fee | Economy contract | Proposal → `economy.setAuthorFee()` |
| Native arbitration fee | Economy contract | Proposal → `economy.setNativeArbitrationFee()` |
| Cooling off period | Economy contract | Proposal → `economy.setCoolingOffPeriod()` |
| Appeal period | Economy contract | Proposal → `economy.setAppealPeriod()` |
| Project threshold | Economy contract | Proposal → `economy.setProjectThreshold()` |
| Backers vote quorum | Economy contract | Proposal → `economy.setBackersVoteQuorum()` |
| Token parity (reputation) | Registry contract | Proposal → `registry.editRegistry()` |
| Benefits grace period | Registry contract | Proposal → `registry.editRegistry()` |

---

## Events Emitted on Changes

### Economy Contract Events
- `PlatformFeeSet(uint newFeeBps)`
- `AuthorFeeSet(uint newFeeBps)`
- `NativeArbitrationFeeSet(uint newFee)`
- `CoolingOffPeriodSet(uint newPeriod)`
- `AppealPeriodSet(uint newPeriod)`
- `ProjectThresholdSet(uint newThreshold)`
- `BackersVoteQuorumSet(uint newQuorumBps)`

### Registry Contract Events
- `RegistryUpdated(string key, string value)`
