# On-Chain Jurisdiction

[![UI: werule.io](https://img.shields.io/badge/DAO%20Platform-werule.io-blue)](https://werule.io)
[![UI: trustless.business](https://img.shields.io/badge/Trustless%20Economy-trustless.business-green)](https://trustless.business)
[![UI: autonet.computer](https://img.shields.io/badge/Autonet-autonet.computer-purple)](https://autonet.computer)

> **Abstract.** Economic progress has always depended on systems of trust: courts, contracts, and the institutions that mediate agreements between strangers. They scale, but they carry bureaucratic overhead, jurisdictional boundaries, unequal access, and the standing risk of capture. On-Chain Jurisdiction encodes that trust into the agreements themselves. A jurisdiction is a DAO whose members govern a marketplace of escrowed work; the marketplace resolves disputes through backer votes, arbitration and appeal to governance; and the reputation that carries voting power is earned from real economic activity rather than bought. The same jurisdiction is the human governance layer of Autonet, a self-sufficient economy for AI and human agents. The rule of this codebase is that protection belongs in the code: every guarantee a participant relies on is enforced by a contract, not by an operator.

**[Eight Rice](https://eightrice.xyz)** | [werule.io](https://werule.io) | [trustless.business](https://trustless.business) | [autonet.computer](https://autonet.computer)

*Beta, on testnet. A full suite (DAO factories, project implementations, Autonet satellites) is live on Etherlink Shadownet (chainId 127823) since October 2026, pending a redeploy of the module architecture described here; addresses in [`docs/deployments.md`](docs/deployments.md). This README is the living paper: each section links to its full specification in [`docs/`](docs/README.md).*

## 1. The promise of trustless coordination

Throughout history, economic progress has depended on systems of trust. Nations built legal frameworks, courts established precedent, and institutions emerged to mediate agreements between strangers. These systems enabled civilization to scale beyond tribal networks where everyone knew everyone else.

But these systems come with costs: bureaucratic overhead, jurisdictional boundaries, access inequality, and the ever-present risk of corruption. What if trust itself could be encoded into the fabric of our agreements?

**On-Chain Jurisdiction** is a self-enforcing framework where:

- **Agreements execute automatically** according to predefined terms
- **Disputes resolve through transparent arbitration** with built-in appeals
- **Reputation accrues from real economic activity**, not credentials or social capital
- **Governance power flows to those who contribute**, not those who merely invest

This is not a replacement for traditional systems but an alternative that exists alongside them, available to anyone with internet access and a desire to participate in trustless commerce.

## 2. Governance: the jurisdiction itself

A jurisdiction is a DAO built on [OpenZeppelin's Governor](https://docs.openzeppelin.com/contracts/5.x/governance): a Governor that counts votes, a Timelock that delays and executes every decision and holds the treasury's authority, a Registry that is both treasury and the jurisdiction's key-value constitution, and a RepToken that carries voting power. Reputation is non-transferable by default, so influence cannot be bought on a market; transferable and wrapped variants exist for communities that want them. Every governance action passes through the Timelock, which gives members time to review, object, or exit before anything executes. One factory creates this core for every DAO; everything else (the economy, the content court, the Autonet layer) is a module the DAO attaches at origination or later by proposal. ([full spec →](docs/governance.md), [modules →](docs/modules.md))

## 3. Agreements that enforce themselves

The economy module adds a marketplace. Anyone can open a project; backers fund it into an escrow contract; a contractor and an arbiter are named; the contractor signs by staking half the arbitration fee. From then on the money moves only by rule:

1. **Cooling-off.** Before the contractor can sign, backers can withdraw in full for a cooling-off period that is never shorter than a minimum fixed at deployment (1 day by default), whatever the DAO configures. A DAO proposal to veto the project, registered on it by the indexer or by anyone, holds signing until the vote is decided, so the jurisdiction always gets to finish its vote. A veto refunds backers in full.
2. **Immediate release.** Backers may release part of their contribution (up to a DAO-set cap, 20% by default) to the contractor at signing, as operating capital. The rest stays in escrow. ([spec →](docs/immediate-release.md))
3. **Backer consensus.** When backers holding 70% of the stake agree, funds release to the contractor or the project moves to dispute.
4. **Arbitration.** In a dispute the arbiter rules on a split. If the arbiter never acts, the project can be closed after 150 days.
5. **Appeal.** Appeals happen in the DAO: a member proposes a different ruling, and if the proposal passes it overrules the arbiter. Once the proposal is registered on the project inside the appeal window (7 days by default), the ruling can't finalize until the vote is decided, and a passed overrule lands even after the window. A dispute the arbiter leaves unruled past that period can be settled the same way.

Every payout (immediate release, escrow release, the arbiter's fee) pays a platform fee to the jurisdiction's treasury. The DAO tunes it, but only between 1% and 50%: a jurisdiction can neither run its economy for free nor confiscate it. ([full spec →](docs/economy.md))

## 4. Reputation from economic activity

The economy keeps an on-chain ledger of what each participant has earned and spent, per token. Members claim RepToken against that ledger (through the economy's REP claim contract, a RepToken minter) at a parity the DAO sets per token in the Registry (`jurisdiction.parity.<token>`, an 18-decimal multiplier that absorbs each token's decimals). Contractors earn reputation for completed work, backers for funding it, arbiters for resolving it. The more you contribute to the economy, the more you shape its rules: fees, quorums, thresholds, and the power to overrule arbitration. ([parity and settings →](docs/registry-settings.md))

## 5. Paying the people who govern

Governance work is paid. The DAO opens reward epochs by proposal: each epoch earmarks a budget in the treasury, in native currency or any ERC20, and members claim a share proportional to their voting power at the epoch's snapshot. A fixed share of each delegator's reward (1% by default, at most 25%) goes to the delegate they chose, so the members who do the voting are paid by the members who trust them with it. Whatever stays unclaimed returns to the treasury once the next epoch has started and a DAO-set grace period has passed. ([full spec →](docs/governance.md#reward-epochs))

## 6. Protection in the code

Guarantees that depend on an operator's good behaviour are not guarantees. The suite enforces its protections on-chain:

| Risk | Enforced by |
|------|-------------|
| Vote buying | Non-transferable reputation by default |
| Flash-loan voting | Snapshot-based voting power |
| Contractor signs before the DAO can react | A registered veto proposal holds signing until decided; cooling-off never below a deploy-time minimum |
| Fee capture or a free-riding economy | Platform fee bounded to 1% to 50%; author and arbitration fees capped at 25% |
| Bad arbitration | DAO overrule by proposal; a registered overrule holds finalization until decided |
| Abandoned projects | 150-day arbitration timeout |
| Hijacked DAO deployment | A pending DAO can be finalized only by the account that started it |
| Malicious module | Only setups published in the module catalog attach, and only against the DAO's own token and Registry |
| Economy administered by a key | The economy is handed to the Timelock in the transaction that creates it |
| Reentrancy and non-standard tokens | ReentrancyGuard, SafeERC20 |

([threat model →](docs/security.md))

## 7. The AI layer: Autonet

The jurisdiction is the human governance of [Autonet](https://github.com/autonet-code/node), an economy in which AI agents publish tools, earn ATN from attested usage, and convert their earnings into soulbound reputation. ATN is minted only on Autonet's own Substrate contract, never here. This suite holds the jurisdiction-side satellites: `AutonetVault` sells Substrate ATN for whitelisted tokens and routes every payment straight to the DAO treasury; `AutonetRepClaim` mints RepToken to agents 1:1 against the ATN they provably earned on the Substrate, so voice is always work-backed; `CoinOffering` sells the jurisdiction's transferable governance token under a DAO-set cap. As machine intelligence earns, the humans who govern it are the ones it pays. ([full spec →](docs/autonet.md))

## 8. How it connects

```
┌────────────────────────────────── JURISDICTION ──────────────────────────────────┐
│                                                                                  │
│   ┌──────────────────────┐   appeals, vetoes    ┌───────────────────────────┐    │
│   │  Governor + Timelock │◄─────────────────────│  Economy + project escrow │    │
│   │  Registry (treasury) │─────────────────────►│  arbitration, fees        │    │
│   └──────────┬───────────┘  fees, parameters    └─────────────┬─────────────┘    │
│              │ voting power                     earned/spent  │                  │
│        ┌─────▼──────┐◄──────────────────────────────────────────┘                │
│        │  RepToken  │◄──────────── AutonetRepClaim (agent earnings)              │
│        └────────────┘              AutonetVault ──► treasury                     │
└──────────────────────────────────────────┬───────────────────────────────────────┘
                                           ▼
                            Autonet Substrate (ATN, agent earnings)
```

Events from every contract are indexed into Firestore and read by two web apps: [werule.io](https://werule.io) for DAOs and [trustless.business](https://trustless.business) for the economy. ([architecture →](docs/architecture.md))

## 9. Read the full specification

| # | Section | Doc |
|---|---------|-----|
| 1 | Architecture: contracts, factory, modules, indexer, apps | [`docs/architecture.md`](docs/architecture.md) |
| 2 | Governance: Governor, Timelock, Registry, RepToken, reward epochs | [`docs/governance.md`](docs/governance.md) |
| 3 | The trustless economy: project lifecycle, escrow, arbitration | [`docs/economy.md`](docs/economy.md) |
| 4 | Immediate release | [`docs/immediate-release.md`](docs/immediate-release.md) |
| 5 | Registry settings and parity | [`docs/registry-settings.md`](docs/registry-settings.md) |
| 6 | Autonet integration | [`docs/autonet.md`](docs/autonet.md) |
| 7 | Security model | [`docs/security.md`](docs/security.md) |
| 8 | Technical reference: functions, events, parameters | [`docs/technical-reference.md`](docs/technical-reference.md) |
| 9 | Deployments, scripts, local end-to-end harness | [`docs/deployments.md`](docs/deployments.md) |
| * | Full index | [`docs/README.md`](docs/README.md) |

The theoretical framework is the paper *Emergent Alignment: Economic Mechanisms for the Peaceful Transfer of Work from Humans to AI* ([autonet-code/whitepaper](https://github.com/autonet-code/whitepaper)). Where it disagrees with the docs above, the docs describe the deployed system.

## Quickstart

Prerequisites: Node.js 18+.

```bash
npm install
npx hardhat compile
npx hardhat test
```

Deploy scripts, network names and the local end-to-end harness (Hardhat node, Firestore emulator, indexer, UI tests) are in [`docs/deployments.md`](docs/deployments.md).

## Repo map

| Path | What |
|------|------|
| `contracts/` | Governor (`Dao.sol`), `RepToken`, `Registry`, `Economy`, `EconomyRepClaim`, project escrows (`NativeProject`, `ERC20Project`), Autonet satellites |
| `contracts/factories/` | `JurisdictionFactory` (every DAO core) plus its sub-factories |
| `contracts/modules/` | Module standard (`ModuleSetup`, `ModuleRepo`, `ModuleCatalog`, `ModuleProcessor`) and the economy, content court and Autonet setups |
| `modules/` | Release and build metadata per module |
| `scripts/` | Deploy and operational scripts; `scripts/indexer-e2e/` is the local end-to-end harness |
| `test/` | Hardhat test suite |
| `docs/` | The specification (see §9) |

## Related repositories

| Repo | What |
|------|------|
| [node](https://github.com/autonet-code/node) | Autonet: the agent economy and its Substrate contract |
| [whitepaper](https://github.com/autonet-code/whitepaper) | *Emergent Alignment* and earlier papers |

## License

MIT

## Contact

andrei@dorg.tech
