# Autonet Integration

How a jurisdiction (the DAO suite in this repo) attaches to the Autonet network.

The Autonet network's economics live on its own **Substrate** contract in the autonet repo ([github.com/autonet-code/node](https://github.com/autonet-code/node), `contracts/core/Substrate.sol`). **ATN is minted and accounted there, never in this repo.** The old jurisdiction-local `Autonet.sol` token was deleted. What remains here is a set of small satellite contracts that either sell Substrate ATN into the DAO treasury or turn Substrate activity into governance weight (RepToken).

Related: [architecture.md](architecture.md), [governance.md](governance.md), [registry-settings.md](registry-settings.md), [technical-reference.md](technical-reference.md), [security.md](security.md), [deployments.md](deployments.md).

## Status at a glance

| Contract | Role | Status (from code and scripts) |
|----------|------|-------------------------------|
| `AutonetVault` | Sells Substrate ATN for whitelisted ERC20s; payment goes to the Registry | **Live.** Deployed on Shadownet and registered under `jurisdiction.autonet.vault` (`scripts/submit-autonet-registry-keys.js`) |
| `AutonetRepClaim` | Mints REP 1:1 against ATN an agent provably earned on the Substrate | **Live.** Granted minter rights by proposal (the 2026-07-10 flag-day proposal on Shadownet); registered under `jurisdiction.autonet.rep_claim` |
| `ToolBond` | ATN bonds behind every tool, and staked epoch reviews that rate tools per charter axis and on harm, with DAO appeal on harm | **Reworked (2026-10-17).** Deployed by `AutonetSetup` with its slasher grant; nodes run tools only while `isBonded`, and judge them by their ratings |
| `CoinOffering` | Sells the jurisdiction's own transferable governance token (ATNB) under a DAO-set cap | **Tested in isolation** (`deployCOLocal.js`, `deployTestCOShadownet.js`, `deployTestCOBaseSepolia.js`). Not part of the Autonet genesis flow |

> New jurisdictions get `AutonetRepClaim` (empty genesis seed) and its minter grant at genesis (see [Genesis](#genesis-autonetsetup)). Jurisdictions that still have the retired ReputationMirror as a minter revoke it by proposal (see [Minter swap](#minter-swap-from-the-retired-mirror)).

## Parity: one registry key, one formula

`EconomyRepClaim` (economy reputation), `CoinOffering` and `AutonetVault` all price payment tokens from the same Registry key:

```
jurisdiction.parity.<lowercase 0x token address>      (native currency: 0xeeee...eeee)
```

The value is a decimal string holding an **18-decimal fixed-point multiplier from payment-token base units into jurisdiction units** (REP base units, 18 decimals). One parity means the same thing everywhere:

```
EconomyRepClaim, CoinOffering:  out = paymentAmount * parity / 1e18        (REP / ATNB, 18 dec)
AutonetVault:                   out = paymentAmount * parity / 1e18 / 1e12  (ATN, 6 dec)
```

1 ATN (1e6 base units) prices like 1 REP (1e18), the same 1:1 that `AutonetRepClaim` uses, so the vault only divides by `REP_PER_ATN_BASE = 1e12`. A USDC parity of `1e30` makes 1 USDC worth 1 REP when earned in a project, 1 ATNB in the coin offering and 1 ATN from the vault.

Absent, empty or `"0"` means the token is not whitelisted (`TokenNotRegistered` in the vault and CO; zero reputation in EconomyRepClaim). Values are parsed with `Strings.parseUint`, so they must be plain integers (`"1000000000000000000"`, not `"1e18"`).

Decimals are not queried. The payment token's decimals are baked into the value:

```
parity = price * 10^(36 - paymentDecimals)       (price in REP, ATNB or ATN per payment token)
```

Examples: 1 USDC (6 dec) to 1 unit: `1e30`; 1 USDC to 2 units: `2e30`; 1 DAI or native (18 dec) to 1 unit: `1e18`. This is the form werule writes (`ValueIndexItem.toRegistryValue`, mirrored in `scripts/e2eLocal.js`).

Jurisdictions attached before 2026-10-12 set vault parities 1e12 lower (the vault did not scale then); re-set them when moving to the current vault.

Integer flooring: a payment that floors to zero output reverts with `DustAmount` in the vault and CO. ATN has fewer decimals than most payment tokens, so dust is more likely there.

## AutonetVault

`contracts/AutonetVault.sol`. A buy-only router modelled on CoinOffering.

- `buy(paymentToken, paymentAmount)`: reads parity, computes `atnOut`, pulls `paymentAmount` from the buyer **straight into the Registry** with `safeTransferFrom`, then calls `IAutonetATN(atnToken).mintFromVault(buyer, atnOut)` on the Substrate. `nonReentrant`, `whenNotPaused`. Emits `AtnPurchased(buyer, paymentToken, paymentAmount, atnOut, parity)`.
- `quote`, `getParity`: views. `totalMinted`, `totalRaised[token]`: counters.
- **Uncapped.** Supply policy lives on the Substrate, not here. No redeem path.
- `admin` (the timelock) can only `pause`, `unpause` and `transferAdmin`. Price and whitelist are Registry edits, which already go through the timelock.

Trust assumptions:

| Assumption | Notes |
|------------|-------|
| Substrate gates `mintFromVault` to this vault | Set as a Substrate **constructor** argument (`VAULT_MINTER`); Substrate has no admin keys, so it cannot be changed later |
| Payment tokens are standard ERC20s | A fee-on-transfer token would credit the buyer more ATN than the treasury received. Enforced socially when governance sets the parity key |
| Registry parity is correct | A mispriced parity sells ATN at the wrong rate until a proposal fixes it; `pause` is the emergency brake |
| The vault never holds funds | Payment moves buyer to Registry in one call; ATN is minted, not held |

## AutonetRepClaim

`contracts/AutonetRepClaim.sol`. REP as a pull claim on ATN provably earned ("voice is always work-backed"). REP goes to households, never to agent keys (autonet decision 2026-10-27, "the owner wallet claims, the daemon operates").

- Earnings base per earner, in ATN base units (1 ATN = 1e6), cumulative and monotonic: `substrate.agentMintTotal(earner)` (tool-pool leaves, which since autonet `bab7712` name household owner wallets and are submitted by anyone with `Substrate.claimFor`). Service revenue (`serviceEarnings`) earns no REP (autonet decision 2026-10-27): at the fee rate it would buy REP by washing payments, while tool-pool mints are capped by fees actually burned. A watermark set while service revenue still counted can sit above the base; nothing is claimable until the base passes it.
- `recipientOf(earner)`: a registered agent's owner wallet, else the earner itself.
- `claim(earner)`: permissionless trigger. Mints `(base - watermark) * 1e12` REP to `recipientOf(earner)` (never the caller) with `RepToken.mintDelegated`, so the household votes its own REP unless it already chose a delegate (typically its daemon's operator key, which is drawn for and votes in anchor elections), and advances the earner's watermark. Reverts `NothingToClaim` on zero delta. Emits `RepClaimed(earner, to, earningsDelta, repMinted)`.
- `claimable(earner)`, `earningsBase(earner)`: views.
- Constants: `ATN_BASE = 1e6`, `REP_DECIMALS = 1e18`, `REP_PER_ATN_BASE = 1e12`. Hardcoded 1:1 in whole tokens; no rate knob, no admin, no pause.
- Constructor optionally mints a genesis REP seed (`genesisHolders`, `genesisAmounts`). That requires the contract to already be a minter, so in practice pass an empty seed and mint the seed by proposal (the Shadownet flag-day proposal minted `1000e18` to a dev wallet).

A revoked agent's earnings still mint to its owner: revocation means the key is lost or misbehaving, so the key gets no governance weight, while the work it did counts for its household (a revoked agent can't rotate its owner).

Trust assumptions: the Substrate's earnings ledgers are honest and monotonic; RepToken grants this contract minter rights. Since autonet `69b5cfe` an epoch is anchored by its AnchorElection: one single-choice proposal per epoch (`docs/governance.md`, options mode), whose winning option the election submits to `Substrate.anchor`. The timelock remains the Substrate's governor, and an epoch can mint at most the service fees burned in the window before it. Proposals are decided as soon as the outcome can't change (docs/governance.md), so an anchor backed by a majority of delegated REP passes in one block plus the timelock delay. Delegating REP to an agent hands it that weight. There is no baseline: an agent's first claim covers all earnings recorded on the Substrate up to that point.

## ToolBond

`contracts/ToolBond.sol`. Every published tool carries its author's ATN bond (any tool runs with the daemon's full authority), and staked reviews rate it. Ratings are a gradient: per tool and per axis ToolBond keeps the REP-weighted rating and the REP mass behind it, and the daemons, agents and their owners decide what is trustworthy enough to run. Harm is rated like an axis; there is no malware flag and no "vetted" state. The DAO is the court of appeal on harm. No arbiter.

- `bond(digest, amount)`: only `Substrate.toolAuthor(digest)`; pulls ATN (approve first). Topping up cancels a pending unbond. The first bond fixes `bondHousehold(digest)`, the author's household, liable for the tool's harm and barred from reviewing it; rotating the author agent's owner later moves neither. `isBonded` needs `stake >= minStake` and no pending unbond. A new version is a new digest with its own bond and ratings.
- `requestUnbond`, then `withdraw`: the tool stops counting at once but stays reviewable. The bond leaves only after `unbondDelay`, after the reveals of the epoch the unbond was requested in, and once every round on the tool is finalized.
- Epochs are the Substrate's: epoch e runs from anchor e-1 (or the Substrate's deployment) to anchor e, so `currentEpoch()` is `anchorCount()`. At an epoch's first commit ToolBond records the charter's sha256 and its axis ids, parsed from `jurisdiction.autonet.charter` (compact JSON, ids of `[a-z0-9_]`, at most 16; anything else gives the epoch no axes), the REP snapshot (the epoch's start) and the supply then (`epochInfo`).
- `commit(commitment, stake, reviews)`: once per agent per epoch, for a hidden batch of `reviews` reviews (public, `reviewCountOf`; the reveal must hold exactly that many), staking any amount of ATN. Needs its household's REP at the snapshot or a stake, so a newcomer can stake in. The commitment is `commitmentOf(epoch, agent, reviews, salt)`.
- Households: REP sits on owner wallets, not agent keys (autonet decision 2026-10-27), so a batch weighs the REP of the committing agent's household (`Substrate.getAgentOwner`, read at commit; an unbound address is its own household; `householdOf(epoch, agent)`). A household weighs once per tool per epoch: among its reviews of a tool, the one from its earliest commit carries the weight and the rest count at zero (`ReviewUnweighted` when a later reveal takes the weight back). Commits are hidden, so their order carries no information, and the order of reveals can't choose which review counts. Every REP slash and reassignment from a review, a forfeit or a harmful tool lands on the household.
- A review is `{digest, scores, harm, stake, evidenceHash}`: one int8 per charter axis (-100..100, or -128 for no score), or none; harm 0 (safe) to 100 (malicious), or 255 for none. `evidenceHash` is daemon-defined and opaque to the contract.
- `reveal(epoch, agent, reviews, salt)`: after anchor e, within `revealWindow`; anyone holding the plaintext can relay it. The stakes must add up to the committed stake. A review that can't count (an unbonded tool, one from the reviewer's own household, a repeat, malformed scores) has its stake refunded without voiding the batch.
- `forfeit(epoch, agent)`: anyone, after the window. A batch never revealed loses its whole stake to the treasury (the Registry) and, per declared review, `degradeBps` of the snapshot REP it weighed, from its household: the most its revealed reviews could have cost, so revealing always beats withholding.
- `finalize(digest, epoch, maxReviews)`: anyone, after the window (batched, call until done). Each review's accuracy is how close it lands to the REP-weighted means of the round's other reviews (its own weight left out, so a lone reviewer is measured against no one and neither gains nor loses): 1 - |score - mean| / 200 per scored axis, 1 - |harm - mean| / 100 for harm (the DAO's H when it overruled), weighted by `harmWeightBps` against an axis's 10000. Each review loses stake x (1 - accuracy) to the round's pool and REP x `degradeBps` x (1 - accuracy). Harm settles only when the REP that scored it reaches `harmQuorumBps` of the epoch's REP supply; below that the round still rates the tool's harm but slashes nothing. A settled harm H above zero first waits out `appealWindow()` (`appealPeriod`, never shorter than one proposal lifecycle plus two days); `daoOverrule(digest, epoch, harm)`, the timelock by proposal, sets H within that window and is final at once. H then slashes H of the bond and H x `authorSlashBps` of the bonding household's REP, never more than the REP that scored harm. A round with no REP behind it settles nothing.
- `claim(digest, epoch, reviewer)`: anyone, for the reviewer. The stake back less losses by plain transfer; a share of the round's losses by stake x accuracy, and of the slashed bond by REP x harm accuracy, through `Substrate.payForService` so only winnings count as service earnings; and a share of the slashed REP by REP x accuracy (`RepToken.reassign`). Payouts never exceed the round's own stakes and slashes: no ATN or REP is created.
- Ratings: `roundAxis(digest, epoch, i)` and `getRound` per round; `toolRating(digest, keccak256(axisId))` and `toolHarm(digest)` over every finalized round, each a sum of REP x score and the REP mass. The daemon's close reads them pinned to the previous anchor and scales the reviewers' share of a tool's mints (`reviewerShareBps`) by novelty.
- Reviews count for any tool with a bond left, including one whose author asked to unbond or whose bond fell below `minStake` after a slash, so asking to leave never escapes a harm finding. `toolHarm` counts an overruled round at the DAO's harm. Epoch 0's REP snapshot is the Substrate's deployment, so genesis REP must exist by then (the core mints it before the module is prepared). `ReviewSettled` and `EpochStarted` carry each review's accuracy and each epoch's axis ids, so the close can work from logs.
- `ToolBond(substrate, rep, registry, governor, timelock, params)`. `setParams(Params)`: timelock only; emits `ParamsSet` and `AppealPeriodSet`. Genesis defaults: 100 ATN bond, 1-day reveal window, degrade 10%, author slash 100%, reviewer share 40%, harm weight 200%, harm quorum 2%, 30-day unbond delay, 10-day appeal period (env `TOOLBOND_*` overrides). The bond needs `RepToken.setSlasher(toolBond, true)`, granted when the module is attached.

Bonds are flat for now; scaling them with a tool's usage is a later step. Bonds are only as sound as ATN itself, which depends on the Substrate's anchors.

## CoinOffering

`contracts/CoinOffering.sol`. Sells ATNB (a transferable RepToken used as the governance token) for whitelisted ERC20s.

- `buy(paymentToken, paymentAmount)`: same parity math and routing as the vault, but mints ATNB via `RepToken.mint` (the CO must be a minter) and enforces `totalMinted + atnbOut <= saleCap` (`CapExceeded`). Emits `TokensPurchased`.
- `setSaleCap(newCap)`: admin only, never below `totalMinted`. `saleCap = 0` (the default) means closed.
- `pause`, `unpause`, `transferAdmin`: admin only. `remaining()` view.
- Delegation is handled by the token: with `RepToken.setDefaultDelegate(executionDelegate)` set, buyers are auto-delegated on first receipt and can later self-delegate. Inventory holders can be excluded with `setAutoDelegateExempt`.

The contract header still describes a "DAO mints inventory to the CO" model. The code mints on demand to the buyer; there is no inventory.

## Genesis (AutonetSetup)

`contracts/modules/AutonetSetup.sol` is the `autonet` [module](modules.md): it launches a jurisdiction's whole Autonet layer in one transaction. It depends on no other module. At origination it is prepared between `JurisdictionFactory.deployCore` and `finalize` (the werule wizard's Autonet module, and `scripts/deploy-autonet-jurisdiction.js`); a live jurisdiction attaches it by a proposal built with `ModuleProcessor.installCalls`:

1. `JurisdictionFactory.deployCore` (Governor, Timelock, Registry, RepToken)
2. `EconomySetup.prepareInstallation(core, data)` (Economy and EconomyRepClaim; the reference jurisdiction has one, Autonet doesn't need it)
3. `AutonetSetup.prepareInstallation(core, abi.encode(AutonetParams, ToolBond.Params))` deploys the Substrate (treasury = Registry, governor = Timelock, anchorer = the AnchorElection, this RepToken), the AnchorElection (autonet `contracts/core/AnchorElection.sol`), AutonetVault, AutonetRepClaim, ToolBond, ServiceRegistry and PaymentChannel. `id` comes from `lastPreparedBy(preparer)`; `deploymentOf(id)` returns `{ substrate, anchorElection, vault, repClaim, toolBond, serviceRegistry, paymentChannel, charter, epochRules }`.
4. `JurisdictionFactory.finalize(core, [economy, autonet], keys, values)` attaches both in order. For the autonet installation that means `minter` rights for the REP claim, `slasher` rights for ToolBond, the AnchorElection as an option source on the governor (`HomebaseDAO.setOptionSource`, which the launching factory may call until the handover), the `jurisdiction.autonet.*` keys (every Autonet contract, including `anchor_election`, plus `rep_token`, `dao`, `timelock`, `registry`, and `charter` and `epoch_rules` when given) and `modules.autonet`; `keys` carries the parities. The grants happen while the factory is still RepToken admin, so nothing needs a proposal afterwards. The daemon joins a jurisdiction from those Registry keys alone.

The charter is the Registry entry `jurisdiction.autonet.charter`, the full JSON text `{"axes":[{"id":"...","thesis":"..."}]}`. Each DAO defines its own axes, but every charter must include `correctness` and `simplicity`: the wizard checks that, and the daemon refuses a charter without them. Daemons hash the entry's exact bytes (sha256 of the UTF-8 string, never re-serialized) and read it pinned to the previous anchor's block, so a charter changed by proposal applies from the next epoch. `jurisdiction.autonet.epoch_rules` is the version of the epoch math (`"2"`); it changes only when that math does, and a daemon refuses to join a DAO whose version it doesn't support. The build metadata defaults the charter to v1 and fixes the epoch rules version; every setting can be changed by proposal (a new challenge window applies to channels opened after the change).

The Substrate takes the vault as its minter and the vault takes the Substrate. The vault is the launch's first CREATE (its address follows from the setup's nonce, which each launch advances by exactly seven, so from the installation id), so the Substrate is created with CREATE2 at an address computed beforehand. The creation code of the Substrate, ServiceRegistry, PaymentChannel and AnchorElection (from `test/fixtures/autonet`) and of ToolBond (from this repo) lives on-chain in five code blobs fixed when AutonetSetup is deployed (`scripts/lib/modules.js` `deployAutonetSetup`), so a preparer picks parameters but never code. `scripts/deploy-jurisdiction-suite.js` deploys and publishes AutonetSetup with the suite. A launch costs about 11M gas.

Timing env vars are seconds in whole minutes (`VOTING_DELAY_SECS`, `VOTING_PERIOD_SECS`, `TIMELOCK_DELAY_SECS`). Test networks use `0 / 120 / 0`. The genesis REP goes to the deployer, who delegates it (for example to the anchor agent) so anchors reach quorum.

### Minter swap (from the retired mirror)

`ReputationMirror` (removed from this repo; it read reputation the Substrate no longer mints) was the minter on early Shadownet jurisdictions. Swap it in one proposal:

1. `RepToken.setMinter(<AutonetRepClaim>, true)`
2. `RepToken.setMinter(<ReputationMirror>, false)`

`scripts/deploy-autonet-rep-claim.js` prints the calldata (`MIRROR_ADDR` adds the revoke).

## Tests

| File | Covers |
|------|--------|
| `test/autonet-setup.test.js` | AutonetSetup at origination: the whole layer wired and live at genesis, a second launch from the same setup, no charter or epoch rules entries when none are given, unknown installations |
| `test/autonet-integration.test.js` | A jurisdiction wired to the **real** autonet contracts: Substrate on the predicted vault address with the Registry as treasury and the timelock as governor, minter grant and parity by proposal, vault sale, service-fee split, REP from tool-pool earnings only (service revenue earns none), service fee retuned by proposal, payment-channel settlement, charter changed by proposal, vault pause |
| `test/autonet-vault.test.js` | Parity math (USDC and DAI into ATN at jurisdiction-unit parity), uncapped, dust, de-whitelisting, routing, pause, admin, reentrancy |
| `test/autonet-rep-claim.test.js` | Against the real Substrate: 1e12 scaling, summed base, watermark idempotency, permissionless trigger, registered agents only, genesis seed, no mint without grant |
| `test/tool-bond.test.js` | Against the real Substrate and a RepToken: slasher rights, author-only bonding, unbond delay and round lock, REP snapshot weights, commit-reveal, malware and clean payouts, silent committers, ties, DAO overrule window, batched finalize, lapse, parameter bounds |
| `test/coin-offering.test.js` | Cap, auto-delegation, reclaiming votes, 6 to 18 parity |

The real contracts come from `test/fixtures/autonet/` (ABI and bytecode, with the source commit in `SOURCE.json`). Refresh them after changing the autonet contracts: compile in the autonet repo, then `node scripts/sync-autonet-artifacts.js [path to autonet]`. The vault unit test still uses a small stand-in, `contracts/test/MockAutonetATN.sol`.
