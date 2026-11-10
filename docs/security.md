# Security Model

Threats the suite is designed against, the mitigation for each, and where it lives in code. Each row was checked against the current source. API details are in [technical-reference.md](technical-reference.md); Autonet trust assumptions are in [autonet.md](autonet.md).

An internal audit and a test plan exist; both are kept private.

## Threats and mitigations

### Governance

| Threat | Mitigation | Where |
|--------|-----------|-------|
| Vote buying | RepToken is non-transferable: `transfer`/`transferFrom` always revert, and `JurisdictionFactory` makes no other token, so a direct factory call can't get around it | `RepToken.sol`, `JurisdictionFactory` |
| Flash-loan voting | Voting power is read at the proposal snapshot (`getPastVotes`, timestamp clock). Reward epochs use the snapshot one second before the epoch starts | OZ `Governor`, `RepToken.rewardOf` |
| Malicious proposal | Every action runs through `TimelockController` with a minimum delay; only the governor holds `PROPOSER_ROLE` | `JurisdictionFactory.finalize`, `Dao.sol` |
| Factory keeps control | `finalize` hands token `admin` and Registry `owner` to the timelock and revokes the factory's `DEFAULT_ADMIN_ROLE` on the timelock in the same transaction that attaches the modules. The Registry has no `wrapper` | `JurisdictionFactory.finalize` |
| **Deployment hijack** (someone finalizes a half-deployed core with their own modules, keys or governor) | `deployCore` records the pending core under its Registry, bound to `msg.sender`. `finalize` requires the caller to be that originator (`NotOriginator`) and all four core addresses to match (`WrongCore`); each module must be prepared for that core | `JurisdictionFactory.finalize`; `test/security.test.js` "JurisdictionFactory deployment binding" |
| **Malicious module** | Only setups published in `ModuleCatalog` attach (`NotPublished`); `finalize` executes a module's actions only against that DAO's own token and Registry (`ForeignTarget`); after origination every grant is listed in the attach proposal. The catalog curator and repo maintainers are the trust root | `ModuleProcessor.checkInstall`, `JurisdictionFactory.finalize`; [modules.md](modules.md#trust) |
| **Economy admin outlives setup** | `onlyGovernance` accepts `admin` only while `timelockAddress == 0`. `setDaoAddresses` can run once and requires a non-zero timelock; `EconomySetup` calls it in the same transaction that deploys the Economy, so afterwards only the timelock can configure. `transferAdmin` is disabled once the timelock is set | `Economy.sol`, `EconomySetup`; `test/security.test.js` "hands a prepared economy to the timelock in the same transaction" |
| Minting outside governance | `RepToken.mint` requires `admin` (the timelock) or an explicit `minters` entry, which only the admin or timelock can grant. RepToken has no built-in Economy path: economy REP comes from the `EconomyRepClaim` minter granted when the module attaches | `RepToken.setMinter` |
| Treasury drained by a captured vote | Optional per-token rolling-window spend cap on `transferETH`, `transferERC20` and `disburseEarmarked` (fixed window: worst case 2x the cap across a boundary) | `Registry._meterSpend`; `test/treasury-spend-guard.test.js` |
| Reward budget overspent or reused | Epoch budgets are earmarked in the Registry when the epoch starts; earmarks cannot exceed unreserved balance and ordinary transfers cannot touch reserved funds; each account claims once per epoch | `Registry.earmarkFunds`, `_requireUnreserved`, `RepToken.claimReward` |
| Sybil delegation for rewards | Not guarded on chain, by design: a member can delegate to their own second wallet and earn from both pools. Each jurisdiction handles it through its code of conduct and REP burns by constitutional proposal. Delegates are paid only for weight received from others, above the bar; an Autonet operator's owner delegating to it counts as the household's own | `RepToken.rewardOf` |

### Trustless economy

| Threat | Mitigation | Where |
|--------|-----------|-------|
| **Contractor signs before the DAO can react** | Anyone (the indexer on `ProposalCreated`) registers a live veto proposal on the project with `registerDaoProposal` before cooling-off ends, checked against the Governor's `hashProposal`; `signContract` reverts until the proposal could last land (its deadline, a day to queue, the timelock delay, a day to execute), so a stalled DAO can't hold forever and no number of filings blocks another. Cooling-off is never below `minCoolingOffPeriod`, fixed before the hand-over | `DaoProposalHold`, projects `registerDaoProposal`, `signContract`; `Economy.setMinCoolingOffPeriod`; `test/dao-proposal-hold.test.js` |
| **Wash trading for free reputation** | Every reputation-accruing payout pays the platform fee to the treasury first. `setPlatformFee` enforces a floor `MIN_PLATFORM_FEE_BPS = 100` (1%) and a ceiling of 5000 (50%), so REP always has a price. `EconomySetup` goes through the same setter | `Economy.setPlatformFee`, `_payWithFees`; `test/security.test.js` "Reputation farming" |
| Bad arbitration | Ruling enters `Appealable`; the DAO overrules by proposal. An overrule registered inside the appeal window holds `finalizeArbitration` until it could last land and lands even after the window. Registration verifies the proposal with `hashProposal` and `state`, so caller-supplied data can't fake one; the project keeps only the latest end, so there is no list to fill or loop over. ToolBond holds a round the same way, for an overrule naming that round. Court verdicts can't hold, so the court's window is floored at a proposal lifecycle plus two days | projects and ToolBond `registerDaoProposal`, `daoOverrule`; `ProposalLifecycle.appealWindow` (ContentCourt) |
| Absent arbiter | After `arbitrationDeadline` (the Economy's `arbitrationTimeout`, default 30 days, fixed when the dispute starts), anyone can close the project with a full refund, unless a DAO proposal registered before the deadline still holds it, so the close can't front-run an overrule; an arbiter who never ruled forfeits the fee to the treasury | `arbitrationPeriodExpired`, `_finalizeDispute` |
| Harmful project | The timelock can `daoVeto` any non-closed project; backers get their locked funds back (and immediate funds if unsigned), less the platform fee, which goes to the treasury so frivolous projects cost something | `daoVeto`, `_closedExit` |
| Fake ledger writes | `updateEarnings`, `updateSpendings`, `registerBacker`, `registerProjectRoles` accept calls only from clones the Economy deployed (`isProjectContract`) | `Economy.sol` |
| Reward claims cut short | Jurisdiction earmarks (reward epochs) cannot be released with `withdrawEarmarkedFunds`; only `reclaimEarmarkedFunds`, after the grace period | `Registry.rewardEarmark` |
| Double withdrawal | Contractor payout is zeroed before transfer; backers are marked `contributorSettled`; the arbitration stake is reclaimable once and only if it did not pay the arbiter | projects |
| Non-standard ERC20s (no return value) | `Registry`, `Economy`, `ERC20Project`, `AutonetVault` use `SafeERC20` | see caveats |
| Reentrancy | `Registry` (`transferETH`, `transferERC20`, `disburseEarmarked`), `AutonetVault.buy` are `nonReentrant`. Project clones have no guard and follow checks-effects-interactions | `test/autonet-vault.test.js` (with `ReentrantPaymentToken`) |

### Autonet satellites

| Threat | Mitigation | Where |
|--------|-----------|-------|
| Vault custody risk | Payment moves buyer to Registry in one `safeTransferFrom`; the vault holds neither funds nor ATN | `AutonetVault.buy` |
| Unbacked ATN | ATN is minted only on the external Substrate, which gates `mintFromVault` to the vault address fixed in its constructor | Substrate (autonet repo) |
| Parity mispricing | Parity is a Registry key editable only by the timelock; the vault can be paused by its admin (the timelock) | `Registry`, `pause()` |
| REP double count | `AutonetRepClaim` mints only the delta over a per-agent watermark on monotonic Substrate ledgers; `EconomyRepClaim` likewise per user and token | `claimedEarnings` (both), `EconomyRepClaim.claimedSpendings` |
| Malicious tool | The framework rates tools, it doesn't contain them: each household decides from the ratings. Epoch reviews are committed hidden and weighed by REP at the epoch's start, so REP can't be gathered mid-review and nobody can copy a tally; withheld batches lose their REP penalty. Once the anchored close names a tool concluded, more than half the reviewing REP saying malware slashes that share of the author's bond to the treasury and burns that share of their REP at once; the DAO can clear any verdict by ordinary proposal (the burned REP goes back, the treasury repays the bond) or designate any bonded tool malware (its whole bond to the treasury); the bond can't be withdrawn while more than half the reviewing REP says malware before the tool concludes; slashes move ATN and REP and never create them | `ToolBond`, `RepToken.slash`/`reassign` |

## Known caveats

- Fee-on-transfer payment tokens would short the treasury in the vault; they are excluded socially when governance sets parity.
- Standard DAOs created by factory builds that passed `address(this)` as the RepToken timelock (including standard DAOs created on Shadownet before the 2026-10-12 redeploy) cannot call `startPassiveEpoch`, `startDelegateEpoch` or `setDelegateBar`. `JurisdictionFactory` passes the real timelock for every DAO; economy DAOs were never affected. See [technical-reference.md](technical-reference.md#reptoken).
- DAOs created by the old standard factories (the live Shadownet suite) have the factory as their Registry `wrapper` and so it keeps registry edit rights; the factory exposes no function that uses them after deployment. `JurisdictionFactory` sets no wrapper.
- Timelock delay can be configured to zero (test networks do this), which removes the review window between a passed proposal and its execution.
- Holds depend on someone registering the proposal inside its window. If the indexer is down and nobody calls `registerDaoProposal`, a contractor can sign once cooling-off ends, or a ruling can finalize once the window closes, before the vote does. The indexer registers on projects only; ToolBond overrules need someone to register them.
- Once anyone registers a proposal, the hold lasts until it could last land even if it fails early, so any member able to propose can delay a signing or a finalization by one proposal lifecycle and two days. Accepted, since the alternative (a list) lets filings block a real appeal or cost unbounded gas.
- The hold is fixed from the proposal and the timelock delay at registration. A later rise in the timelock delay before the proposal is queued can let finalization open before it lands.
