# DAO Governance

This document explains how governance works in On-Chain Jurisdiction, covering the proposal lifecycle, voting mechanics, treasury management, and reputation system.

## Overview

The governance system enables token holders to collectively make decisions about:

- **Treasury management**: Spending, investing, or distributing funds
- **Parameter changes**: Adjusting fees, thresholds, and time periods
- **Reputation management**: Minting or burning tokens for contributors
- **Economy oversight**: Appealing arbitration decisions, vetoing bad projects
- **Registry configuration**: Setting metadata and system parameters

All governance actions follow the same pattern: **propose → vote → queue → execute**.

## OpenZeppelin Governor Framework

Our DAO contract (`HomebaseDAO`) inherits from [OpenZeppelin's Governor](https://docs.openzeppelin.com/contracts/5.x/governance) framework, combining multiple extensions:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           HomebaseDAO                                    │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                          Governor (Base)                           │ │
│  │  Core proposal/voting lifecycle, state machine, execution          │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                    │                                     │
│       ┌────────────────────────────┼────────────────────────────┐        │
│       │                            │                            │        │
│       ▼                            ▼                            ▼        │
│  ┌─────────────┐           ┌─────────────┐           ┌─────────────────┐│
│  │GovernorSettings│        │GovernorVotes│          │GovernorTimelock  ││
│  │             │           │             │           │Control          ││
│  │votingDelay  │           │Uses IVotes  │           │                 ││
│  │votingPeriod │           │token for    │           │Queues actions   ││
│  │proposalThres│           │voting power │           │in Timelock      ││
│  └─────────────┘           └─────────────┘           └─────────────────┘│
│       │                            │                            │        │
│       │                            │                            │        │
│       ▼                            ▼                            ▼        │
│  ┌──────────────────┐    ┌───────────────────┐    ┌───────────────────┐ │
│  │GovernorCounting  │    │GovernorVotesQuorum│    │                   │ │
│  │Simple            │    │Fraction           │    │                   │ │
│  │                  │    │                   │    │                   │ │
│  │For/Against/      │    │Quorum as % of     │    │                   │ │
│  │Abstain voting    │    │total supply       │    │                   │ │
│  └──────────────────┘    └───────────────────┘    └───────────────────┘ │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Extension Summary

| Extension | Purpose | Configuration |
|-----------|---------|---------------|
| `GovernorSettings` | Configurable voting parameters | Set at deployment |
| `GovernorCountingSimple` | For/Against/Abstain vote counting | Standard 3-way voting |
| `GovernorVotes` | Token-based voting power | Uses RepToken (IVotes) |
| `GovernorVotesQuorumFraction` | Percentage-based quorum | % of total supply |
| `GovernorTimelockControl` | Timelock integration | Execution delay |

## Proposal Lifecycle

### State Diagram

```
                                   ┌─────────────┐
                                   │  Canceled   │
                                   └──────▲──────┘
                                          │ cancel()
                                          │
┌──────────┐    wait     ┌──────────┐    │    ┌───────────┐
│ Pending  │────────────►│  Active  │────┼───►│ Defeated  │
└──────────┘  votingDelay└────┬─────┘    │    └───────────┘
                              │          │         ▲
                              │          │         │ quorum not met
                              │ voting   │         │ OR more against
                              │ period   │         │
                              │          │         │
                              ▼          │    ┌────┴────┐
                         ┌──────────┐   │    │         │
                         │Succeeded │───┘    │ Expired │
                         └────┬─────┘        │         │
                              │              └────▲────┘
                              │ queue()           │
                              ▼                   │ queue timeout
                         ┌──────────┐             │
                         │ Queued   │─────────────┘
                         └────┬─────┘
                              │ execute()
                              │ after timelock delay
                              ▼
                         ┌──────────┐
                         │ Executed │
                         └──────────┘
```

### Step-by-Step Process

#### 1. Delegation (Required First Step)

Before participating in governance, token holders must delegate their voting power. This can be self-delegation or delegation to a representative:

```solidity
// Self-delegate to activate your own voting power
repToken.delegate(myAddress);

// Or delegate to a trusted representative
repToken.delegate(representativeAddress);
```

**Why delegation?** The Governor framework uses checkpointed voting power to prevent flash loan attacks. Delegation triggers the checkpoint creation.

#### 2. Proposal Creation

Any member with tokens >= `proposalThreshold` can create a proposal:

```solidity
// Encode the action(s) to execute
bytes memory calldata = abi.encodeWithSignature(
    "transferETH(address,uint256)",
    recipientAddress,
    1 ether
);

// Create the proposal
uint256 proposalId = dao.propose(
    [registryAddress],    // Target contracts
    [0],                  // ETH values to send
    [calldata],           // Encoded function calls
    "Transfer 1 ETH to contributor for Q4 work"
);
```

A proposal can contain **multiple actions** that execute atomically:

```solidity
// Multiple actions in one proposal
address[] memory targets = new address[](2);
uint256[] memory values = new uint256[](2);
bytes[] memory calldatas = new bytes[](2);

// Action 1: Mint tokens
targets[0] = repTokenAddress;
values[0] = 0;
calldatas[0] = abi.encodeWithSignature("mint(address,uint256)", recipient, 1000e18);

// Action 2: Update registry
targets[1] = registryAddress;
values[1] = 0;
calldatas[1] = abi.encodeWithSignature("editRegistry(string,string)", "contributor.bonus", "approved");

uint256 proposalId = dao.propose(targets, values, calldatas, "Reward contributor");
```

#### 3. Voting Delay

After creation, the proposal enters a waiting period (configurable, e.g., 1 minute to 7 days). This allows:

- Token holders to see the proposal
- Members to delegate if they haven't already
- Discussion and deliberation

#### 4. Voting Period

Once the delay passes, voting opens. Members cast votes:

```solidity
// Vote in favor
dao.castVote(proposalId, 1);  // 0 = Against, 1 = For, 2 = Abstain

// Vote with reason (stored in event)
dao.castVoteWithReason(proposalId, 1, "This contributor delivered excellent work");

// Vote by signature (gasless voting)
dao.castVoteBySig(proposalId, support, voter, signature);
```

**Vote weight** equals the voter's delegated voting power at the **proposal creation block** (snapshot).

#### 5. Proposal Outcome

When voting ends, the proposal state becomes:

- **Succeeded**: More For than Against, and quorum met
- **Defeated**: More Against than For, or quorum not met

Quorum = `(totalSupply * quorumFraction) / 100` at proposal creation time.

#### 6. Queue

Successful proposals must be queued in the Timelock:

```solidity
// Anyone can queue a successful proposal
dao.queue(targets, values, calldatas, descriptionHash);
```

The `descriptionHash` must match: `keccak256(bytes(description))`.

#### 7. Execution Delay

The proposal waits in the Timelock for the configured delay. This security window allows:

- Community review of what will execute
- Members to exit if they disagree with the outcome
- Coordination of response to malicious proposals

#### 8. Execute

After the delay, anyone can execute:

```solidity
// Anyone can execute after the timelock delay
dao.execute(targets, values, calldatas, descriptionHash);
```

The Timelock calls each target with its value and calldata.

## Governance Parameters

### Configuration at Deployment

```solidity
HomebaseDAO(
    _token,           // RepToken address
    _timelock,        // TimelockController address
    name,             // DAO name (e.g., "Acme DAO")
    minsDelay,        // Voting delay in minutes
    minsVoting,       // Voting period in minutes
    pThreshold,       // Proposal threshold (tokens needed to propose)
    qvrm              // Quorum fraction (0-100, as percentage)
)
```

### Recommended Values

| Parameter | Development | Production | Notes |
|-----------|-------------|------------|-------|
| Voting Delay | 1 minute | 1-2 days | Time to review proposal |
| Voting Period | 5 minutes | 3-7 days | Time to cast votes |
| Proposal Threshold | 0 | 1-5% of supply | Prevents spam |
| Quorum Fraction | 4% | 4-20% | Minimum participation |
| Execution Delay | 1 minute | 1-2 days | Security buffer |

## RepToken: Governance Token

RepToken is an ERC20Votes token with special features for On-Chain Jurisdiction.

### Core Properties

```solidity
contract RepToken is ERC20, ERC20Permit, ERC20Votes, IAdminToken, IJurisdictionData {
    bool public immutable isTransferable;      // Can tokens be transferred?
    address public admin;                       // Who can mint/burn?
    address public economyAddress;              // Linked Economy contract
}
```

### Transferability

RepTokens can be configured as:

**Non-Transferable (Default)**
```solidity
// Transfer functions revert
function transfer(address to, uint256 value) public override returns (bool) {
    if (!isTransferable) {
        revert("RepToken: Reputation is non-transferable");
    }
    return super.transfer(to, value);
}
```

Benefits:
- Prevents vote-buying markets
- Reputation must be earned, not purchased
- Encourages long-term participation

**Transferable**

Set `isTransferable = true` at deployment. Use when:
- Token liquidity is desired
- Staking/farming mechanisms planned
- Open governance market preferred

### Reputation from Economic Activity

In Economy DAOs, RepToken links to the Economy contract for reputation accrual:

```
┌────────────────┐     complete work      ┌────────────────┐
│   Contractor   │───────────────────────►│    Project     │
└────────────────┘                        └───────┬────────┘
                                                  │
                                    updateEarnings(user, amount, token)
                                                  │
                                                  ▼
                                          ┌───────────────┐
                                          │    Economy    │
                                          │               │
                                          │ earnings[user]│
                                          │   += amount   │
                                          └───────┬───────┘
                                                  │
                                    claimReputationFromEconomy()
                                                  │
                                                  ▼
                                          ┌───────────────┐
                                          │   RepToken    │
                                          │               │
                                          │ _mint(user,   │
                                          │  reputation)  │
                                          └───────────────┘
```

**Reputation Calculation:**

```solidity
function _calculateReputation(address token, uint amount) internal view returns (uint256) {
    // Lookup parity for this token in Registry
    string memory parityKey = string.concat(
        "jurisdiction.parity.",
        Strings.toHexString(uint160(token))
    );
    string memory parityStr = Registry(registryAddress).getRegistryValue(parityKey);

    if (bytes(parityStr).length > 0) {
        uint256 parity = Strings.parseUint(parityStr);
        if (parity > 0) {
            return amount * parity;  // Simple multiplier
        }
    }
    return 0;  // No parity set = no reputation
}
```

**Example:**
- User earns 100 USDC from a project
- Registry has `jurisdiction.parity.0x123...` = "1" (1 rep per USDC)
- User claims and receives 100 RepTokens

### Admin Functions

The admin (typically Timelock after deployment) can:

```solidity
// Mint tokens to a member
function mint(address to, uint256 amount) public {
    require(msg.sender == admin, "RepToken: Only admin can mint");
    _mint(to, amount);
}

// Burn tokens from a member (e.g., for misconduct)
function burn(address from, uint256 amount) public {
    require(msg.sender == admin, "RepToken: Only admin can burn");
    _burn(from, amount);
}

// Transfer admin role (one-time during setup)
function setAdmin(address newAdmin) public override {
    require(msg.sender == admin, "RepToken: Caller is not the admin");
    admin = newAdmin;
}
```

### Incentive Epochs

RepToken supports two incentive mechanisms:

#### Passive Income Epochs

Reward all token holders proportionally:

```solidity
// DAO proposal to start epoch (must earmark funds in Registry first)
repToken.startNewPassiveIncomeEpoch(budget, paymentToken);

// Members claim their share
repToken.claimPassiveIncome(epochId);
```

Share calculation: `(userBalance / totalSupply) * epochBudget`

#### Delegate Reward Epochs

Reward members who represent others:

```solidity
// Start epoch for delegates
repToken.startNewDelegateRewardEpoch(budget, paymentToken);

// Delegates claim their reward
repToken.claimRepresentationReward(epochId);
```

Share calculation: `(delegatedVotes / totalSupply) * epochBudget`

Where `delegatedVotes = totalVotingPower - ownBalance` (votes delegated TO them by others).

## Registry: Treasury & Configuration

The Registry contract serves two purposes:

### 1. Treasury Management

Holds and manages DAO assets:

```solidity
// Receive ETH
receive() external payable;

// Receive NFTs
function onERC721Received(...) external returns (bytes4);

// Transfer operations (Timelock only)
function transferETH(address payable to, uint256 amount) external;
function transferERC20(address token, address to, uint256 amount) external;
function transferERC721(address token, address to, uint256 tokenId) external;
```

All transfer functions are protected by `_treasuryOps` modifier (Timelock only).

### 2. Configuration Store

Key-value store for DAO settings:

```solidity
// Set a single value
function editRegistry(string memory key, string memory value) public;

// Set multiple values
function batchEditRegistry(string[] memory keys, string[] memory values) public;

// Read a value
function getRegistryValue(string memory key) public view returns (string memory);

// Enumerate all
function getAllKeys() public view returns (string[] memory);
function getAllValues() public view returns (string[] memory);
```

Registry edits can be made by Timelock or the designated wrapper address.

### 3. Earmarking System

Reserve funds for specific purposes:

```solidity
// Reserve funds for a purpose
function earmarkFunds(bytes32 purpose, uint256 amount, address tokenAddress) external;

// Release reservation (funds still in treasury)
function withdrawEarmarkedFunds(bytes32 purpose, uint256 amount) external;

// Disburse to recipient (called by RepToken for epoch claims)
function disburseEarmarked(
    address recipient,
    uint256 amount,
    bytes32 purpose,
    address tokenAddress
) external;

// Reclaim unclaimed epoch funds after grace period
function reclaimEarmarkedFunds(
    uint256 epochId,
    address paymentToken,
    bool isDelegateReward
) external;
```

### Common Registry Keys

| Key | Purpose | Example Value |
|-----|---------|---------------|
| `jurisdiction.parity.<tokenAddr>` | Reputation per token earned | "1" |
| `benefits.claim.gracePeriod` | Seconds before unclaimed epochs can be reclaimed | "2592000" (30 days) |
| `dao.name` | Human-readable DAO name | "Acme DAO" |
| `dao.website` | DAO website URL | "https://acme.dao" |
| `dao.description` | DAO description | "Building the future" |

## TimelockController

OpenZeppelin's standard timelock that enforces execution delays.

### Role Configuration

After deployment, roles are configured as:

| Role | Granted To | Purpose |
|------|------------|---------|
| `PROPOSER_ROLE` | HomebaseDAO | Only DAO can propose to Timelock |
| `EXECUTOR_ROLE` | address(0) | Anyone can execute after delay |
| `ADMIN_ROLE` | Revoked | No one can change roles |

### Security Properties

1. **Execution delay**: Actions wait before executing
2. **Immutable roles**: Admin role is revoked after setup
3. **Transparent queue**: All pending actions visible on-chain

## Voting Power Mechanics

### Snapshot System

Voting power is determined by token balance at proposal creation:

```
Block 100: User has 100 tokens
Block 101: Proposal created (snapshot at block 100)
Block 102: User sells all tokens
Block 103: Voting opens

→ User can still vote with 100 tokens (snapshot power)
→ New owner cannot vote (didn't hold at snapshot)
```

This prevents:
- Flash loan attacks
- Last-minute vote manipulation
- Token movement during voting

### Delegation Mechanics

```
┌─────────────────────────────────────────────────────────────────────┐
│                      DELEGATION SCENARIOS                            │
│                                                                      │
│  Scenario 1: Self-Delegation                                         │
│  ┌──────────┐                                                        │
│  │  Alice   │ delegate(alice)                                        │
│  │ 100 REP  │────────────────────► Alice has 100 voting power        │
│  └──────────┘                                                        │
│                                                                      │
│  Scenario 2: Delegate to Representative                              │
│  ┌──────────┐                      ┌──────────┐                      │
│  │  Alice   │ delegate(bob)        │   Bob    │                      │
│  │ 100 REP  │─────────────────────►│  50 REP  │                      │
│  └──────────┘                      └──────────┘                      │
│                                          │                           │
│                          Bob has 150 voting power (50 own + 100 del) │
│                          Alice has 0 voting power                    │
│                                                                      │
│  Scenario 3: Chain Delegation (NOT allowed)                          │
│  Alice → Bob → Carol                                                 │
│  ❌ Bob cannot re-delegate Alice's power to Carol                    │
│  Only direct delegation is supported                                 │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Common Governance Operations

### Treasury Transfer

```solidity
// Proposal to send ETH
address[] memory targets = new address[](1);
targets[0] = registryAddress;

uint256[] memory values = new uint256[](1);
values[0] = 0;

bytes[] memory calldatas = new bytes[](1);
calldatas[0] = abi.encodeWithSignature(
    "transferETH(address,uint256)",
    recipientAddress,
    1 ether
);

dao.propose(targets, values, calldatas, "Pay contractor for website redesign");
```

### Token Minting

```solidity
bytes memory calldata = abi.encodeWithSignature(
    "mint(address,uint256)",
    contributorAddress,
    1000 * 10**18  // 1000 tokens
);

dao.propose(
    [repTokenAddress],
    [0],
    [calldata],
    "Mint 1000 REP to contributor for exceptional Q4 contributions"
);
```

### Parameter Update

```solidity
bytes memory calldata = abi.encodeWithSignature(
    "editRegistry(string,string)",
    "jurisdiction.parity.0x123...",
    "2"  // Double the reputation per token
);

dao.propose(
    [registryAddress],
    [0],
    [calldata],
    "Increase USDC parity to 2x"
);
```

### Appeal Arbitration (Economy DAOs)

```solidity
// Step 1: Create proposal to override arbitration
bytes memory calldata = abi.encodeWithSignature(
    "daoOverrule(uint256,string)",
    75,  // 75% to contractor (overriding arbiter's 50%)
    "QmHash..."  // IPFS hash of DAO's reasoning
);

uint256 proposalId = dao.propose(
    [projectAddress],
    [0],
    [calldata],
    "Override arbitration in Project X - contractor delivered more than arbiter credited"
);

// Step 2: In the project, link the appeal
project.appeal(proposalId, [projectAddress]);
```

## Security Best Practices

### For DAO Operators

1. **Set appropriate thresholds**: Too low invites spam; too high excludes participation
2. **Use meaningful delays**: Short delays for testing, longer (days) for production
3. **Review proposals carefully**: All actions are irreversible once executed
4. **Maintain quorum balance**: Too high causes gridlock; too low enables attacks

### For Token Holders

1. **Always delegate**: Undelegated tokens have no voting power
2. **Review before voting**: Read the proposal description and calldata
3. **Use timelock window**: Exit before malicious proposals execute
4. **Participate regularly**: Inactive accounts lose influence to active ones

### For Developers

1. **Verify calldata**: Double-check encoded function calls
2. **Test on devnet**: Run full proposal cycle before mainnet
3. **Monitor events**: Track ProposalCreated, VoteCast, etc.
4. **Handle failures**: Proposals can be defeated or expired

## Further Reading

- [Architecture](architecture.md) - System overview and contract relationships
- [Trustless Economy](economy.md) - Marketplace and dispute resolution
- [Technical Reference](technical-reference.md) - Complete API documentation
- [OpenZeppelin Governor Guide](https://docs.openzeppelin.com/contracts/5.x/governance)
- [ERC20Votes Standard](https://eips.ethereum.org/EIPS/eip-5805)
