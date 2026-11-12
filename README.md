[![UI: werule.io](https://img.shields.io/badge/DAO%20Platform-werule.io-blue)](https://werule.io)

**Governance** and **Projects** are modules of the On-Chain Jurisdiction:
DAO governance (Governor, Timelock, Registry, RepToken, reward epochs) and the
trustless economy (project escrow, arbitration, appeals), with the satellites
that connect a jurisdiction to Autonet. By **[Eight Rice](https://eightrice.xyz)**.

*Beta, on testnet (Etherlink Shadownet, chainId 127823). Addresses are in
[`docs/deployments.md`](docs/deployments.md), and the full specification is in
[`docs/`](docs/README.md).*

## Run it

Prerequisites: Node.js 18+.

```bash
npm install
npx hardhat compile
npx hardhat test
```

Deploy scripts, network names and the local end-to-end harness are in
[`docs/deployments.md`](docs/deployments.md). The developer sections are
[below](#developing).

<!-- paper:start -->

*A chapter of [The On-Chain Jurisdiction](https://github.com/autonet-code/whitepaper), version 4 (November 2026). Its terms are defined in the paper's [Glossary](https://github.com/autonet-code/whitepaper#glossary).*

# Governance

Governance is the only non-optional module. The description below follows the perspective of its stakeholders: first the founder who creates a jurisdiction, then a member who has just received REP. A user may be a human using the Werule app or an Agent calling the contracts directly. The contracts are agnostic in this respect.

## Founding a jurisdiction

…is a permissionless action. None of the factory contracts and/or tools charge any fees for deploying or operating a jurisdiction, nor does the framework reserve any decision power in the jurisdictions that are subsequently deployed. The only cost of starting a jurisdiction is the transaction (gas) fee applied by the blockchain. The founder works through a series of choices, and the last step deploys the suite of contracts to the chain.

The first choice is which modules to attach. Projects and Autonet are both optional and neither depends on the other. Even if skipped at origination, modules can be attached later by proposal.

Then it needs a name, and a symbol for its governance token. The token is non-transferable.

The founder then sets the governance parameters:

- [**Proposal threshold**](https://docs.openzeppelin.com/contracts/5.x/api/governance#Governor-proposalThreshold--)**.** The voting weight needed to submit a proposal. The default is set at 1 REP, so nearly any member can bring a question to a vote. Raising it cuts noise, and it also shuts out small holders.
- [**Quorum**](https://docs.openzeppelin.com/contracts/5.x/api/governance#GovernorVotesQuorumFraction)**.** The minimum share of all REP that must vote For or Abstain for a proposal to pass. The suggested value is 4%.
- **Supermajority.** The share of all REP that must vote For on a constitutional proposal. It must be above half, and the suggested value is two thirds.
- [**Voting delay**](https://docs.openzeppelin.com/contracts/5.x/api/governance#Governor-votingDelay--)**.** The wait between submitting a proposal and the start of voting. The suggested value is zero. A longer delay gives members time to see a proposal coming and move their delegation before voting weights are fixed.
- [**Voting period**](https://docs.openzeppelin.com/contracts/5.x/api/governance#Governor-votingPeriod--)**.** How long voting stays open. The suggested value is seven days.
- [**Execution delay**](https://docs.openzeppelin.com/contracts/5.x/api/governance#TimelockController)**.** The wait between a proposal passing and taking effect. It gives everyone notice of what is about to happen. The suggested value is one day.

The three durations add up to the length of a full proposal life cycle, which also sets the shortest possible Autonet epoch.

The founder then lists the initial members and how much REP each one holds, which is all the REP that exists at genesis. Any other settings go into the Registry at this point, among them the value index, which names the tokens the jurisdiction recognizes and the parity of each. Modules bring settings of their own, covered in the sections below.

The final step deploys the suite of contracts. Any of these parameters can be changed by passing a constitutional proposal (which needs supermajority approval).

## Putting REP to use

Voting weight only counts once it has been delegated, either to the holder's own address or to someone else's. In werule.io those actions pertain to the buttons Claim Voting Power and Delegate Vote, in the Account tab of a DAO page. Founding members need to do this before any participation is possible, and so do members who earn REP in Projects. REP claimed through Autonet is the exception: it arrives already delegated to its holder, unless they have chosen a delegate.

[Delegation is liquid](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#ERC20Votes). The REP stays with its holder, only the right to vote with it moves, and the holder can move it as often as they like, to whomever they choose. All of a holder's REP goes to [one delegate](https://docs.openzeppelin.com/contracts/5.x/api/governance#Votes-delegate-address-), and it goes one hop only. A delegate can't pass received weight on to anyone else, so every member knows exactly who is voting with their REP. A member who wants to decide a particular question personally may claim their voting power before that proposal's voting window begins.

The healthy state of a DAO is high turnout. Having liquid and incentivized delegation creates the conditions for it. Members who can't allocate the time to study each proposal can delegate their voting weight rather than leave it idle. Delegates are compensated in proportion to the voting weight entrusted to them, which gives rise to competition among a new class of politicians. Since there are no fixed terms and any delegation can be withdrawn at will, these politicians must consistently demonstrate their alignment with their constituents, as well as their ability to watch over the consensus with vigilance.

Undelegated REP casts no vote, but it remains part of the total against which quorum and supermajority are measured. A jurisdiction may designate a default delegate by constitutional proposal, in which case new holders are delegated to it until they choose otherwise. The feature is disabled by default.

Members share in the jurisdiction's income through two reward pools, each with a budget set by the DAO. The passive income pool is claimed in proportion to REP balance, regardless of delegation. The delegate pool pays delegates in proportion to the voting weight they receive from others, provided it reaches a minimum share of all REP (a jurisdiction parameter, with a suggested value of 1%). Unclaimed funds remain in the treasury. A delegate who neglects the role loses delegators and, with them, the income.

Delegating to a second wallet of one's own and claiming from both pools is technically possible, and no on-chain rule prevents it. It is recommended that jurisdictions prohibit it in their code of conduct. Wallet ownership can't be proven on-chain, so enforcement rests on the DAO's judgment of the evidence, which remains practical since only delegates above the minimum share are paid. The penalty is the burning of the offender's REP by constitutional proposal. As in a parliament, such cases can be placed on an agenda, debated, and submitted together as a batch proposal.

## Making a proposal

A proposal is a set of contract calls, accompanied by a title and a description. Upon passing, those exact calls are executed atomically. No intermediary carries out the decision, and nothing other than what was voted on can be executed.

Any address holding a set minimum amount of voting power (proposal threshold) can submit a proposal, which then moves through the [following stages](https://docs.openzeppelin.com/contracts/5.x/governance#proposal-lifecycle):

- **Pending.** The voting delay. The proposer can still [withdraw](https://docs.openzeppelin.com/contracts/5.x/api/governance#Governor-cancel-address---uint256---bytes---bytes32-) the proposal. It allows members the time to claim their voting power, should they have it delegated and intend to vote directly. When this period ends, a [snapshot](https://docs.openzeppelin.com/contracts/5.x/api/governance#Governor-proposalSnapshot-uint256-) fixes the voting weight of every address with respect to this proposal. If there is no voting delay, the snapshot fires at the moment of proposal submission, since that’s when the voting window starts.
- **Active.** Members vote For, Against or Abstain using their weight at the snapshot. Changes in REP or delegation after that point have no effect on this proposal. From this point the proposal can no longer be withdrawn.
- **Succeeded or Defeated.** A proposal passes if [For exceeds Against](https://docs.openzeppelin.com/contracts/5.x/api/governance#GovernorCountingSimple) and quorum is met. [Voting ends early](https://docs.openzeppelin.com/contracts/5.x/api/governance#GovernorSuperQuorum) once the outcome is decided: success when For holds more than half of all REP and meets quorum, defeat when Against holds half.
- **Queued.** Anyone can queue a successful proposal, which starts the execution delay.
- **Executed.** Once the delay has elapsed, anyone can execute the proposal. Queued proposals don't expire.

Werule.io provides a form for each common proposal type: treasury transfers, Registry edits, changes to the DAO configuration, minting and burning REP, reward epochs, and attaching or removing modules. Anything else can be submitted as a custom contract call, and multiple actions can be batched in a single proposal. Relationships between jurisdictions are theirs to define by the same means: one can, for instance, mint REP to the timelock of another, granting it a stake in its votes. Autonet's epoch anchors run on the same machinery as single-choice elections, covered in its section.

Most of these are ordinary proposals, decided as above. These include treasury spending, most Registry edits, service and platform fees, reward epochs, sanctions against a household, project vetoes and overruling an arbiter.

A proposal is constitutional if any of its actions affects what makes votes binding or who holds voting weight:

- Changes to voting parameters: proposal threshold, quorum, supermajority, voting delay, voting period.
- Any call to the timelock, including changes to the execution delay.
- Changes to who holds or can create REP: minting, burning, granting the right to mint or slash, designating a default delegate.
- Attaching or removing a module, since modules carry rights over REP.
- Eight Registry entries: the Autonet charter, the epoch rules, the REP rate, and the addresses of the five contracts every daemon reads at start (Substrate.sol, the REP token, ToolBond.sol, the governor and the timelock).

The contract determines this at submission, so a proposal can't avoid the classification. A constitutional proposal requires For votes from the supermajority of all REP at the snapshot, in addition to quorum. Anything other than For counts against it: Against, Abstain, absent members and undelegated REP. It passes as soon as it reaches the bar, and fails as soon as the bar is out of reach.

This is by design. A jurisdiction whose members stop participating can't rewrite its rules, including by lowering the bar. Those who remain can fork.

# Projects

Projects is the jurisdiction's marketplace for work, and its civil justice. An author posts a project, backers fund it into escrow, a contractor delivers the work, and the backers either release the funds or send the project to an arbiter. The jurisdiction stands above every project: it can veto a project and overrule an arbiter. Projects is the only way to crowdfund within a jurisdiction. From funding to the last payout, the funds move only by the rules of the project's contract, and no intermediary holds them.

The description below follows a project from its creation to its close. As in Governance, a user may be a human using the Werule app or an Agent calling the contracts directly.

## Installing Projects

Projects is an optional module, attached at genesis or later by proposal. Attaching it adds the Economy contract, which creates the projects and keeps the ledger that REP is claimed from, and EconomyRepClaim.sol, which mints that REP. Each project is a contract of its own, paid either in the chain's native currency or in one token. The installation takes the following parameters, shown with their default values:

- **Platform fee.** The share of every payout that goes to the treasury, between 1% and 50%. The default is 1%.
- **Author fee.** The share of the contractor's payouts that goes to the project's author, at most 25%. The default is 1%.
- **Arbitration fee.** The share of the locked funds that pays the arbiter for a ruling, at most 25%. It is set at installation.
- **Cooling-off period.** How long backers can withdraw before the contractor can sign. The default is one day. It can never be shorter than a minimum fixed at installation.
- **Backer quorum.** The share of the locked funds whose votes release the payment or open a dispute, between 50% and 99%. The default is 70%.
- **Project threshold.** The REP an author needs to create a project. The default is zero.
- **Appeal window.** How long after a ruling the DAO can still overrule it. The default is seven days.
- **Arbitration timeout.** How long an arbiter has to rule before the backers can take back their locked funds. The default is 30 days.
- **Immediate release cap.** The largest share of a contribution that a backer can mark for immediate release, at most 50%. The default is 20%.

Every parameter can be changed later by ordinary proposal. A change reaches existing projects as well, except for the cooling-off period and the arbitration fee, which a project fixes when its cooling-off starts and when it is signed.

## Creating and funding a project

An author holding at least the project threshold of REP creates a project, with a name, a description and the hash of its terms, and names a contractor and an arbiter. The author can also name them later, which opens the project to funding first.

Anyone can fund a project. A backer can mark part of each contribution, up to the immediate release cap, for immediate release: it is paid to the contractor at signing, as working capital. The rest is locked in escrow. The split is how a backer prices their trust in the contractor.

Once the contractor and the arbiter are named, the cooling-off period starts. Until the contract is signed, a backer can withdraw everything they contributed, the immediate share included.

## Signing

After the cooling-off period, the contractor signs the contract, and the work starts. Signing fixes the arbitration fee as a share of the locked funds, and the contractor stakes half of it. The immediate shares are paid out at signing and never come back, whatever happens afterwards.

A member who thinks a project should not go ahead proposes a veto. A veto proposal registered on the project during the cooling-off period holds the signing until the proposal is decided (a pending veto), so the jurisdiction always finishes its vote before the contractor can sign. The Werule indexer registers such proposals, and anyone else can register them as well.

## Release

When the work is delivered, the backers vote to release the locked funds to the contractor. Each backer votes with their locked funds, and immediate shares carry no vote. Once backers holding the backer quorum vote to release, the project closes and the contractor collects the locked funds. The contractor can instead give up the project, which closes it and returns the locked funds to the backers.

## Disputes

If backers holding the quorum vote to dispute, or if the contractor disputes, the project goes to its arbiter. The arbiter rules on a split: a percentage of the locked funds goes to the contractor, and the rest to the backers in proportion to what each of them locked. The arbitration fee pays the arbiter, half from the contractor's stake and half from the locked funds, and only if the arbiter rules.

A ruling takes effect when the appeal window closes. Within the window, any member can appeal by proposing a different split to the DAO. A registered appeal holds the ruling until the proposal is decided, and if the proposal passes, the DAO's split replaces the arbiter's, even after the window has closed.

An arbiter who has not ruled by the end of the appeal window loses the exclusive right to rule. From then on the DAO can rule in the arbiter's place, and the arbitration fee goes to the treasury. If nobody rules before the arbitration timeout, the project closes and the backers take back their locked funds, with no fee.

The parties choose their arbiter by taking part in the project, and the DAO is their court of appeal. This is the jurisdiction's civil justice.

## The DAO's veto

The DAO can veto any project until it closes. A veto closes the project and returns to the backers what the project still holds, less the platform fee, and a frivolous project therefore still costs its backers something. Before signing, a veto returns the immediate shares as well. After signing, the immediate shares are the contractor's.

## What a project earns

Every payout follows the same path. The platform fee goes to the treasury, the author fee goes to the author on the contractor's payouts only, and the rest goes to the payee. Refunds to backers pay no fee.

The Economy contract keeps a ledger of what each member earned and spent in projects, per token. Earnings are the contractor's net payouts, the author's fees and the arbiter's net fee. Spending is what a backer contributed, less what came back. A member claims REP against the ledger at the token's parity, multiplied by the REP rate: REP = value x parity x rate. A token without a parity earns no REP. The REP rate is a Registry entry that applies to every token, and since it decides how much voting power economic activity mints, it changes only by constitutional proposal. A new rate also applies to REP earned before it but not yet claimed.

Every payout that earns REP pays the platform fee, and the fee is therefore the least that REP costs. Funding one's own project to farm REP costs real money. REP claimed from Projects counts only once delegated (see [Putting REP to use](#putting-rep-to-use)).

<!-- paper:end -->

# Developing

## Repo map

| Path | What |
|------|------|
| `contracts/` | Governor (`Dao.sol`), `RepToken`, `Registry`, `Economy`, `EconomyRepClaim`, project escrows (`NativeProject`, `ERC20Project`), Autonet satellites |
| `contracts/factories/` | `JurisdictionFactory` (every DAO core) plus its sub-factories |
| `contracts/modules/` | Module standard (`ModuleSetup`, `ModuleRepo`, `ModuleCatalog`, `ModuleProcessor`) and the economy, content court and Autonet setups |
| `modules/` | Release and build metadata per module |
| `scripts/` | Deploy and operational scripts; `scripts/indexer-e2e/` is the local end-to-end harness |
| `test/` | Hardhat test suite |
| `docs/` | The specification ([index](docs/README.md)) |

The chapter above is generated from the paper's source by
[`publish/publish.py`](https://github.com/autonet-code/whitepaper/tree/main/publish)
in the whitepaper repo: change it there, not here.

## Related repositories

| Repo | What |
|------|------|
| [node](https://github.com/autonet-code/node) | Autonet: the daemon, the tool library, the services market and its contracts (Substrate, ServiceMarket, AnchorElection). |
| [whitepaper](https://github.com/autonet-code/whitepaper) | The paper's overview and glossary, the whole paper as one PDF, and its earlier versions. |
| [werule-indexer](https://github.com/EightRice/werule-indexer) | The indexer and publisher that werule reads. |

## License

MIT

## Contact

andrei@dorg.tech
