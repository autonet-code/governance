# Trustless Economy

The Economy is a jurisdiction's marketplace for work. An author posts a project, backers fund it into escrow, a contractor signs and delivers, and backers either release the escrow or send it to an arbiter. The jurisdiction (its Governor and Timelock) sits above every project: it can veto, hear appeals, and tune the economy's parameters. Paid work and funded work both accrue reputation (REP) in the jurisdiction. The Economy is the `economy` [module](modules.md): `EconomySetup` deploys and configures it for a DAO's core, and attaching it records `jurisdiction.economy` and `jurisdiction.economy.rep_claim` in the Registry.

Contracts:

| Contract | Role |
|----------|------|
| `contracts/Economy.sol` | One per jurisdiction. Deploys projects as minimal clones, holds DAO-governed parameters, keeps the earnings/spending ledger that REP is minted from. |
| `contracts/NativeProject.sol` | Escrow for one project paid in the chain's native currency. |
| `contracts/ERC20Project.sol` | Same lifecycle, paid in one ERC20 token (SafeERC20 transfers). |
| `contracts/EconomyRepClaim.sol` | One per Economy. A RepToken minter that mints REP for a member's earnings and spendings, at the jurisdiction's parities. |
| `contracts/modules/EconomySetup.sol` | The module setup: deploys, configures and hands over an Economy and its EconomyRepClaim. |
| `contracts/IEconomy.sol` | Callbacks projects make into the Economy (`updateEarnings`, `registerBacker`, `registerProjectRoles`). |
| `contracts/IGovernedEconomy.sol` | Parameter getters projects read from the Economy. |

See also: [architecture.md](architecture.md) for how the suite is wired, [governance.md](governance.md) for the proposal lifecycle, [registry-settings.md](registry-settings.md) for every parameter and registry key, [immediate-release.md](immediate-release.md) for advance payments, [technical-reference.md](technical-reference.md) for full signatures, [deployments.md](deployments.md) for addresses, and [autonet.md](autonet.md) for the AI layer built on top.

## Roles

| Role | Who | Can do | Paid |
|------|-----|--------|------|
| Author | Creator of the project (needs `projectThreshold` REP) | Set parties if not set at creation, fund | Author fee on every contractor payout |
| Backer | Anyone who funds | Fund, withdraw before signing, vote release/dispute with locked funds, withdraw refund after close | Refund per outcome; REP for what they spent |
| Contractor | Named by author | Sign, dispute, reimburse (cancel), withdraw | Payouts net of platform and author fees; stake back if no arbitration |
| Arbiter | Named by author | Rule 0 to 100% while in Dispute | Arbitration fee net of platform fee, only if they ruled |
| DAO (Timelock) | The jurisdiction | Veto any non-closed project, overrule a ruling inside the appeal window (or a silent arbiter), set parameters | Platform fees and forfeited arbitration fees go to the Registry (treasury) |
| DAO member | Anyone who can propose in the Governor | Appeal by proposing a `daoOverrule` | |

## Stages

```
Open --setParties--> Pending --signContract--> Ongoing
                                                 |-- backers reach release quorum --> Closed (100% to contractor)
                                                 |-- contractor reimburse() -------> Closed (0% to contractor)
                                                 |-- backers reach dispute quorum -+
                                                 '-- disputeAsContractor() --------+--> Dispute
Dispute --arbitrate--> Appealable --finalizeArbitration (after appeal window)--> Closed
Dispute (arbiter silent past appealPeriod) --daoOverrule (Timelock)--> Closed
Appealable (inside the appeal window) --daoOverrule (Timelock)--> Closed
                             '--finalizeArbitration (after window)--> Closed
Dispute --arbitrationPeriodExpired (arbitrationTimeout)--> Closed (full refund, no fee)
any stage except Closed --daoVeto (Timelock)--> Closed (refund of what is still held, less the platform fee)
```

If the contractor and arbiter are both passed to `createProject`, the project starts in Pending (cooling-off starts at creation). Otherwise it starts in Open.

### Who can call what

| Function | Caller | Stage | Effect |
|----------|--------|-------|--------|
| `setParties(contractor, arbiter, termsHash)` | Author | Open | Sets parties, starts cooling-off, moves to Pending |
| `sendFunds` / `sendFundsWithImmediate(bps)` | Anyone | Open, Pending | Adds funds; `bps <= maxImmediateBps` is paid out at signing (see [immediate-release.md](immediate-release.md)). Native: `msg.value`, also plain transfers via `receive()`. ERC20: `(amount)` / `(amount, bps)`, pulled with `safeTransferFrom` |
| `withdrawAsContributor()` | Backer | Open, Pending | Full refund of everything contributed |
| `signContract()` | Contractor | Pending, after cooling-off, `projectValue > 0`, not held by a DAO proposal | Fixes the arbitration fee, takes the contractor's half as stake (NativeProject refunds anything sent above it), pays out the immediate portion, moves to Ongoing |
| `voteToReleasePayment()` / `voteToDispute()` | Backer with locked funds | Ongoing | Weight = backer's locked amount; switching sides moves the weight. Closes or disputes when quorum is reached |
| `disputeAsContractor()` | Contractor | Ongoing | Moves to Dispute |
| `reimburse()` | Contractor | Ongoing | Closes with 0% to contractor (backers get locked funds back) |
| `arbitrate(percent, rulingHash)` | Arbiter | Dispute | Records ruling, opens the appeal window (`appealPeriod`), moves to Appealable |
| `registerDaoProposal(targets, values, calldatas, descriptionHash)` | Anyone (the indexer does it on `ProposalCreated`) | Pending until cooling-off ends, Dispute until `arbitrationDeadline`, Appealable until `appealEnds` | Registers a live proposal that calls `daoVeto` or `daoOverrule` on this project, so it holds (see [DAO proposal holds](#dao-proposal-holds)) |
| `daoOverrule(percent, rulingHash)` | Timelock (an executed proposal) | Appealable inside the window (or after it, once an overrule was registered in time), or Dispute once `appealPeriod` has passed with no ruling | Finalizes with the DAO's percentage |
| `finalizeArbitration()` | Anyone | Appealable, after window, not held | Finalizes with the arbiter's ruling (0% if the arbiter never ruled) |
| `arbitrationPeriodExpired()` | Anyone | Dispute, after `arbitrationDeadline`, not held | Closes with full refund of locked funds, no arbitration fee |
| `daoVeto()` | Timelock | Any but Closed | Closes with 0% to contractor; the platform fee on the refund goes to the treasury |
| `withdrawAsContractor()` | Contractor | Closed | Pays `availableToContractor` through the fee path |
| `withdrawAsContributor()` | Backer | Closed | Pays the backer's exit amount once (`contributorSettled`) |
| `reclaimArbitrationStake()` | Contractor | Closed, arbitration fee not paid out | Returns the stake, emits `ArbitrationStakeReclaimed` |
| `sweepOrphanedTokens(token)` | Timelock | Any (ERC20Project only) | Sends tokens above `escrowed` (what the project still owes) to the Registry |

### Cooling-off

`coolingOffPeriodEnds = now + economy.coolingOffPeriod()`, set by `setParties` or at creation when parties are named.

Cooling-off does not have to fit a proposal lifecycle: a veto proposal registered on the project before it ends holds signing until the proposal could last land (see [DAO proposal holds](#dao-proposal-holds)). It is the backers' time to withdraw, never shorter than `minCoolingOffPeriod`, which the deployer fixes before the DAO takes over (`EconomySetup` applies its own: 1 day, or 60 seconds on a local chain). `setCoolingOffPeriod` reverts below it. The value is fixed per project when cooling-off starts; later parameter changes do not affect it. Funding during Pending does not extend cooling-off, and backers can still withdraw in full until the contract is signed.

### DAO proposal holds

A project waits for its DAO (`contracts/DaoProposalHold.sol`). `registerDaoProposal(targets, values, calldatas, descriptionHash)` is permissionless. The project checks that the calls veto or overrule this project and, through the Governor's `hashProposal` and `state`, that the proposal is live. Registration is open only inside a window:

| Stage | Window | Holds |
|-------|--------|-------|
| Pending | until `coolingOffPeriodEnds` | `signContract` |
| Dispute | until `arbitrationDeadline` | `arbitrationPeriodExpired` |
| Appealable | until `appealEnds` | `finalizeArbitration` |

In any other stage it reverts ("Nothing to hold in this stage"), and after the window too ("The window to hold this project has closed"). A veto still lands at any time before the project closes; only a veto registered in time holds signing.

The project keeps one timestamp, `heldUntil`: the latest moment any registered proposal could land, taken from the proposal itself at registration. For a proposal not yet queued it is `proposalDeadline + GRACE + timelock minDelay + GRACE`; for a queued one, `eta + GRACE` (`GRACE = 1 day`). Registering again, or registering more proposals, only ever raises it to the latest. The held calls revert with "A DAO proposal about this project is pending" until `block.timestamp > heldUntil`. The hold doesn't end early when a proposal fails: once anyone files, the project waits the full time. That is the accepted cost of keeping no list, so no number of filings can block a real appeal or cost gas to check. A registered overrule (in Dispute or Appealable) lands even after the appeal window (`overruleFiled`). It emits `DaoProposalRegistered(proposalId, overrule, heldUntil)`; `heldByDao()` and `heldUntil()` expose the state.

The indexer registers these proposals when it sees `ProposalCreated`, paying gas from `INDEXER_RELAYER_KEY` (on localhost, hardhat's public account #9). If the indexer is down, anyone can register.

### Backer votes

- Weight is the backer's locked amount; immediate funds carry no vote.
- Quorum is measured against `totalLocked`: the action fires when `votes * 10000 >= totalLocked * backersVoteQuorumBps`. Default 7000 (70%), settable within 50% to 99%.
- Release quorum sets `availableToContractor = totalLocked` and closes. Dispute quorum moves to Dispute.

### Arbitration and appeals

| Item | Value |
|------|-------|
| Arbitration fee | `totalLocked * arbitrationFeeBps / 10000`, fixed at signing. Set at deployment (`EconomyParams.arbitrationFeeBps`), changeable by `setArbitrationFee`, at most 25% |
| Contractor stake | `arbitrationFee / 2`, paid at signing (Native: `msg.value >= stake`; ERC20: exactly `stake` pulled) |
| Backers' share | `arbitrationFee - arbitrationFee / 2`, taken from the locked pool only if arbitration is finalized |
| Appeal window | `appealPeriod`, default 7 days, fixed at the ruling, no floor. An overrule registered inside it holds finalization until it could last land |
| Arbiter exclusive window | The DAO can only rule on a silent arbiter's dispute after `disputeStarted + appealPeriod` |
| Arbitration timeout | `arbitrationTimeout`, default 30 days, set by `setArbitrationTimeout` and fixed per project when the dispute starts (`arbitrationDeadline`) |

On finalization (`finalizeArbitration` or `daoOverrule`):

```
pool                  = totalLocked - backersArbShare
availableToContractor = pool * percent / 100
backer exit           = pool * (100 - percent) / 100 * backerLocked / totalLocked
```

The full arbitration fee (stake plus backers' share) goes to the arbiter through the fee path (platform fee, no author fee) if the arbiter ruled. If the arbiter never ruled (the DAO ruled from Dispute), the whole fee goes to the Registry and the stake is lost. A veto or the arbitration timeout skips arbitration accounting: nobody pays the fee and the contractor reclaims the stake.

The appeal flow lives entirely in the DAO: a member creates a Governor proposal calling `project.daoOverrule(percent, reasoning)`; once it is registered on the project before the window closes (the indexer does this, or anyone with `registerDaoProposal`), the ruling can't finalize until the proposal could last land, and if it passes and executes it replaces the ruling, even after the window. Otherwise anyone can finalize with the arbiter's ruling once the window closes. The indexer also sets `appealProposalId` on the project, so trustless.business can show the appeal as underway. See [governance.md](governance.md) for proposal timing.

## Money flows

### Fee path

Every payout that accrues reputation goes through `_payWithFees(payee, amount, withAuthorFee)`:

```
platformFee = amount * platformFeeBps / 10000            -> Registry (treasury)
authorFee   = (amount - platformFee) * authorFeeBps / 10000 -> author   (contractor payouts only)
net         = amount - platformFee - authorFee           -> payee
```

| Payout | Platform fee | Author fee | REP accrues to |
|--------|--------------|------------|----------------|
| Immediate release at signing | yes | yes | contractor (net), author (fee) |
| Escrow release (`withdrawAsContractor`) | yes | yes | contractor (net), author (fee) |
| Arbitration fee to arbiter | yes | no | arbiter (net) |
| Backer refunds, stake return, forfeited fee | no | no | none |

The platform fee floor is `MIN_PLATFORM_FEE_BPS = 100` (1%), ceiling 50%. Since every REP-earning payout pays it, the floor is the minimum price of REP and makes wash trading (fund yourself, release or reimburse) cost real money (`test/security.test.js`). Platform fees are sent straight to the Registry; `Economy.withdrawNative()` / `withdrawTokens()` (Timelock only) just sweep anything sent to the Economy itself into the Registry.

### Outcomes for locked funds

| Outcome | Contractor gets (gross, before fees) | Backers get back | Arbiter | Stake |
|---------|-------------------------------------|------------------|---------|-------|
| Release quorum | `totalLocked` | 0 | none | reclaimable |
| `reimburse()` | 0 | all locked | none | reclaimable |
| Arbitration finalized at p% | `pool * p%` | `pool * (100-p)%` pro rata by locked | full fee (net of platform fee), or Registry if no ruling | used for the fee |
| Arbitration timeout | 0 | all locked | none | reclaimable |
| `daoVeto()` after signing | 0 | all locked, less the platform fee | none (even if it already ruled) | reclaimable |
| `daoVeto()` before signing | n/a | everything, including immediate portions, less the platform fee | none | none taken |

On a veto the platform fee (`platformFeeBps`, kept as `vetoFeeBps`) is taken from every backer's refund and sent to the treasury at once, so a frivolous project still costs something. Immediate funds paid at signing are never clawed back. Every outcome refunds them only if the contract was never signed (`immediateReleased == 0`).

### Worked example

10,000 contributed by one backer, 20% immediate, `arbitrationFeeBps = 1000`, platform and author fees 1%.

At signing: locked 8,000, arbitration fee 800, contractor stakes 400. Immediate 2,000 pays 20 platform fee, 19.80 author fee, 1,960.20 to the contractor.

| | Release quorum | Arbitration at 60% |
|---|---|---|
| Contractor escrow payout (gross) | 8,000 | (8,000 - 400) * 60% = 4,560 |
| Platform fee on it | 80 | 45.60 |
| Author fee on it | 79.20 | 45.14 |
| Contractor net (escrow) | 7,840.80 | 4,469.26 |
| Arbiter | 0 | 800 - 8 platform fee = 792 |
| Backer refund | 0 | 7,600 * 40% = 3,040 |
| Contractor stake | 400 returned | spent on the fee |
| Backer spending (REP basis) | 10,000 | 6,960 |

## Reputation

The Economy keeps the ledger; `EconomyRepClaim` mints REP from it as a RepToken minter (granted on attach, revoked on detach).

- Earnings: each project calls `economy.updateEarnings(payee, net, token)` for the contractor's net, the author fee, and the arbiter's net. Token is `NATIVE_CURRENCY` (`0xEeee...EEeE`) for native projects.
- Spending: projects call `registerBacker(backer)` on a backer's first contribution, which adds the project to `projectsAsBacker[backer]` once. `projectToken[project]` records its payment token. Each project exposes `spentBy(backer) = total - exit` once Closed (0 before). `Economy.getUser()` sums `spentBy` over all backed projects per token, so spending accrues at close without the backer withdrawing, and withdrawing (`contributorSettled`) does not double count. A backer who withdraws before signing spends 0.
- The legacy `updateSpendings` callback and `spendings` mapping remain and are included in `getUser()`, but current projects do not call them.
- Claiming: `EconomyRepClaim.claim()` reads `getUser(msg.sender)` and mints `amount * parity / 1e18` for each token's unclaimed delta, where parity is the Registry value `jurisdiction.parity.<lowercase token address>`. No parity set means no REP for that token. Watermarks are `claimedEarnings[user][token]` and `claimedSpendings[user][token]` on the claim contract, so each earning and spending counts once per Economy; `claimable(user)` previews. Emits `ReputationClaimedFromEconomy(user, amount)`. See [registry-settings.md](registry-settings.md).

What a backer spends includes immediate funds paid out and their share of the arbitration fee; refunds are excluded.

## Economy contract

### Creating projects

```solidity
createProject(name, contractor, arbiter, termsHash, repo, description) payable   // NativeProject
createERC20Project(name, contractor, arbiter, termsHash, repo, description, token) // ERC20Project
```

- Caller needs `repToken.balanceOf(caller) >= projectThreshold` (REP balance, not votes). The DAO addresses and implementation must be set.
- `msg.value` on `createProject` becomes the author's locked contribution (0% immediate). ERC20 projects start unfunded.
- Pass `address(0)` for contractor and arbiter to start in Open; pass both to start in Pending.
- Emits `NewProject(contractAddress, projectName, contractor, arbiter, termsHash, repo, description, token)` (token is `address(0)` for native).
- Roles are indexed in `projectsAsAuthor`, `projectsAsContractor`, `projectsAsArbiter`; projects in `deployedProjects` and `isProjectContract`.

### Admin and governance

`onlyGovernance`: before `setDaoAddresses` the `admin` may call setters; after, only the Timelock. `admin` is the deployer (`EconomySetup`); `transferAdmin` only works before DAO addresses are set. `setDaoAddresses(timelock, registry, governor, repToken)` is admin-only and one-time. `EconomySetup(nativeImpl, erc20Impl, minCoolingOffPeriod)` holds the implementations and the cooling-off minimum. `prepareInstallation(core, data)` applies the minimum (`setMinCoolingOffPeriod`, admin-only and only before the DAO addresses are set), decodes `EconomySetup.Params { arbitrationFeeBps, platformFeeBps, authorFeeBps, coolingOffPeriod, backersQuorumBps, projectThreshold, appealPeriod }`, sets the implementations it holds and those parameters, then sets the DAO addresses in the same transaction, so from then on only DAO proposals can change anything.

| Setter | Bounds | Default |
|--------|--------|---------|
| `setPlatformFee(bps)` | 100 to 5000 | 100 |
| `setAuthorFee(bps)` | at most 2500 | 100 |
| `setArbitrationFee(bps)` | none | constructor argument |
| `setMinCoolingOffPeriod(s)` | admin only, before `setDaoAddresses`; raises `coolingOffPeriod` if below | 1 day |
| `setCoolingOffPeriod(s)` | at least `minCoolingOffPeriod` | 1 day |
| `setBackersVoteQuorum(bps)` | 5000 to 9900 | 7000 |
| `setProjectThreshold(n)` | none | 0 |
| `setAppealPeriod(s)` | none | 604800 (7 days) |
| `setMaxImmediateBps(bps)` | 0 to 5000 | 2000 |
| `setImplementations(native, erc20)` | none | unset |

Projects read parameters live, except cooling-off end and arbitration fee, which are fixed when set. Details and proposal examples: [registry-settings.md](registry-settings.md).

### Views

`getConfig()` returns all addresses, parameters, implementations and project count. `getUser(addr)` returns earned tokens/amounts, spent tokens/amounts (including backed projects), and role lists. Each project has `getProjectDetails()`.

## Events

Economy: `NewProject`, `DaoAddressesSet`, `AdminTransferred`, `MinCoolingOffPeriodSet`, `PlatformFeeSet`, `AuthorFeeSet`, `ArbitrationFeeSet`, `CoolingOffPeriodSet`, `BackersVoteQuorumSet`, `ProjectThresholdSet`, `AppealPeriodSet`, `MaxImmediateBpsSet`, `InboundValue`.

Projects: `SetParties`, `SendFunds(who, amount, immediateBps)`, `ContractSigned`, `ImmediateFundsReleased(contractor, net)`, `BackerVoteCast(voter, power, forDispute)`, `ProjectDisputed`, `ArbitrationDecision`, `DaoProposalRegistered(proposalId, overrule)`, `DaoOverruled`, `ArbitrationFinalized`, `VetoedByDao`, `ProjectClosed`, `ContractorPaid(contractor, net)`, `AuthorPaid`, `ContributorWithdrawn`, `ArbitrationStakeReclaimed(contractor, amount)`, and on ERC20Project `OrphanedTokensSwept`.

## Tests

| File | Covers |
|------|--------|
| `test/project-lifecycle.test.js` | Happy path (ERC20), dispute path (native), vote switching, `projectThreshold` |
| `test/arbitration-accounting.test.js` | Every outcome's payouts, immediate release with disputes, multiple backers, zero leftover balance |
| `test/appeals.test.js` | Direct DAO overrule, finalize after window, late and early overrule rejected, silent-arbiter ruling, `receive()`, ERC20 sweep before and after payouts, refund of excess native stake |
| `test/backer-spending.test.js` | `spentBy`, no double counting, reimburse, pre-signing veto refund, one listing per backed project |
| `test/economy-rep-claim.test.js` | EconomyRepClaim: first claim, no double claim, incremental claims, earnings plus spendings, parity changes |
| `test/dao-proposal-hold.test.js` | Registered veto holds signing, grace for unqueued proposals, overrule holds finalization and lands after the window, rejected registrations, cooling-off minimum |
| `test/security.test.js` | Factory binding, court and tool appeal-window floor, platform fee floor, wash-trading cost |
