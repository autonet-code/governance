# Technical Reference

Complete API documentation for On-Chain Jurisdiction smart contracts.

## Table of Contents

- [Core Contracts](#core-contracts)
  - [HomebaseDAO](#homebasedao)
  - [RepToken](#reptoken)
  - [Registry](#registry)
  - [Economy](#economy)
  - [NativeProject](#nativeproject)
  - [ERC20Project](#erc20project)
- [Factory Contracts](#factory-contracts)
  - [StandardFactory](#standardfactory)
  - [TrustlessFactory](#trustlessfactory)
- [Events](#events)
- [Deployed Addresses](#deployed-addresses)

---

## Core Contracts

### HomebaseDAO

**File:** `contracts/Dao.sol`

Governor contract implementing the proposal and voting lifecycle. Inherits from OpenZeppelin's Governor framework.

#### Constructor

```solidity
constructor(
    IVotes _token,
    TimelockController _timelock,
    string memory name,
    uint48 minsDelay,
    uint32 minsVoting,
    uint256 pThreshold,
    uint8 qvrm
)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `_token` | `IVotes` | Governance token (RepToken) |
| `_timelock` | `TimelockController` | Timelock for proposal execution |
| `name` | `string` | DAO name |
| `minsDelay` | `uint48` | Voting delay in minutes |
| `minsVoting` | `uint32` | Voting period in minutes |
| `pThreshold` | `uint256` | Tokens required to create proposal |
| `qvrm` | `uint8` | Quorum percentage (0-100) |

#### Key Functions

```solidity
// Create a proposal
function propose(
    address[] memory targets,
    uint256[] memory values,
    bytes[] memory calldatas,
    string memory description
) public returns (uint256 proposalId)

// Cast a vote
function castVote(uint256 proposalId, uint8 support) public returns (uint256)
// support: 0 = Against, 1 = For, 2 = Abstain

// Cast vote with reason
function castVoteWithReason(
    uint256 proposalId,
    uint8 support,
    string calldata reason
) public returns (uint256)

// Queue a successful proposal
function queue(
    address[] memory targets,
    uint256[] memory values,
    bytes[] memory calldatas,
    bytes32 descriptionHash
) public returns (uint256)

// Execute a queued proposal
function execute(
    address[] memory targets,
    uint256[] memory values,
    bytes[] memory calldatas,
    bytes32 descriptionHash
) public payable returns (uint256)

// Get proposal state
function state(uint256 proposalId) public view returns (ProposalState)
// States: Pending, Active, Canceled, Defeated, Succeeded, Queued, Expired, Executed
```

---

### RepToken

**File:** `contracts/RepToken.sol`

ERC20Votes governance token with reputation accrual from Economy activity.

#### Constructor

```solidity
constructor(
    string memory name,
    string memory symbol,
    address payable _registryAddress,
    address _adminAddress,
    address[] memory initialMembers,
    uint256[] memory initialAmounts,
    bool transferrable
)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Token name |
| `symbol` | `string` | Token symbol |
| `_registryAddress` | `address payable` | Registry contract address |
| `_adminAddress` | `address` | Initial admin (typically factory) |
| `initialMembers` | `address[]` | Initial token recipients |
| `initialAmounts` | `uint256[]` | Token amounts for each recipient |
| `transferrable` | `bool` | Whether tokens can be transferred |

#### State Variables

```solidity
bool public immutable isTransferable;    // Transfer restriction flag
address public admin;                     // Admin address (can mint/burn)
address public registryAddress;           // Registry for parity lookup
address public economyAddress;            // Economy for reputation claims
uint256 public currentPassiveIncomeEpochId;
uint256 public currentDelegateRewardEpochId;
```

#### Admin Functions

```solidity
// Mint tokens (admin only)
function mint(address to, uint256 amount) public

// Burn tokens (admin only)
function burn(address from, uint256 amount) public

// Transfer admin role
function setAdmin(address newAdmin) public

// Link Economy contract (one-time)
function setEconomyAddress(address _economyAddress) public
```

#### Epoch Functions

```solidity
// Start a new passive income epoch
function startNewPassiveIncomeEpoch(uint256 budget, address paymentToken) public

// Claim passive income for an epoch
function claimPassiveIncome(uint256 epochId) public

// Start a new delegate reward epoch
function startNewDelegateRewardEpoch(uint256 budget, address paymentToken) public

// Claim delegate rewards for an epoch
function claimRepresentationReward(uint256 epochId) public

// Get epoch info
function getPassiveIncomeEpochStart(uint256 epochId) public view returns (uint48)
function getDelegateRewardEpochStart(uint256 epochId) public view returns (uint48)
```

#### Reputation Functions

```solidity
// Claim reputation from Economy activity
function claimReputationFromEconomy() external
```

#### Voting Functions (inherited from ERC20Votes)

```solidity
// Delegate voting power
function delegate(address delegatee) public

// Get current voting power
function getVotes(address account) public view returns (uint256)

// Get voting power at past timepoint
function getPastVotes(address account, uint256 timepoint) public view returns (uint256)

// Get total voting power at past timepoint
function getPastTotalSupply(uint256 timepoint) public view returns (uint256)
```

---

### Registry

**File:** `contracts/Registry.sol`

Treasury and configuration store for the DAO.

#### Constructor

```solidity
constructor(address initialOwner, address _wrapperAddress)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `initialOwner` | `address` | Initial owner (typically factory) |
| `_wrapperAddress` | `address` | Factory address for registry edits |

#### State Variables

```solidity
address public wrapperAddress;         // Factory address
address public jurisdictionAddress;    // RepToken address
```

#### Treasury Functions

```solidity
// Receive ETH
receive() external payable

// Receive ERC721
function onERC721Received(
    address operator,
    address from,
    uint256 tokenId,
    bytes calldata data
) external returns (bytes4)

// Transfer ETH (owner only)
function transferETH(address payable to, uint256 amount) external

// Transfer ERC20 (owner only)
function transferERC20(address tokenAddress, address to, uint256 amount) external

// Transfer ERC721 (owner only)
function transferERC721(address tokenAddress, address to, uint256 tokenId) external
```

#### Configuration Functions

```solidity
// Set a registry key-value pair
function editRegistry(string memory key, string memory value) public

// Set multiple key-value pairs
function batchEditRegistry(string[] memory keys, string[] memory values) public

// Get a registry value
function getRegistryValue(string memory key) public view returns (string memory)

// Get all keys
function getAllKeys() public view returns (string[] memory)

// Get all values
function getAllValues() public view returns (string[] memory)
```

#### Earmarking Functions

```solidity
// Reserve funds for a purpose
function earmarkFunds(bytes32 purpose, uint256 amount, address tokenAddress) external

// Release reservation (funds stay in treasury)
function withdrawEarmarkedFunds(bytes32 purpose, uint256 amount) external

// Disburse to recipient
function disburseEarmarked(
    address recipient,
    uint256 amount,
    bytes32 purpose,
    address tokenAddress
) external

// Reclaim unclaimed epoch funds
function reclaimEarmarkedFunds(
    uint256 epochId,
    address paymentToken,
    bool isDelegateReward
) external
```

---

### Economy

**File:** `contracts/Economy.sol`

Marketplace contract that deploys and tracks projects.

#### Constructor

```solidity
constructor(uint _arbitrationFeeBps)
```

#### State Variables

```solidity
// DAO links
address public timelockAddress;
address public registryAddress;
address public governorAddress;
address public repTokenAddress;

// Project implementations (for cloning)
address public nativeProjectImplementation;
address public erc20ProjectImplementation;

// DAO-controlled parameters
uint public arbitrationFeeBps;        // Default: 1000 (10%)
uint public platformFeeBps;           // Default: 100 (1%)
uint public authorFeeBps;             // Default: 100 (1%)
uint public coolingOffPeriod;         // Default: 120 seconds
uint public backersVoteQuorumBps;     // Default: 7000 (70%)
uint public projectThreshold;         // Default: 0
uint public appealPeriod;             // Default: 604800 (7 days)
uint public maxImmediateBps;          // Default: 2000 (20%)

// Tracking
address[] public deployedProjects;
mapping(address => bool) public isProjectContract;
mapping(address => mapping(address => uint)) public earnings;
mapping(address => mapping(address => uint)) public spendings;
```

#### Project Creation Functions

```solidity
// Create native currency project
function createProject(
    string memory name,
    address contractor,
    address arbiter,
    string memory termsHash,
    string memory repo,
    string memory description
) public payable returns (address)

// Create ERC20 token project
function createERC20Project(
    string memory name,
    address contractor,
    address arbiter,
    string memory termsHash,
    string memory repo,
    string memory description,
    address tokenAddress,
    uint256 arbitrationFee
) public returns (address)
```

#### User Profile Functions

```solidity
// Get user profile
function getUser(address user) external view returns (
    address[] memory earnedTokens,
    uint[] memory earnedAmounts,
    address[] memory spentTokens,
    uint[] memory spentAmounts,
    address[] memory projectsAsAuthor,
    address[] memory projectsAsContractor,
    address[] memory projectsAsArbiter
)

// Called by projects to track activity
function updateEarnings(address user, uint amount, address tokenAddress) external
function updateSpendings(address user, uint amount, address tokenAddress) external
function registerProjectRoles(
    address projectAddress,
    address author,
    address contractor,
    address arbiter
) external
```

#### DAO Governance Functions

```solidity
// Set implementations (timelock only)
function setImplementations(address native, address erc20) external

// Parameter setters (timelock only after initial setup)
function setPlatformFee(uint newFeeBps) external
function setAuthorFee(uint newFeeBps) external
function setCoolingOffPeriod(uint newPeriod) external
function setBackersVoteQuorum(uint newQuorumBps) external
function setProjectThreshold(uint newThreshold) external
function setAppealPeriod(uint newPeriod) external
function setMaxImmediateBps(uint newMaxBps) external

// Fee withdrawal
function withdrawNative() external
function withdrawERC20(address tokenAddress) external

// Orphan token recovery
function sweepOrphanedTokens(address tokenAddress, address to) external
```

---

### NativeProject

**File:** `contracts/NativeProject.sol`

Escrow contract for native currency (ETH/XTZ) projects.

#### State Variables

```solidity
enum Stage { Open, Pending, Ongoing, Dispute, Appealable, Appeal, Closed }

Stage public stage;
IEconomy public economy;
string public name;
address public author;
address public contractor;
address public arbiter;
string public termsHash;

uint public projectValue;
uint public totalImmediate;
uint public totalLocked;
uint public arbitrationFee;
uint public availableToContractor;
uint public disputeResolution;  // 0-100 percent to contractor
bool public arbitrationFeePaidOut;

address public daoTimelock;
address public daoGovernor;
uint public appealEnds;

mapping(address => Contribution) public contributions;

struct Contribution {
    uint total;
    uint immediate;
    uint locked;
}
```

#### Initialization

```solidity
function initialize(
    address economyAddress,
    string memory _name,
    address _author,
    address _contractor,
    address _arbiter,
    string memory _termsHash,
    string memory _repo,
    address _daoTimelock,
    address _daoGovernor
) external payable
```

#### Funding Functions

```solidity
// Send funds (all escrowed)
function sendFunds() public payable

// Send funds with immediate release portion
function sendFundsWithImmediate(uint immediateBps) public payable
```

#### Party Setup Functions

```solidity
// Set contractor and arbiter (author only)
function setParties(
    address _contractor,
    address _arbiter,
    string memory _termsHash
) external

// Contractor signs contract
function signContract() public payable
```

#### Voting Functions

```solidity
// Vote to release payment
function voteToReleasePayment() public

// Vote to dispute
function voteToDispute() public
```

#### Dispute Functions

```solidity
// Contractor initiates dispute
function disputeAsContractor() public

// Arbiter rules on dispute
function arbitrate(uint256 percent, string memory rulingHash) public

// Handle arbiter timeout (150 days)
function arbitrationPeriodExpired() public
```

#### Appeal Functions

```solidity
// Initiate DAO appeal
function appeal(uint256 proposalId, address[] calldata targets) external

// DAO overrules arbiter
function daoOverrule(uint256 percent, string memory rulingHash) public

// Finalize arbitration (accept original ruling)
function finalizeArbitration() public
```

#### Withdrawal Functions

```solidity
// Contractor withdraws payment
function withdrawAsContractor() public

// Contributor withdraws refund
function withdrawAsContributor() public

// Reclaim arbitration fee (if no dispute)
function reclaimArbitrationFee() public

// Contractor reimburses (cancels project)
function reimburse() public
```

#### DAO Functions

```solidity
// DAO vetoes project
function daoVeto() external
```

---

### ERC20Project

**File:** `contracts/ERC20Project.sol`

Escrow contract for ERC20 token projects. Same interface as NativeProject with ERC20 handling.

#### Additional State Variables

```solidity
IERC20 public token;  // The ERC20 token used for this project
```

#### Key Differences from NativeProject

```solidity
// Funding requires token approval first
function sendFunds(uint256 amount) public  // Uses transferFrom

// Contractor signs with token staking
function signContract() public  // Requires token approval for arbitration fee
```

---

## Factory Contracts

### StandardFactory

**File:** `contracts/factories/StandardFactory.sol`

Deploys standard DAOs with governance tokens.

#### Deployment Function

```solidity
struct DaoParams {
    string name;
    string symbol;
    string description;
    uint8 decimals;
    uint256 executionDelay;
    address[] initialMembers;
    uint256[] initialAmounts;  // Token amounts + 4 governance params
    string[] keys;
    string[] values;
}

function deployDAOwithToken(DaoParams memory params) public payable
```

#### Parameter Encoding

The `initialAmounts` array contains:
1. Token amounts for each `initialMembers` address
2. Four governance parameters (at the end):
   - Voting delay (minutes)
   - Voting period (minutes)
   - Proposal threshold (tokens)
   - Quorum fraction (0-100)

#### Legacy Function

```solidity
function deployDAOwithToken(
    string memory name,
    string memory symbol,
    string memory description,
    uint8 decimals,
    uint256 executionDelay,
    address[] memory initialMembers,
    uint256[] memory initialAmounts,
    string[] memory keys,
    string[] memory values
) public payable
```

---

### TrustlessFactory

**File:** `contracts/factories/TrustlessFactory.sol`

Deploys Economy DAOs with marketplace functionality.

#### Step 1: Deploy Infrastructure

```solidity
function deployInfrastructure(uint timelockDelayInMinutes) external
```

Deploys: Economy, Timelock, Registry

#### Step 2: Deploy DAO and Token

```solidity
struct TokenParams {
    string name;
    string symbol;
    address[] initialMembers;
    uint256[] initialAmounts;
}

struct GovParams {
    string name;
    uint48 timelockDelay;
    uint32 votingPeriod;
    uint256 proposalThreshold;
    uint8 quorumFraction;
}

function deployDAOToken(
    address registryAddr,
    address timelockAddr,
    TokenParams memory tokenParams,
    GovParams memory govParams
) external
```

#### Step 3: Configure and Finalize

```solidity
struct AddressParams {
    address[2] implAddresses;      // [nativeProjectImpl, erc20ProjectImpl]
    address[5] contractAddresses;  // [economy, registry, timelock, repToken, dao]
}

struct EconomyParams {
    uint initialPlatformFeeBps;
    uint initialAuthorFeeBps;
    uint initialCoolingOffPeriod;
    uint initialBackersQuorumBps;
    uint initialProjectThreshold;
    uint initialAppealPeriod;
}

function configureAndFinalize(
    AddressParams memory addressParams,
    EconomyParams memory economyParams
) external
```

---

## Events

### Factory Events

```solidity
// StandardFactory
event NewDaoCreated(
    address indexed dao,
    address token,
    address[] initialMembers,
    uint256[] initialAmounts,
    string name,
    string symbol,
    string description,
    uint256 executionDelay,
    address registry,
    string[] keys,
    string[] values
);

// TrustlessFactory
event InfrastructureDeployed(address economy, address registry, address timelock);
event DAOTokenDeployed(address repToken, address dao);
event SuiteConfigured(
    address deployer,
    address indexed economy,
    address registry,
    address timelock,
    address indexed repToken,
    address indexed dao
);
```

### Economy Events

```solidity
event NewProject(
    address indexed contractAddress,
    string projectName,
    address contractor,
    address arbiter,
    string termsHash,
    string repo,
    string description,
    address tokenAddress  // address(0) for native
);
```

### Project Events

```solidity
event SetParties(address _contractor, address _arbiter, string _termsHash);
event SendFunds(address who, uint256 howMuch, uint immediateBps);
event ContractSigned(address contractor);
event VotedToRelease(address who, uint votingPower);
event VotedToDispute(address who, uint votingPower);
event ProjectDisputed(address by);
event ArbitrationDecision(address arbiter, uint256 percent, string rulingHash);
event ArbitrationAppealed(address indexed appealer, uint256 indexed proposalId);
event ArbitrationFinalized(address indexed finalizer);
event DaoOverruled(address indexed timelock, uint256 percent, string rulingHash);
event DaoVetoed(address indexed timelock);
event ContractorPaid(address contractor, uint256 amount);
event ContributorWithdrawn(address contributor, uint256 amount);
event ArbitrationFeeReclaimed(address who, uint256 amount);
event ProjectReimbursed(address contractor);
event ProjectClosed(address by);
```

### Governance Events

```solidity
// Governor (OpenZeppelin)
event ProposalCreated(
    uint256 proposalId,
    address proposer,
    address[] targets,
    uint256[] values,
    string[] signatures,
    bytes[] calldatas,
    uint256 voteStart,
    uint256 voteEnd,
    string description
);
event VoteCast(
    address indexed voter,
    uint256 proposalId,
    uint8 support,
    uint256 weight,
    string reason
);
event ProposalQueued(uint256 proposalId, uint256 eta);
event ProposalExecuted(uint256 proposalId);
event ProposalCanceled(uint256 proposalId);

// RepToken
event PassiveIncomeEpochStarted(uint256 epochId, uint256 budget, address paymentToken);
event PassiveIncomeClaimed(address indexed claimant, uint256 epochId, uint256 amount);
event DelegateRewardEpochStarted(uint256 epochId, uint256 budget, address paymentToken);
event DelegateRewardClaimed(address indexed claimant, uint256 epochId, uint256 amount);
event ReputationClaimed(address indexed claimant, uint256 amount);
```

---

## Deployed Addresses

### Etherlink Shadownet (chainId 127823)

Deployed 2026-10-11. Live addresses are kept in Firestore `contracts/Etherlink-Shadownet`; the old Ghostnet testnet is retired.

| Contract | Address |
|----------|---------|
| StandardFactory (wrapper) | `0x18A6cFc4E2e99C7f164Fc0857Bc2985D8CF629a2` |
| StandardFactoryTransferable (wrapper_t) | `0xfA5Df76fEF1c434dfAb764F837C6b2cf42A6685D` |
| StandardFactoryWrapped (wrapper_w) | `0x7BCFa3C390C9f004b0e43019094f4f6208e97c2D` |
| TrustlessFactory (wrapper_trustless) | `0xE748fD0cE8aCFE3c187C6e16ABB6Ba6341Dd380F` |
| NativeProject impl | `0x422E09547f732f7aE1177Be0C42B6d3903fc9f3A` |
| ERC20Project impl | `0xc873836843DA3C03D8A4aD08e99C3009b88fD179` |
| InfrastructureFactory | `0xBb334a55096cDf2B7C46406c119eB989CCA4fbEb` |
| DAOFactory | `0x432583bdEc29722d0593b1F3E198B793A5b9423F` |
| RepTokenFactory | `0xDa57341ee91Fc987E4F56c560bf71dfAC705eF73` |
| EconomyFactory | `0x36d6364E7191C31272a2D456D02178f58a457373` |
| WrappedRepTokenFactory | `0x61597CeDA571c910430b4Bad89F8f5939C91201E` |

### Network Configuration

| Network | Chain ID | RPC URL |
|---------|----------|---------|
| Etherlink Testnet | 128123 | `https://node.ghostnet.etherlink.com` |
| Etherlink Mainnet | 42793 | `https://node.mainnet.etherlink.com` |
| Localhost (Hardhat) | 31337 | `http://127.0.0.1:8545` |

---

## Constants

### Project Contract Constants

```solidity
uint constant ARBITRATION_TIMEOUT = 150 days;  // Time for arbiter to rule
uint constant BPS_DENOMINATOR = 10000;          // Basis points denominator
```

### Default Parameter Values

| Parameter | Default Value | Unit |
|-----------|---------------|------|
| `arbitrationFeeBps` | 1000 | bps (10%) |
| `platformFeeBps` | 100 | bps (1%) |
| `authorFeeBps` | 100 | bps (1%) |
| `coolingOffPeriod` | 120 | seconds |
| `backersVoteQuorumBps` | 7000 | bps (70%) |
| `projectThreshold` | 0 | tokens |
| `appealPeriod` | 604800 | seconds (7 days) |
| `maxImmediateBps` | 2000 | bps (20%) |

---

## Further Reading

- [Architecture](architecture.md) - System design and contract relationships
- [DAO Governance](dao-governance.md) - Voting and treasury management
- [Trustless Economy](economy.md) - Project lifecycle and dispute resolution
- [OpenZeppelin Governor](https://docs.openzeppelin.com/contracts/5.x/governance) - Base framework documentation
- [OpenZeppelin ERC20Votes](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#ERC20Votes) - Voting token documentation
