# On-Chain Jurisdiction

A framework for autonomous economic coordination through decentralized governance, trustless commerce, and AI-powered services.

[![UI: werule.io](https://img.shields.io/badge/DAO%20Platform-werule.io-blue)](https://werule.io)
[![UI: trustless.business](https://img.shields.io/badge/Trustless%20Economy-trustless.business-green)](https://trustless.business)
[![UI: autonet.computer](https://img.shields.io/badge/Autonet-autonet.computer-purple)](https://autonet.computer)

## The Promise of Trustless Coordination

Throughout history, economic progress has depended on systems of trust. Nations built legal frameworks, courts established precedent, and institutions emerged to mediate agreements between strangers. These systems enabled civilization to scale beyond tribal networks where everyone knew everyone else.

But these systems come with costs: bureaucratic overhead, jurisdictional boundaries, access inequality, and the ever-present risk of corruption. What if trust itself could be encoded into the fabric of our agreements?

**On-Chain Jurisdiction** represents a new paradigm: a self-enforcing framework where:
- **Agreements execute automatically** according to predefined terms
- **Disputes resolve through transparent arbitration** with built-in appeals
- **Reputation accrues from real economic activity**, not credentials or social capital
- **Governance power flows to those who contribute**, not those who merely invest

This is not a replacement for traditional systems, but an alternative—one that exists alongside them, available to anyone with internet access and a desire to participate in trustless commerce.

## Three Systems, One Jurisdiction

On-Chain Jurisdiction provides three complementary systems that work together:

### 1. DAO Governance

Decentralized organizations with on-chain voting, treasury management, and transparent decision-making. Built on [OpenZeppelin's Governor framework](https://docs.openzeppelin.com/contracts/5.x/governance), our implementation adds:

- **Reputation Tokens (RepToken)** that can be non-transferable to prevent vote-buying
- **Registry** for treasury management and configuration storage
- **Timelock security** for all governance actions
- **Incentive epochs** for rewarding participation and delegation

**Use cases:**
- Protocol governance
- Treasury management
- Community coordination
- Grant distribution

### 2. Trustless Economy

A marketplace for work where agreements self-enforce through smart contracts. Funds are held in escrow until work is verified, with a multi-layered dispute resolution system:

- **Backer voting** for straightforward releases
- **Third-party arbitration** when parties disagree
- **DAO appeals** as a final safeguard against bad rulings

Economic activity generates reputation, which translates to governance power. The more you contribute to the economy, the more influence you have over its rules.

**Use cases:**
- Freelance work and service agreements
- Crowdfunded projects
- DAO-to-DAO collaboration
- Grant distribution with milestone tracking

### 3. Autonet Integration (AI Economic Layer)

The jurisdiction connects to the **external Autonet network** (the Substrate contract in the autonet repo). ATN — the network's training/inference credit (6-decimal) — is minted and accounted THERE, never locally: the legacy jurisdiction-local `Autonet.sol` token was removed from this suite. The jurisdiction-side surface is a set of satellites:

- **`AutonetVault`**: CoinOffering-shaped router that sells Substrate ATN for registry-whitelisted ERC20s at registry parity. Payment routes straight to the DAO treasury (Registry); ATN is minted to the buyer on the external Substrate via `IAutonetATN.mintFromVault`. Uncapped, buy-only, never custodies funds.
- **`ReputationMirror`**: reads the soulbound agent reputation earned on the Substrate and mints RepToken to the human owners of owner-bound agents (mirror, don't bridge — no token ever flows between the two ledgers).
- **`CoinOffering`**: sells the jurisdiction's own transferable governance token (ATNB) for whitelisted ERC20s under a DAO-set sale cap.

**Use cases:**
- Funding a jurisdiction treasury by selling network ATN
- Translating agent training reputation into DAO governance weight
- Economic alignment of AI services with community standards

## How They Connect

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              JURISDICTION                                    │
│                                                                              │
│  ┌─────────────────────┐         ┌─────────────────────────────┐             │
│  │   DAO Governance    │◄───────►│    Trustless Economy        │             │
│  │                     │         │                             │             │
│  │  • Proposals        │ Appeals │  • Projects with escrow     │             │
│  │  • Voting           │◄────────│  • Arbitration              │             │
│  │  • Treasury         │         │  • Reputation tracking      │             │
│  │  • Parameter tuning │────────►│  • Fee collection           │             │
│  └──────────┬──────────┘         └──────────┬──────────────────┘             │
│             │                                │                               │
│             └──────────────┬─────────────────┘                               │
│                            │                                                 │
│                   ┌────────▼────────┐       ┌──────────────────────────┐     │
│                   │    RepToken     │       │  Autonet satellites      │     │
│                   │                 │◄──────│                          │     │
│                   │ Governance power│ Mirror│  • AutonetVault (sells   │     │
│                   │ from economic   │       │    external Substrate    │     │
│                   │ activity        │       │    ATN, pays treasury)   │     │
│                   └─────────────────┘       │  • ReputationMirror      │     │
│                                             │    (substrate rep →      │     │
│                                             │     owner RepToken)      │     │
│                                             └────────────┬─────────────┘     │
└──────────────────────────────────────────────────────────┼───────────────────┘
                                                           ▼
                                             external Autonet Substrate (ATN)
```

1. **Activity generates reputation**: Complete projects, fund work, or arbitrate disputes → earn RepTokens
2. **Reputation enables governance**: Hold RepTokens → vote on proposals, create proposals, appeal rulings
3. **Governance shapes the economy**: DAO votes set fees, quorums, thresholds, and can override arbitration
4. **AI work feeds governance**: agents earn reputation on the external Substrate → ReputationMirror mints RepToken to their owners; AutonetVault sells Substrate ATN and funds the treasury

## Quick Start

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
npm install
```

### Compile Contracts

```bash
npx hardhat compile
```

### Deploy a DAO

```bash
# Standard DAO (governance only)
npx hardhat run scripts/deployStandardFactory.js --network et

# Economy DAO (governance + marketplace)
npx hardhat run scripts/deployTrustlessFactory.js --network et

# Autonet jurisdiction (DAO suite + genesis satellites; see script header)
npx hardhat run scripts/deploy-autonet-jurisdiction.js --network et
```

### Run Tests

```bash
npx hardhat test
```

## Documentation

Detailed documentation is organized into chapters:

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System design, contract relationships, deployment patterns |
| [DAO Governance](docs/dao-governance.md) | Voting, proposals, RepToken, Registry, OpenZeppelin integration |
| [Trustless Economy](docs/economy.md) | Project lifecycle, escrow, arbitration, dispute resolution |
| [Technical Reference](docs/technical-reference.md) | Contract functions, parameters, events, deployed addresses |

## Contract Overview

### Core Contracts

| Contract | Purpose |
|----------|---------|
| `HomebaseDAO` | Governor contract implementing proposal and voting lifecycle |
| `RepToken` | ERC20Votes governance token with reputation accrual from Economy |
| `Registry` | Treasury (ETH, ERC20, ERC721) and configuration key-value store |
| `TimelockController` | Execution delay for all governance actions |
| `Economy` | Marketplace contract that deploys and tracks projects |
| `NativeProject` | Escrow contract for native currency (ETH/XTZ) projects |
| `ERC20Project` | Escrow contract for ERC20 token projects |
| `AutonetVault` | Sells external Substrate ATN for whitelisted ERC20s; payment routes to the Registry treasury |
| `ReputationMirror` | Mints RepToken to owners of agents that earned reputation on the external Substrate |
| `CoinOffering` | Sells the transferable governance token (ATNB) for whitelisted ERC20s, capped by the DAO |

### Factory Contracts

| Factory | Creates | Token Type |
|---------|---------|------------|
| `StandardFactory` | DAO without economy | Non-transferable RepToken |
| `StandardFactoryTransferable` | DAO without economy | Transferable RepToken |
| `StandardFactoryWrapped` | DAO wrapping existing ERC20 | WrappedRepToken |
| `TrustlessFactory` | DAO with economy | Non-transferable RepToken |

## Key Concepts

### Non-Transferable Governance

By default, RepTokens cannot be transferred. This prevents vote-buying and ensures governance power comes from participation, not purchase. Users earn reputation through:

- Completing work as a contractor
- Funding projects as a backer
- Resolving disputes as an arbiter

### Timelock Security

All governance actions pass through a TimelockController with configurable delays. This gives the community time to:

- Review approved proposals before execution
- Exit the system if they disagree with a decision
- Coordinate response to malicious proposals

### Multi-Layer Dispute Resolution

Projects can become contentious. The system provides multiple resolution paths:

1. **Backer consensus**: If 70%+ of backers agree, funds release or dispute
2. **Arbitration**: A designated arbiter rules on the split
3. **DAO appeal**: Any member with sufficient reputation can appeal to governance
4. **Timeout**: If arbiters fail to act, projects auto-close after 150 days

### Immediate Release

Backers can choose to release a portion of their contribution immediately upon contract signing, allowing contractors to access operating capital. The remainder stays in escrow until project completion.

### Autonet: AI Economic Layer

The Autonet network's economics live on its own Substrate contract (autonet repo): ATN is minted there in lockstep with soulbound agent reputation, with no admin keys. The core idea: **AI alignment as economic equilibrium**—rather than constraining AI behavior through training alone, the system creates economic incentives where aligned work is subsidized and misaligned work carries premiums.

This suite integrates with that network rather than reimplementing it:

**AutonetVault (ATN offering):**
- Sells the external Substrate ATN for registry-whitelisted ERC20s at the registry-settled parity (`jurisdiction.parity.<token>`, 18-dec fixed point; ATN itself is 6-decimal — decimals are baked into the parity value)
- Payment is pulled straight into the DAO treasury (Registry) — the vault never custodies funds
- Mints via the minimal `IAutonetATN.mintFromVault(to, amount)` surface, which the Substrate implements gated to the vault address (a constructor arg on the Substrate side — see the genesis choreography in `scripts/deploy-autonet-jurisdiction.js`)

**ReputationMirror (reputation → governance):**
- Reads `agentReputation` / `getAgentOwner` from the Substrate and mints RepToken to human owners proportional to newly earned agent reputation (delta-based, monotonic cursor, mirror-don't-bridge)
- The DAO timelock governs the exchange rate and must grant the mirror minter rights on RepToken

**Theoretical Foundation:**
The framework is described in detail in the paper *"Emergent Alignment: Economic Mechanisms for the Peaceful Transfer of Work from Humans to AI"* (see `paper/` directory), which presents alignment as pricing based on semantic distance from published jurisdiction standards, with a seven-tendency World Model for value-aligned representation.

## Deployed Addresses

### Etherlink Shadownet (chainId 127823)

Deployed 2026-10-11. Live addresses are kept in Firestore `contracts/Etherlink-Shadownet`; the old Ghostnet testnet is retired.

```
StandardFactory (wrapper):               0x18A6cFc4E2e99C7f164Fc0857Bc2985D8CF629a2
StandardFactoryTransferable (wrapper_t): 0xfA5Df76fEF1c434dfAb764F837C6b2cf42A6685D
StandardFactoryWrapped (wrapper_w):      0x7BCFa3C390C9f004b0e43019094f4f6208e97c2D
TrustlessFactory (wrapper_trustless):    0xE748fD0cE8aCFE3c187C6e16ABB6Ba6341Dd380F
NativeProject impl:                      0xAA27316e0ebAa6726f34dAc5B73987c7330cF706
ERC20Project impl:                       0x089fC80B09738D3e4a21dB7dbAFAC336326ae0B4
InfrastructureFactory:                   0xBb334a55096cDf2B7C46406c119eB989CCA4fbEb
DAOFactory:                              0x432583bdEc29722d0593b1F3E198B793A5b9423F
RepTokenFactory:                         0xDa57341ee91Fc987E4F56c560bf71dfAC705eF73
EconomyFactory:                          0x36d6364E7191C31272a2D456D02178f58a457373
WrappedRepTokenFactory:                  0x61597CeDA571c910430b4Bad89F8f5939C91201E
```

## Tech Stack

- **Solidity** ^0.8.24 (compiled with 0.8.26, Cancun EVM)
- **Hardhat** development environment
- **OpenZeppelin Contracts** 5.x

## Security Model

| Threat | Mitigation |
|--------|------------|
| Vote buying | Non-transferable tokens by default |
| Flash loan attacks | Snapshot-based voting power |
| Malicious proposals | Timelock execution delay |
| Bad arbitration | DAO appeal system |
| Reentrancy | ReentrancyGuard on treasury operations |
| Abandoned projects | 150-day arbitration timeout |
| Vault custody risk | AutonetVault routes payment atomically to the Registry treasury; never holds funds |
| Unbacked ATN sales | ATN minted only on the external Substrate, gated to the vault address fixed at Substrate construction |
| Reputation double-count | ReputationMirror delta-based accrual over a monotonic per-agent cursor |

## Web Interfaces

- **[werule.io](https://werule.io)** - DAO governance platform
- **[trustless.business](https://trustless.business)** - Trustless Economy marketplace
- **[autonet.computer](https://autonet.computer)** - Autonet AI services and user onboarding

## Contributing

Contributions are welcome. Please:

1. Fork the repository
2. Create a feature branch
3. Write tests for new functionality
4. Submit a pull request

## License

MIT

## Contact

andrei@dorg.tech
