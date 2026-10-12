# Trustless Economy

This document explains the Trustless Economy system—a marketplace for work where agreements self-enforce through smart contracts, with multi-layered dispute resolution.

## The Problem We Solve

Traditional business arrangements require trust:
- You trust the contractor will deliver
- The contractor trusts you'll pay
- Both trust the legal system to resolve disputes

This trust requirement creates friction:
- **Geographic barriers**: Contracts across jurisdictions are risky
- **Cost barriers**: Legal enforcement is expensive
- **Access barriers**: Many workers lack enforceable legal identities
- **Speed barriers**: Court cases take months or years

The Trustless Economy removes these barriers by encoding trust into smart contracts.

## How It Works (Non-Technical)

### The Basic Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         PROJECT LIFECYCLE                                 │
│                                                                           │
│  1. CREATION                                                              │
│     ┌─────────┐                                                           │
│     │ Author  │ creates project with terms and initial funding            │
│     └────┬────┘                                                           │
│          │                                                                │
│          ▼                                                                │
│  2. SETUP                                                                 │
│     Author selects contractor and arbiter                                 │
│     Backers contribute funds (optionally specifying immediate release)    │
│          │                                                                │
│          ▼                                                                │
│  3. SIGNING                                                               │
│     Contractor reviews terms and signs, staking arbitration fee           │
│     Immediate release funds (if any) sent to contractor                   │
│          │                                                                │
│          ▼                                                                │
│  4. WORK                                                                  │
│     Contractor performs work according to terms                           │
│     Backers can vote to release or dispute at any time                    │
│          │                                                                │
│          ├──────── 70%+ vote release ────────► PAYMENT                    │
│          │                                                                │
│          ├──────── 70%+ vote dispute ────────► ARBITRATION                │
│          │                                                                │
│          └──────── contractor reimburses ────► REFUND                     │
│                                                                           │
│  5. RESOLUTION                                                            │
│     Arbiter decides split (or DAO overrides via appeal)                   │
│     Contractor withdraws their share                                      │
│     Backers withdraw their refunds                                        │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### The Players

| Role | Responsibilities | Incentives |
|------|------------------|------------|
| **Author** | Creates project, sets terms, funds initially | Gets 1% of contractor earnings |
| **Contractor** | Performs the work | Gets paid minus fees |
| **Arbiter** | Resolves disputes fairly | Gets arbitration fee if they rule |
| **Backers** | Fund the project | Get their share back if work fails |
| **DAO** | Ultimate authority | Platform fee + bad actor removal |

### Money Flow Example

Let's trace $10,000 through a successful project:

```
Project Value: $10,000

At Signing:
├── Immediate release (20%): $2,000 → Contractor (no fees)
└── Escrowed (80%): $8,000 → Held in contract

Contractor stakes: $400 (half of 10% arbitration fee on locked amount)

If 70%+ backers vote to release:
├── Platform fee (1% of $8,000): $80 → DAO Treasury
├── Author fee (1% of $7,920): $79.20 → Author
└── Contractor payment: $7,840.80 → Contractor
    Plus the $2,000 immediate release = $9,840.80 total

Plus contractor gets back their $400 stake (no dispute occurred)

Final distribution:
├── Contractor: $10,240.80 (includes stake return)
├── Author: $79.20
├── DAO: $80
└── Backers: $0 (they chose to release)
```

## Project Lifecycle (Technical)

### Stage Transitions

```
┌────────────────────────────────────────────────────────────────────────┐
│                           PROJECT STAGES                                │
│                                                                         │
│   ┌────────┐    setParties()    ┌─────────┐    signContract()           │
│   │  OPEN  │───────────────────►│ PENDING │─────────────────►           │
│   └───┬────┘                    └────┬────┘                             │
│       │                              │                                   │
│       │ (no parties set yet)         │ (cooling-off period)              │
│       │                              │                                   │
│       ▼                              ▼                                   │
│   withdrawAsContributor()        withdrawAsContributor()                 │
│   (full refund)                  (full refund)                           │
│                                                                         │
│                                      │                                   │
│                                      ▼                                   │
│                               ┌──────────┐                               │
│                               │ ONGOING  │                               │
│                               └────┬─────┘                               │
│                                    │                                     │
│         ┌────────────────┬─────────┼─────────┬────────────────┐          │
│         │                │         │         │                │          │
│         ▼                ▼         ▼         ▼                ▼          │
│   voteToRelease   voteToDispute   │   disputeAs      reimburse()         │
│   (70%+ quorum)   (70%+ quorum)   │   Contractor                         │
│         │                │         │                │                    │
│         ▼                ▼         │                ▼                    │
│    ┌─────────┐     ┌─────────┐    │          ┌─────────┐                 │
│    │ CLOSED  │     │ DISPUTE │◄───┘          │ CLOSED  │                 │
│    │(release)│     └────┬────┘               │(refund) │                 │
│    └─────────┘          │                    └─────────┘                 │
│                         │                                                │
│                         │ arbitrate()                                    │
│                         ▼                                                │
│                  ┌────────────┐                                          │
│                  │ APPEALABLE │◄──── arbiter rules                       │
│                  └─────┬──────┘                                          │
│                        │                                                 │
│         ┌──────────────┼──────────────┐                                  │
│         │              │              │                                  │
│         ▼              ▼              ▼                                  │
│    appeal()     finalizeArb()   (appeal period                           │
│    (DAO member)  (no appeal)     expires)                                │
│         │              │              │                                  │
│         ▼              │              │                                  │
│    ┌────────┐          │              │                                  │
│    │ APPEAL │          │              │                                  │
│    └───┬────┘          │              │                                  │
│        │               │              │                                  │
│   ┌────┴────┐          │              │                                  │
│   │         │          │              │                                  │
│   ▼         ▼          ▼              ▼                                  │
│ daoOverrule finalizeArb          ┌─────────┐                             │
│ (Timelock)  (appeal expired)     │ CLOSED  │                             │
│   │              │               │(arbiter │                             │
│   │              │               │ ruling) │                             │
│   │              │               └─────────┘                             │
│   └──────────────┴──────────────────────►                                │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Stage: Open

The project exists but parties haven't been assigned.

**State:**
- `contractor = address(0)`
- `arbiter = address(0)`
- Funding can be added

**Available Actions:**
```solidity
// Author sets the parties and terms
function setParties(address _contractor, address _arbiter, string memory _termsHash)

// Anyone can fund
function sendFunds() public payable
function sendFundsWithImmediate(uint immediateBps) public payable

// Contributors can withdraw (full refund)
function withdrawAsContributor()
```

### Stage: Pending

Parties are set, awaiting contractor signature.

**State:**
- `contractor` and `arbiter` are set
- `coolingOffPeriodEnds` is set
- Funding continues

**Cooling-Off Period:**

A configurable delay (default: 2 minutes) before the contractor can sign. This protects backers from:
- Bait-and-switch tactics
- Rush decisions without review

**Available Actions:**
```solidity
// After cooling-off period
function signContract() public payable

// Contributors can still withdraw (full refund)
function withdrawAsContributor()
```

### Stage: Ongoing

Work is in progress.

**At Signing:**
1. Arbitration fee calculated: `(totalLocked * arbitrationFeeBps) / 10000`
2. Contractor stakes half the fee
3. Immediate release funds sent to contractor
4. Stage transitions to Ongoing

**Voting Mechanics:**

Backers vote with their **locked portion** only (immediate givers have less voting power):

```solidity
// Vote to release payment to contractor
function voteToReleasePayment() public {
    uint lockedAmount = contributions[msg.sender].locked;
    require(lockedAmount > 0, "Only contributors with locked funds can vote");

    // Can change vote from dispute to release
    if (contributorsDisputing[msg.sender] > 0) {
        totalVotesForDispute -= contributorsDisputing[msg.sender];
        contributorsDisputing[msg.sender] = 0;
    }

    totalVotesForRelease += lockedAmount;
    contributorsReleasing[msg.sender] = lockedAmount;

    // Check quorum (default 70%)
    if (totalVotesForRelease * 10000 >= totalLocked * backersVoteQuorumBps) {
        stage = Stage.Closed;
        availableToContractor = totalLocked;
        fundsReleased = true;
        disputeResolution = 100;  // 100% to contractor
    }
}

// Vote to escalate to dispute
function voteToDispute() public {
    // Similar logic, but triggers Dispute stage at quorum
}
```

**Other Actions:**
```solidity
// Contractor can initiate dispute
function disputeAsContractor()

// Contractor can voluntarily reimburse
function reimburse()
```

### Stage: Dispute

Awaiting arbitration.

**Available Actions:**
```solidity
// Arbiter issues ruling
function arbitrate(uint256 percent, string memory rulingHash) public {
    require(msg.sender == arbiter);
    require(percent <= 100);  // Percent to contractor

    originalDisputeResolution = percent;
    originalRulingHash = rulingHash;  // IPFS hash of reasoning
    arbiterHasRuled = true;

    stage = Stage.Appealable;
    appealEnds = block.timestamp + economy.appealPeriod();
}

// If arbiter doesn't rule within 150 days
function arbitrationPeriodExpired() public {
    require(block.timestamp >= disputeStarted + ARBITRATION_TIMEOUT);
    stage = Stage.Closed;
    // No arbitration fee paid (arbiter forfeits)
}
```

### Stage: Appealable

Arbiter has ruled, appeal window is open.

**Appeal Requirements:**
1. Caller has sufficient RepToken voting power (`>= projectThreshold`)
2. A valid DAO proposal exists targeting this project
3. Within appeal period

```solidity
function appeal(uint256 proposalId, address[] calldata targets) external {
    require(stage == Stage.Appealable);
    require(block.timestamp <= appealEnds);

    // Verify voting power
    uint256 votingPower = IVotes(repTokenAddress).getVotes(msg.sender);
    require(votingPower >= projectThreshold);

    // Verify proposal targets this project
    require(targets[0] == address(this));

    // Verify proposal is in valid state
    IGovernor.ProposalState propState = IGovernor(daoGovernor).state(proposalId);
    require(propState == Pending || propState == Active ||
            propState == Succeeded || propState == Queued);

    stage = Stage.Appeal;
    appealEnds = block.timestamp + appealPeriod;
}
```

### Stage: Appeal

DAO is reviewing the arbitration.

**Available Actions:**
```solidity
// Timelock executes DAO decision
function daoOverrule(uint256 percent, string memory rulingHash) public {
    require(msg.sender == daoTimelock);
    require(stage == Stage.Appeal);
    require(block.timestamp <= appealEnds);

    _finalizeDispute(percent, rulingHash);  // Use DAO's ruling
}

// If appeal expires without DAO action
function finalizeArbitration() public {
    require(block.timestamp > appealEnds);
    _finalizeDispute(originalDisputeResolution, originalRulingHash);
}
```

### Stage: Closed

Project is complete.

**Withdrawal:**
```solidity
// Contractor claims their share
function withdrawAsContractor() public {
    require(stage == Stage.Closed);
    require(msg.sender == contractor);

    uint256 amountToPay = availableToContractor;
    availableToContractor = 0;

    // Calculate fees
    uint platformFee = (amountToPay * platformFeeBps) / 10000;
    uint remainder = amountToPay - platformFee;
    uint authorFee = (remainder * authorFeeBps) / 10000;
    uint amountToWithdraw = remainder - authorFee;

    // Transfer to all parties
    economy.updateEarnings(contractor, amountToWithdraw, token);
    if (authorFee > 0) {
        economy.updateEarnings(author, authorFee, token);
        token.transfer(author, authorFee);
    }
    token.transfer(contractor, amountToWithdraw);
    token.transfer(registry, platformFee);
}

// Backers claim their refund
function withdrawAsContributor() public {
    require(stage == Stage.Closed);

    uint lockedAmount = contributions[msg.sender].locked;
    uint immediateAmount = contributions[msg.sender].immediate;

    // Clear contribution
    contributions[msg.sender] = Contribution(0, 0, 0);

    // Immediate portion is gone (released at signing)
    // Locked portion returned based on dispute resolution
    if (arbitrationFeePaidOut) {
        uint backersArbShare = arbitrationFee - (arbitrationFee / 2);
        uint pool = totalLocked - backersArbShare;
        exitAmount = ((pool * (100 - disputeResolution)) / 100) * lockedAmount / totalLocked;
    } else {
        exitAmount = (lockedAmount * (100 - disputeResolution)) / 100;
    }

    expenditure = immediateAmount + (lockedAmount - exitAmount);
    economy.updateSpendings(msg.sender, expenditure, token);

    token.transfer(msg.sender, exitAmount);
}
```

## Immediate Release Feature

Backers can choose to release a portion of their contribution immediately upon contract signing.

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      CONTRIBUTION STRUCTURE                              │
│                                                                          │
│  sendFundsWithImmediate(2000)  // 20% = 2000 basis points                │
│  msg.value = 1000 tokens                                                 │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                     Total Contribution: 1000                     │    │
│  │                                                                  │    │
│  │  ┌──────────────────┐     ┌────────────────────────────────┐    │    │
│  │  │  Immediate: 200  │     │       Locked: 800              │    │    │
│  │  │                  │     │                                │    │    │
│  │  │ Released at      │     │ Held in escrow until:          │    │    │
│  │  │ signing          │     │ • Backer vote release          │    │    │
│  │  │ (fee-free)       │     │ • Dispute resolution           │    │    │
│  │  │                  │     │ • Contractor reimburses        │    │    │
│  │  └──────────────────┘     └────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Voting power for this backer: 800 (locked portion only)                 │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Rules

| Rule | Rationale |
|------|-----------|
| Max 20% immediate (configurable) | Limits backer risk |
| Fee-free immediate release | Only escrow release incurs fees |
| Voting power = locked only | More trust given = less control needed |
| Non-recoverable if contractor fails | Backers knowingly accept this risk |

### When to Use Immediate Release

**Good for:**
- Trusted contractors who need operating capital
- Projects where some upfront work is expected
- Backers who want to express high confidence

**Not for:**
- New/unknown contractors
- Projects with milestone-based payment
- Risk-averse backers

## Arbitration System

### The Arbiter's Role

Arbiters are trusted third parties who:
1. Review the terms (`termsHash`)
2. Examine evidence from both sides
3. Issue a percentage ruling

```
Arbiter rules 60%:
├── Contractor gets: 60% of escrowed funds (minus fees)
└── Backers get: 40% of escrowed funds (pro-rata)
```

### Arbitration Fee

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ARBITRATION FEE STRUCTURE                             │
│                                                                          │
│  Total Fee = (totalLocked * arbitrationFeeBps) / 10000                   │
│  Default: 10% of locked value                                            │
│                                                                          │
│  Example: $10,000 project with $8,000 locked                             │
│  Arbitration fee: $800                                                   │
│                                                                          │
│  ┌────────────────────────┐    ┌────────────────────────┐               │
│  │  Contractor stakes     │    │  Backers contribute    │               │
│  │  $400 at signing       │    │  $400 from locked pool │               │
│  └───────────┬────────────┘    └───────────┬────────────┘               │
│              │                              │                            │
│              └──────────────┬───────────────┘                            │
│                             │                                            │
│                             ▼                                            │
│                    ┌────────────────┐                                    │
│                    │  If disputed:  │                                    │
│                    │  $800 → Arbiter│                                    │
│                    └────────────────┘                                    │
│                                                                          │
│  If NO dispute (backer vote or reimburse):                               │
│  • Contractor reclaims $400 stake                                        │
│  • Backers get their $400 back in the pool                               │
│                                                                          │
│  If arbiter FAILS to rule (150-day timeout):                             │
│  • $800 goes to DAO treasury (arbiter forfeits)                          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Appeal Process

Any DAO member with sufficient reputation can appeal an arbitration decision:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       DAO APPEAL PROCESS                                 │
│                                                                          │
│  1. CREATE PROPOSAL                                                      │
│     ┌─────────────────────────────────────────────────────────────┐     │
│     │ dao.propose(                                                 │     │
│     │   [projectAddress],                                          │     │
│     │   [0],                                                       │     │
│     │   [abi.encodeWithSignature(                                  │     │
│     │     "daoOverrule(uint256,string)",                           │     │
│     │     75,  // New percentage                                   │     │
│     │     "QmHash..."  // DAO's reasoning                          │     │
│     │   )],                                                        │     │
│     │   "Appeal: Project X deserves 75%, not 50%"                  │     │
│     │ );                                                           │     │
│     └─────────────────────────────────────────────────────────────┘     │
│                                                                          │
│  2. LINK APPEAL                                                          │
│     ┌─────────────────────────────────────────────────────────────┐     │
│     │ project.appeal(proposalId, [projectAddress]);                │     │
│     └─────────────────────────────────────────────────────────────┘     │
│     → Transitions project to Appeal stage                                │
│     → Extends appeal period for DAO voting                               │
│                                                                          │
│  3. DAO VOTES                                                            │
│     Standard governance process:                                         │
│     • Voting delay                                                       │
│     • Voting period                                                      │
│     • Queue in timelock                                                  │
│                                                                          │
│  4. OUTCOME                                                              │
│     ┌──────────────────────────────────────────────────────────────┐    │
│     │ If DAO approves:                                              │    │
│     │   Timelock executes daoOverrule()                             │    │
│     │   Project uses DAO's ruling instead of arbiter's             │    │
│     │                                                               │    │
│     │ If DAO rejects or doesn't vote:                               │    │
│     │   Appeal period expires                                       │    │
│     │   Anyone calls finalizeArbitration()                          │    │
│     │   Original arbiter ruling stands                              │    │
│     └──────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Economy Contract

The Economy contract is the central marketplace that:
1. Deploys projects using the clone pattern
2. Tracks user profiles (earnings, spendings, roles)
3. Stores DAO-controlled parameters

### Creating Projects

```solidity
// Native currency project
function createProject(
    string memory name,
    address contractor,
    address arbiter,
    string memory termsHash,
    string memory repo,
    string memory description
) public payable {
    require(repToken.balanceOf(msg.sender) >= projectThreshold);

    address clone = Clones.clone(nativeProjectImplementation);
    deployedProjects.push(clone);
    isProjectContract[clone] = true;

    NativeProject(clone).initialize{value: msg.value}(
        address(this), name, msg.sender, contractor, arbiter,
        termsHash, repo, timelockAddress, governorAddress
    );

    emit NewProject(clone, name, contractor, arbiter, termsHash, repo, description, address(0));
}

// ERC20 token project
function createERC20Project(..., address tokenAddress) public {
    // Similar, but with token address
}
```

### User Profile Tracking

```solidity
struct UserProfile {
    address[] earnedTokens;      // Tokens user has earned
    uint[] earnedAmounts;        // Amounts per token
    address[] spentTokens;       // Tokens user has spent
    uint[] spentAmounts;         // Amounts per token
    address[] projectsAsAuthor;  // Projects they created
    address[] projectsAsContractor; // Projects they worked on
    address[] projectsAsArbiter;    // Projects they arbitrated
}

// Updated by project contracts
function updateEarnings(address user, uint amount, address token) external {
    require(isProjectContract[msg.sender]);
    earnings[user][token] += amount;
}

function updateSpendings(address user, uint amount, address token) external {
    require(isProjectContract[msg.sender]);
    spendings[user][token] += amount;
}
```

### DAO-Controlled Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `arbitrationFeeBps` | 1000 (10%) | Fee for dispute resolution |
| `platformFeeBps` | 100 (1%) | Platform fee to DAO treasury |
| `authorFeeBps` | 100 (1%) | Fee to project author |
| `coolingOffPeriod` | 2 minutes | Delay before contractor can sign |
| `backersVoteQuorumBps` | 7000 (70%) | Quorum for backer votes |
| `projectThreshold` | 0 | Min RepTokens to create project |
| `appealPeriod` | 7 days | Window for appeals |
| `maxImmediateBps` | 2000 (20%) | Max immediate release percentage |

All parameters can be changed via DAO governance proposals.

## Reputation Flow

Economic activity generates reputation:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      REPUTATION ACCRUAL                                  │
│                                                                          │
│  Activity                    │  Tracked As        │  Who Gets Rep        │
│  ────────────────────────────┼────────────────────┼─────────────────────│
│  Contractor paid             │  updateEarnings    │  Contractor          │
│  Author fee paid             │  updateEarnings    │  Author              │
│  Arbiter fee paid            │  updateEarnings    │  Arbiter             │
│  Backer funds project        │  updateSpendings   │  Backer              │
│  Backer loses to contractor  │  updateSpendings   │  Backer              │
│                                                                          │
│  Conversion:                                                             │
│  1. User calls repToken.claimReputationFromEconomy()                     │
│  2. RepToken reads Economy.getUser(user)                                 │
│  3. For each unclaimed token amount:                                     │
│     rep = amount * Registry["jurisdiction.parity.<token>"]               │
│  4. Total rep minted to user                                             │
│                                                                          │
│  Example:                                                                │
│  • User earned 1000 USDC                                                 │
│  • Parity for USDC = 1                                                   │
│  • User claims and receives 1000 RepTokens                               │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## DAO Powers Over Economy

The DAO can:

### 1. Adjust Parameters

```solidity
// Proposal to change platform fee
dao.propose(
    [economyAddress],
    [0],
    [abi.encodeWithSignature("setPlatformFee(uint256)", 200)],  // 2%
    "Increase platform fee to 2%"
);
```

### 2. Override Arbitration

```solidity
// Proposal to override arbiter
dao.propose(
    [projectAddress],
    [0],
    [abi.encodeWithSignature("daoOverrule(uint256,string)", 80, "QmHash")],
    "Override: contractor delivered 80% of scope"
);
```

### 3. Veto Projects

```solidity
// Emergency veto of bad project
dao.propose(
    [projectAddress],
    [0],
    [abi.encodeWithSignature("daoVeto()")],
    "Veto: project violates community standards"
);
```

### 4. Withdraw Platform Fees

```solidity
// Move accumulated fees to registry
dao.propose(
    [economyAddress],
    [0],
    [abi.encodeWithSignature("withdrawNative()")],
    "Transfer ETH fees to treasury"
);
```

## Security Features

| Feature | Protection Against |
|---------|-------------------|
| Cooling-off period | Bait-and-switch tactics |
| Arbitration staking | Frivolous disputes |
| 150-day timeout | Arbiter abandonment |
| DAO appeal | Corrupt or mistaken arbitration |
| DAO veto | Malicious projects |
| Non-transferable tokens | Reputation farming |
| Quorum requirements | Minority control |
| Clone pattern | Gas optimization + consistent interface |

## Use Cases

### Freelance Work

1. Client creates project with clear deliverables
2. Contractor signs and begins work
3. Client funds with immediate release for operating costs
4. On delivery, backers vote to release
5. Contractor withdraws payment

### Grant Distribution

1. DAO creates project for public good
2. Grantee (contractor) signs
3. Multiple backers fund the project
4. Milestones verified by community vote
5. Arbiter handles any disputes

### DAO-to-DAO Collaboration

1. DAO A creates project with DAO B as contractor
2. DAO A's treasury funds the escrow
3. DAO B delivers the work
4. Both DAOs' governance processes involved if dispute

## Further Reading

- [Architecture](architecture.md) - System design and contract relationships
- [DAO Governance](dao-governance.md) - Voting and treasury management
- [Technical Reference](technical-reference.md) - Complete API documentation
