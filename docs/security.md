# Security Model

Threats the suite is designed against, the mitigation for each, and where it lives in code. Each row was checked against the current source. API details are in [technical-reference.md](technical-reference.md); Autonet trust assumptions are in [autonet.md](autonet.md).

An internal audit and a test plan exist; both are kept private.

## Threats and mitigations

### Governance

| Threat | Mitigation | Where |
|--------|-----------|-------|
| Vote buying | RepToken is non-transferable by default: `transfer`/`transferFrom` revert unless `isTransferable`. `JurisdictionFactory` deploys a transferable token only for `TokenKind.Transferable` | `RepToken.sol`, `JurisdictionFactory` |
| Flash-loan voting | Voting power is read at the proposal snapshot (`getPastVotes`, timestamp clock). Reward epochs use the snapshot one second before the epoch starts | OZ `Governor`, `RepToken.rewardOf` |
| Malicious proposal | Every action runs through `TimelockController` with a minimum delay; only the governor holds `PROPOSER_ROLE` | `JurisdictionFactory.finalize`, `Dao.sol` |
| Factory keeps control | `finalize` hands token `admin` and Registry `owner` to the timelock and revokes the factory's `DEFAULT_ADMIN_ROLE` on the timelock in the same transaction that attaches the modules. The Registry has no `wrapper` | `JurisdictionFactory.finalize` |
| **Deployment hijack** (someone finalizes a half-deployed core with their own modules, keys or governor) | `deployCore` records the pending core under its Registry, bound to `msg.sender`. `finalize` requires the caller to be that originator (`NotOriginator`) and all four core addresses to match (`WrongCore`); each module must be prepared for that core | `JurisdictionFactory.finalize`; `test/security.test.js` "JurisdictionFactory deployment binding" |
| **Malicious module** | Only setups published in `ModuleCatalog` attach (`NotPublished`); `finalize` executes a module's actions only against that DAO's own token and Registry (`ForeignTarget`); after origination every grant is listed in the attach proposal. The catalog curator and repo maintainers are the trust root | `ModuleProcessor.checkInstall`, `JurisdictionFactory.finalize`; [modules.md](modules.md#trust) |
| **Economy admin outlives setup** | `onlyGovernance` accepts `admin` only while `timelockAddress == 0`. `setDaoAddresses` can run once and requires a non-zero timelock; `EconomySetup` calls it in the same transaction that deploys the Economy, so afterwards only the timelock can configure. `transferAdmin` is disabled once the timelock is set | `Economy.sol`, `EconomySetup`; `test/security.test.js` "hands a prepared economy to the timelock in the same transaction" |
| Minting outside governance | `RepToken.mint` requires `admin` (the timelock) or an explicit `minters` entry, which only the admin or timelock can grant. RepToken has no built-in Economy path: economy REP comes from the `EconomyRepClaim` minter granted when the module attaches | `RepToken.setMinter` |
| Treasury drained by a captured vote | Optional per-token rolling-window spend cap on `transferETH`, `transferERC20` and `disburseEarmarked` (fixed window: worst case 2x the cap across a boundary) | `Registry._meterSpend`; `test/treasury-spend-guard.test.js` |
| Reward budget overspent or reused | Epoch budgets are earmarked in the Registry when the epoch starts; earmarks cannot exceed unreserved balance and ordinary transfers cannot touch reserved funds; each account claims once per epoch | `Registry.earmarkFunds`, `_requireUnreserved`, `RepToken.claimReward` |
| Sybil delegation for rewards | A delegator keeps `1 - delegateShareBps` of its share and the delegate earns the rest, so delegating to one's own second wallet gains nothing | `RepToken.rewardOf` |

### Trustless economy

| Threat | Mitigation | Where |
|--------|-----------|-------|
| **Contractor signs before the DAO can react** | Cooling-off is `max(coolingOffPeriod, votingDelay + votingPeriod + timelock minDelay + 1 day)`, applied both in `setParties` and to parties named at creation. The jurisdiction can always run and execute a full veto proposal before signing is possible | `Economy.effectiveCoolingOffPeriod`, `NativeProject/ERC20Project.initialize`, `setParties`; `test/security.test.js` |
| **Wash trading for free reputation** | Every reputation-accruing payout pays the platform fee to the treasury first. `setPlatformFee` enforces a floor `MIN_PLATFORM_FEE_BPS = 100` (1%) and a ceiling of 5000 (50%), so REP always has a price. `EconomySetup` goes through the same setter | `Economy.setPlatformFee`, `_payWithFees`; `test/security.test.js` "Reputation farming" |
| Bad arbitration | Ruling enters `Appealable`; the DAO overrules by proposal. The appeal window is floored at a proposal lifecycle plus two days, so no on-chain appeal registration (and no caller-supplied proposal data) is needed | `Economy.effectiveAppealPeriod`, projects `daoOverrule` |
| Absent arbiter | After `ARBITRATION_TIMEOUT` (150 days) in `Dispute`, anyone can close the project with a full refund; an arbiter who never ruled forfeits the fee to the treasury | `arbitrationPeriodExpired`, `_finalizeDispute` |
| Harmful project | The timelock can `daoVeto` any non-closed project; backers get their locked funds back (and immediate funds if unsigned) | `daoVeto`, `_closedExit` |
| Fake ledger writes | `updateEarnings`, `updateSpendings`, `registerBacker`, `registerProjectRoles` accept calls only from clones the Economy deployed (`isProjectContract`) | `Economy.sol` |
| Reward claims cut short | Jurisdiction earmarks (reward epochs) cannot be released with `withdrawEarmarkedFunds`; only `reclaimEarmarkedFunds`, after the grace period | `Registry.rewardEarmark` |
| Double withdrawal | Contractor payout is zeroed before transfer; backers are marked `contributorSettled`; the arbitration stake is reclaimable once and only if it did not pay the arbiter | projects |
| Non-standard ERC20s (no return value) | `Registry`, `Economy`, `ERC20Project`, `AutonetVault`, `CoinOffering` use `SafeERC20` | see caveats |
| Reentrancy | `Registry` (`transferETH`, `transferERC20`, `disburseEarmarked`), `AutonetVault.buy`, `CoinOffering.buy` are `nonReentrant`. Project clones have no guard and follow checks-effects-interactions | `test/autonet-vault.test.js`, `test/coin-offering.test.js` (with `ReentrantPaymentToken`) |

### Autonet satellites

| Threat | Mitigation | Where |
|--------|-----------|-------|
| Vault custody risk | Payment moves buyer to Registry in one `safeTransferFrom`; the vault holds neither funds nor ATN | `AutonetVault.buy` |
| Unbacked ATN | ATN is minted only on the external Substrate, which gates `mintFromVault` to the vault address fixed in its constructor | Substrate (autonet repo) |
| Parity mispricing | Parity is a Registry key editable only by the timelock; the vault and CO can be paused by their admin (the timelock) | `Registry`, `pause()` |
| REP double count | `AutonetRepClaim` mints only the delta over a per-agent watermark on monotonic Substrate ledgers; `EconomyRepClaim` likewise per user and token | `claimedEarnings` (both), `EconomyRepClaim.claimedSpendings` |
| Malicious tool | Nodes run only bonded tools, by default only vetted ones; REP-weighted commit-reveal flags settle a verdict (snapshot weights, so REP can't be gathered mid-review), the DAO can overrule within the appeal window, and on malware the finder and red flaggers take the stake and the author's slashed REP; slashes move REP and never create it | `ToolBond`, `RepToken.slash`/`reassign` |
| CO oversells | `saleCap` enforced on every buy and cannot be set below `totalMinted` | `CoinOffering` |

## Known caveats

- Fee-on-transfer payment tokens would short the treasury in the vault and CO; they are excluded socially when governance sets parity.
- Standard DAOs created by factory builds that passed `address(this)` as the RepToken timelock (including standard DAOs created on Shadownet before the 2026-10-12 redeploy) cannot call `startNewRewardEpoch` or `setDelegateShareBps`. `JurisdictionFactory` passes the real timelock for every DAO; economy DAOs were never affected. See [technical-reference.md](technical-reference.md#reptoken).
- DAOs created by the old standard factories (the live Shadownet suite) have the factory as their Registry `wrapper` and so it keeps registry edit rights; the factory exposes no function that uses them after deployment. `JurisdictionFactory` sets no wrapper.
- DAOs on a WrappedRepToken can't take modules: the RepToken grant actions revert.
- Timelock delay can be configured to zero (test networks do this), which removes the review window; the cooling-off floor then shrinks to the voting delay plus period plus the one-day buffer.
