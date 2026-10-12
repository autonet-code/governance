# Immediate Release Feature

## Implementation Status: COMPLETE

### Final Design Decisions

| Decision | Value | Rationale |
|----------|-------|-----------|
| **Max Immediate %** | 20% (2000 bps) | Limits risk while enabling operating capital |
| **Fee Application** | Escrow release only | Immediate portion is fee-free; fees only on escrowed funds that flow to contractor |
| **Voting Power** | Locked portion only | More trust given = less control needed |
| **Arbitration Fee Basis** | Total project value | Reflects total value at stake regardless of split |
| **DAO Control** | `maxImmediateBps` adjustable | DAO can tune cap via governance |

### Key Implications

1. **Contractor Advantage**: Higher immediate % = lower effective platform/author fees
2. **Backer Risk**: Immediate portion is non-recoverable if contractor fails to deliver
3. **Clean Math**: No edge cases with negative earnings or uncollectable fees
4. **Incentive Alignment**: Reputation matters more - trusted contractors attract immediate funding

---

## Overview

Allow backers to specify what portion of their contribution should be released to the contractor immediately upon signing, versus held in escrow until project completion.

This enables contractors without capital to access operating funds while working, effectively turning backers into lenders who price their risk through the immediate/locked split.

## Motivation

The current system requires contractors to fund all operating costs out-of-pocket until project completion. This creates a barrier to entry for capable contractors who lack capital, and doesn't reflect how traditional business financing works.

By letting backers choose their risk exposure, the market can price trust:
- High-reputation contractors attract more immediate funding
- New contractors start with mostly-locked contributions
- Backers who offer immediate release are implicitly lending at favorable terms

## Data Structure Changes

### Per-Backer Contribution Tracking

```solidity
// Replace single mapping:
mapping(address => uint) public contributors;

// With structured contribution:
struct Contribution {
    uint total;           // Total amount contributed
    uint immediateBps;    // Basis points released immediately (0-10000)
}
mapping(address => Contribution) public contributions;

// Derived values:
// immediate = (total * immediateBps) / 10000
// locked = total - immediate
```

### Project-Level Tracking

```solidity
uint public totalImmediate;    // Sum of all immediate portions (released at signing)
uint public totalLocked;       // Sum of all locked portions (in escrow)
uint public immediateReleased; // Tracks whether immediate funds have been paid out
```

## Modified Functions

### sendFunds

```solidity
function sendFunds(uint immediateBps) public payable {
    require(stage == Stage.Open || stage == Stage.Pending);
    require(immediateBps <= 10000, "Cannot exceed 100%");

    // Optional: DAO-controlled cap on immediate percentage
    // require(immediateBps <= economy.maxImmediateBps());

    uint immediate = (msg.value * immediateBps) / 10000;
    uint locked = msg.value - immediate;

    if (contributions[msg.sender].total == 0) {
        backers.push(msg.sender);
    }

    contributions[msg.sender].total += msg.value;
    // Note: Need to handle weighted average if backer adds more funds

    totalImmediate += immediate;
    totalLocked += locked;
    projectValue += msg.value;
}
```

### signContract

```solidity
function signContract() public payable {
    // ... existing checks ...

    // Calculate arbitration fee on TOTAL project value
    uint feeBps = IGovernedEconomy(address(economy)).arbitrationFeeBps();
    arbitrationFee = (projectValue * feeBps) / 10000;
    require(msg.value >= arbitrationFee / 2, "Must stake half the arbitration fee");

    // Release immediate funds to contractor (minus platform fee)
    if (totalImmediate > 0) {
        uint platformFeeBps = IGovernedEconomy(address(economy)).platformFeeBps();
        uint platformFee = (totalImmediate * platformFeeBps) / 10000;
        uint toContractor = totalImmediate - platformFee;

        immediateReleased = totalImmediate;

        // Pay platform fee
        if (platformFee > 0) {
            payable(address(economy)).transfer(platformFee);
        }

        // Pay contractor
        if (toContractor > 0) {
            payable(contractor).transfer(toContractor);
            economy.updateEarnings(contractor, toContractor, economy.NATIVE_CURRENCY());
        }
    }

    stage = Stage.Ongoing;
}
```

### Voting Functions

Voting weight should be based on **locked portion only**:

```solidity
function voteToReleasePayment() public {
    require(stage == Stage.Ongoing);

    Contribution memory contrib = contributions[msg.sender];
    uint lockedAmount = contrib.total - ((contrib.total * contrib.immediateBps) / 10000);

    require(lockedAmount > 0, "Only backers with escrowed funds can vote");

    // ... rest of voting logic using lockedAmount as weight ...
}
```

**Rationale**: Backers who gave 100% immediate have already accepted the outcome. They have no funds at risk in escrow, so they shouldn't influence whether remaining escrow is released or disputed.

### Dispute Resolution

The dispute percentage applies to the **original total project value**. Immediate release is an advance against the contractor's eventual entitlement:

```solidity
function _finalizeDispute(uint256 percent, string memory rulingHash) private {
    disputeResolution = percent;
    ruling_hash = rulingHash;
    stage = Stage.Closed;
    arbitrationFeePaidOut = true;

    uint contractorStake = arbitrationFee / 2;
    uint contributorShare = arbitrationFee - contractorStake;
    uint projectValueAfterArbFee = projectValue - contributorShare;

    // Contractor's total entitlement based on original project value
    uint totalEntitlement = (projectValueAfterArbFee * percent) / 100;

    // Subtract what they already received
    if (totalEntitlement > immediateReleased) {
        availableToContractor = totalEntitlement - immediateReleased;
    } else {
        availableToContractor = 0;
        // Contractor received more than entitled - unrecoverable without separate collateral
    }

    // ... arbiter payment logic unchanged ...
}
```

### Contributor Withdrawal

Backers can only withdraw their **locked portion** (pro-rata based on dispute resolution):

```solidity
function withdrawAsContributor() public {
    require(stage == Stage.Open || stage == Stage.Pending || stage == Stage.Closed);

    Contribution memory contrib = contributions[msg.sender];
    require(contrib.total > 0, "No contributions to withdraw");

    uint immediate = (contrib.total * contrib.immediateBps) / 10000;
    uint locked = contrib.total - immediate;

    contributions[msg.sender].total = 0;
    contributions[msg.sender].immediateBps = 0;

    uint256 exitAmount;
    uint256 expenditure;

    if (stage == Stage.Closed) {
        // Immediate portion is gone (already released to contractor)
        // Locked portion returned based on dispute resolution
        if (arbitrationFeePaidOut) {
            uint contributorArbFeeShare = (arbitrationFee / 2 * locked) / totalLocked;
            uint remainingLocked = locked - contributorArbFeeShare;
            exitAmount = (remainingLocked * (100 - disputeResolution)) / 100;
        } else {
            exitAmount = (locked * (100 - disputeResolution)) / 100;
        }
        expenditure = contrib.total - exitAmount; // Total spent = immediate + locked portion to contractor
    } else {
        // Pre-signing withdrawal: get everything back
        exitAmount = contrib.total;
        totalImmediate -= immediate;
        totalLocked -= locked;
        expenditure = 0;
    }

    // ... transfer logic ...
}
```

## DAO-Controlled Parameters

Consider adding to `Economy.sol`:

```solidity
uint public maxImmediateBps;  // Optional cap on immediate release (e.g., 5000 = 50%)

function setMaxImmediateBps(uint newMax) external {
    require(timelockAddress == address(0) || msg.sender == timelockAddress);
    require(newMax <= 10000);
    maxImmediateBps = newMax;
}
```

This allows the DAO to set platform-wide limits if abuse is detected, while defaulting to permissionless (10000 = 100% allowed).

## Security Considerations

### Contractor Disappearance

**Risk**: Contractor receives immediate funds and doesn't deliver.

**Mitigations**:
- Backer choice: they knowingly accepted this risk via their immediate %
- Reputation damage: contractor's earnings are recorded, but future opportunities depend on completion
- DAO oversight: patterns of abandonment can result in rep burning

### Platform Fee Collection

Platform fee on immediate portion **must** be collected at signing, not withdrawal. Otherwise, contractor disappearance means DAO receives nothing.

### Voting Power Gaming

**Risk**: Contractor uses sock puppet to fund with high immediate %, then votes to release.

**Mitigation**: Voting weight = locked portion only. A 100% immediate backer has zero voting power.

### Reputation Farming

**Risk**: Fake projects to inflate reputation.

**Mitigation**: Existing DAO oversight. Platform fees make farming expensive, and DAO can burn farmed rep if work isn't meaningful. This is not a new attack vector—immediate release doesn't change the economics significantly.

### Dispute Math Clarity

The `disputeResolution` percentage always refers to contractor's share of the **original total**. Immediate release is an advance, not a bonus. If arbiter rules 30% to contractor but they already received 40% immediately, they get nothing more from escrow (and technically owe 10%, but this is unenforceable without additional collateral).

## UI/UX Considerations

### For Backers

- Slider or input for "Immediate Release %" when funding
- Clear warning: "This portion cannot be recovered if the contractor doesn't deliver"
- Show contractor's track record prominently

### For Contractors

- Display total immediate vs locked funding
- Show "Available on signing" amount
- Reputation requirements (if any) for high-immediate projects

### For Project Display

- Show funding breakdown: X ETH immediate / Y ETH escrowed
- Voting power displayed as escrowed amount only

## Migration Path

This is a breaking change to the Project contract structure. Options:

1. **New contract versions**: Deploy `NativeProjectV2` and `ERC20ProjectV2` with immediate release support. Existing projects continue on V1.

2. **Factory update**: Update `Economy.setImplementations()` to point to new implementations. New projects get the feature; existing projects unchanged.

Recommend option 2 for simplicity.

## Open Questions

1. **Author fee on immediate**: Should author fee also be collected at signing for the immediate portion? Probably yes, for same reason as platform fee.

2. **Multiple funding rounds**: If a backer adds more funds, how to handle the weighted average of their immediate %? Options:
   - Reject (must withdraw and re-fund to change)
   - Track per-deposit
   - Weighted average

3. **Minimum lock requirement**: Should there be a minimum locked % to create a project at all? E.g., "At least 20% must be escrowed" to ensure some dispute leverage exists.

4. **Reputation threshold for high immediate**: Should contractors need minimum reputation to accept projects with >X% immediate funding? This protects backers from brand-new contractors taking high-immediate and disappearing.
