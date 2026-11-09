# Autonet Integration

How a jurisdiction (the DAO suite in this repo) attaches to the Autonet network.

The Autonet network's economics live on its own **Substrate** contract in the autonet repo ([github.com/autonet-code/node](https://github.com/autonet-code/node), `contracts/core/Substrate.sol`). **ATN is minted and accounted there, never in this repo.** The old jurisdiction-local `Autonet.sol` token was deleted. What remains here is a set of small satellite contracts that either sell Substrate ATN into the DAO treasury or turn Substrate activity into governance weight (RepToken).

Related: [architecture.md](architecture.md), [governance.md](governance.md), [registry-settings.md](registry-settings.md), [technical-reference.md](technical-reference.md), [security.md](security.md), [deployments.md](deployments.md).

## Status at a glance

| Contract | Role | Status (from code and scripts) |
|----------|------|-------------------------------|
| `AutonetVault` | Sells Substrate ATN for whitelisted ERC20s; payment goes to the Registry | **Live.** Deployed on Shadownet and registered under `jurisdiction.autonet.vault` (`scripts/submit-autonet-registry-keys.js`) |
| `AutonetRepClaim` | Mints REP 1:1 against ATN an agent provably earned on the Substrate | **Live.** Granted minter rights by proposal (the 2026-07-10 flag-day proposal on Shadownet); registered under `jurisdiction.autonet.rep_claim` |
| `ToolBond` | ATN bonds behind every tool, and epoch reviews that rate tools on correctness, simplicity, novelty, malware and each charter axis, with a malware verdict at conclusion the author can appeal to the DAO | **Reworked (2026-10-17).** Deployed by `AutonetSetup` with its slasher grant; nodes run tools only while `isBonded`, and judge them by their ratings |

> New jurisdictions get `AutonetRepClaim` (empty genesis seed) and its minter grant at genesis (see [Genesis](#genesis-autonetsetup)). Jurisdictions that still have the retired ReputationMirror as a minter revoke it by proposal (see [Minter swap](#minter-swap-from-the-retired-mirror)).

## Parity: one registry key, one formula

`EconomyRepClaim` (economy reputation) and `AutonetVault` price payment tokens from the same Registry key:

```
jurisdiction.parity.<lowercase 0x token address>      (native currency: 0xeeee...eeee)
```

The value is a decimal string holding an **18-decimal fixed-point multiplier from payment-token base units into jurisdiction units** (REP base units, 18 decimals). One parity means the same thing everywhere:

```
EconomyRepClaim:  out = paymentAmount * parity / 1e18        (REP, 18 dec)
AutonetVault:     out = paymentAmount * parity / 1e18 / 1e12  (ATN, 6 dec)
```

1 ATN (1e6 base units) prices like 1 REP (1e18), the same 1:1 that `AutonetRepClaim` uses, so the vault only divides by `REP_PER_ATN_BASE = 1e12`. A USDC parity of `1e30` makes 1 USDC worth 1 REP when earned in a project and 1 ATN from the vault.

Absent, empty or `"0"` means the token is not whitelisted (`TokenNotRegistered` in the vault; zero reputation in EconomyRepClaim). Values are parsed with `Strings.parseUint`, so they must be plain integers (`"1000000000000000000"`, not `"1e18"`).

Decimals are not queried. The payment token's decimals are baked into the value:

```
parity = price * 10^(36 - paymentDecimals)       (price in REP or ATN per payment token)
```

Examples: 1 USDC (6 dec) to 1 unit: `1e30`; 1 USDC to 2 units: `2e30`; 1 DAI or native (18 dec) to 1 unit: `1e18`. This is the form werule writes (`ValueIndexItem.toRegistryValue`, mirrored in `scripts/e2eLocal.js`).

Jurisdictions attached before 2026-10-12 set vault parities 1e12 lower (the vault did not scale then); re-set them when moving to the current vault.

Integer flooring: a payment that floors to zero output reverts with `DustAmount` in the vault. ATN has fewer decimals than most payment tokens, so dust is more likely there.

## AutonetVault

`contracts/AutonetVault.sol`. A buy-only router.

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

`contracts/ToolBond.sol`. Every published tool carries its author's ATN bond, and REP-weighted reviews rate it. Ratings are a gradient: per round and per tool ToolBond keeps the REP-weighted sum and the REP mass of every review field and charter axis, and the daemons, agents and their owners decide what to use. The framework rates tools; it doesn't try to make them safe (owner decisions 2026-11-09). The DAO is the court of appeal on malware, and only the tool's author can appeal. No arbiter. Reviews carry no ATN stake: the REP at risk is the stake.

- `bond(digest, amount)`: only `Substrate.toolAuthor(digest)`; pulls ATN (approve first). Topping up cancels a pending unbond. The first bond fixes `bondHousehold(digest)`, the author's household, liable if the tool is found to be malware and barred from reviewing it; rotating the author agent's owner later moves neither. `isBonded` needs `stake >= minStake` and no pending unbond. A new version is a new digest with its own bond and ratings.
- `requestUnbond`, then `withdraw`: the tool stops counting at once but stays reviewable. The bond and the bounty left leave together, only after `unbondDelay`, once every round on the tool is finalized and while no malware verdict is open. Before the tool concludes, a withdraw is refused (`MalwareSuspected`) while more than half the REP of its finalized rounds says malware, so an author can't pull the bond once caught. A round exists from its first reveal, so `unbondDelay` must outlast an epoch and its reveal window for an unbond to never escape that epoch's reviews.
- Bounty: `addBounty(digest, amount)`, anyone, for a tool with a bond record (approve first); ATN for the tool's reviewers, apart from the bond. Each round pays out of it on chain as it finalizes. Its base is the tool's bounty when the round starts finalizing, so the order of reviews inside it doesn't matter. A settled review takes base x its REP weight (its household's REP at the snapshot) / the REP a tool needs to conclude x its accuracy, where that need is `jurisdiction.autonet.mint_gate_rep_bps` (unset, malformed or above 10000: 100) of the epoch's REP supply. If the parts add up to more than the base or the balance left, they're scaled down together, so a reviewer whose REP alone covers the need can take the whole bounty. Uninformative reviews take nothing, and the author's household can't review its own tool. A sanctioned reviewer takes nothing either, and its part stays in the bounty: `sanction.<address>` (lowercase 0x) on the reviewer agent or its household, in force when set unless the value is JSON with an integer `until` already past (`sanctioned(account)`). `claim` pays the part to the review's household (`BountyPaid`). `roundBounty(digest, epoch)` gives the base, the need, the REP x accuracy taking part and the round's payout. `bonds(digest).bounty` is what's left. The bounty pays by REP x accuracy, never by the scores given, also when the tool is malware.
- Epochs are the Substrate's: epoch e runs from anchor e-1 (or the Substrate's deployment) to anchor e, so `currentEpoch()` is `anchorCount()`. At an epoch's first commit ToolBond records the charter's sha256 and its axis ids, parsed from `jurisdiction.autonet.charter` (compact JSON, ids of `[a-z0-9_]`, at most 16; anything else gives the epoch no axes), the REP snapshot (the epoch's start), the supply then, and what an unscored axis counts as (`epochInfo`, `EpochStarted`).
- `commit(commitment, reviews)`: once per agent per epoch, for a hidden batch of `reviews` reviews (public, `reviewCountOf`; the reveal must hold exactly that many). Refused (`NoWeight`) when the agent's household held no REP at the snapshot. The commitment is `commitmentOf(epoch, agent, reviews, salt)`.
- Households: REP sits on owner wallets, not agent keys (autonet decision 2026-10-27), so a batch weighs the REP of the committing agent's household (`Substrate.getAgentOwner`, read at commit; an unbound address is its own household; `householdOf(epoch, agent)`). A household weighs once per tool per epoch: among its reviews of a tool, the one from its earliest commit carries the weight and the rest count at zero (`ReviewUnweighted` when a later reveal takes the weight back). Commits are hidden, so their order carries no information, and the order of reveals can't choose which review counts. Every REP slash and reassignment from a review, a forfeit or a malware verdict lands on the household.
- A review is `{digest, correctness, simplicity, novelty, malware, scores, evidenceHash}`. The four fixed fields are the same in every jurisdiction and all required: correctness -100..100, simplicity and novelty 0..100, malware 1 (yes) or 0, by NIST SP 800-53's "malicious code". `scores` holds one int8 per charter axis (-100..100, or -128 for unscored), or nothing (all unscored). An unscored axis counts at `jurisdiction.autonet.unscored_axis_bps` of the top score (unset, malformed or above 10000: 5000, so 50), with the review's weight, in the sums and in accuracy; the value is fixed per epoch when it starts. `evidenceHash` is daemon-defined and opaque to the contract.
- `reveal(epoch, agent, reviews, salt)`: after anchor e, within `revealWindow`; anyone holding the plaintext can relay it. A review that can't count (an unbonded tool, one from the reviewer's own household, a repeat, a fixed field missing or out of range, malformed scores) is skipped without voiding the batch.
- `forfeit(epoch, agent)`: anyone, after the window. A batch never revealed loses, per declared review, `degradeBps` of the snapshot REP it weighed, from its household: the most its revealed reviews could have cost, so revealing always beats withholding.
- `finalize(digest, epoch, maxReviews)`: anyone, after the window (batched, call until done). Each review's accuracy is the plain mean, over the four fields and every charter axis, of 1 - |its value - the REP-weighted mean of the round's other reviews| / the range (200 for correctness and the axes, 100 for simplicity, novelty and malware as 0 or 100). Its own weight is left out, so a lone reviewer is measured against no one and neither gains nor loses. Each review loses REP x `degradeBps` x (1 - accuracy). The round's sums then join the tool's.
- `claim(digest, epoch, reviewer)`: anyone, for the reviewer. A share of the REP slashed from the round's reviewers by REP x accuracy (`RepToken.reassign`, to the household), and its bounty part, to its household. No REP is created.
- Malware is judged once per tool, when it concludes. The daemons' close decides when a tool's reviewers reach the conclusion threshold (REP and REP-holding households, with its review decay and sanctions), and adds a leaf for each concluding tool to that anchor's `agentMintRoot`: `keccak256(bytes.concat(keccak256(abi.encode(CONCLUDED_TAG, digest, shareBps))))`, `CONCLUDED_TAG = keccak256("autonet.tool_concluded")`, `shareBps` the close's share of the reviewing REP that said malware, with the same sorted-pair hashing as the mint leaves (three words, so it never reads as a mint leaf). `conclude(digest, anchorIndex, shareBps, proof)`, anyone, once per tool, records it (`verdicts(digest)`): the share is the close's, so there is one definition, and ToolBond only keeps the REP that said yes in the rounds finalized by then, which shares a slashed bond. Half or less settles clean. More than half opens `appealPeriod`, set by the DAO with no floor, in which the tool's author agent or bonding household can call `registerDaoProposal(digest, targets, values, calldatas, descriptionHash)` for a live proposal calling `daoOverrule(digest, malware)` on it; the verdict then can't settle until `verdicts(digest).heldUntil`, the latest moment a registered proposal could land, as for projects ([economy.md](economy.md#dao-proposal-holds)). `daoOverrule`, the timelock by proposal, within the window or later if an appeal was registered in time, rules yes or no and is final. `settleMalware(digest)`, anyone, after the window and any hold, or at once after a ruling: unless the DAO ruled no, the bond loses the share of yes and the bonding household's REP burns that share of `authorSlashBps` (`AuthorRepBurned`), never more than the REP that said yes. A DAO ruling of malware replaces the reviewers' answer, so the share is all of it. `claimBondShare(digest, epoch, reviewer)` pays the slashed bond to the reviews that said yes in rounds finalized before the conclusion, by REP, through `Substrate.payForService` so it counts as service earnings; with none, it goes to the treasury.
- Ratings: `roundAxis(digest, epoch, i)` per round, i = `CORRECTNESS` 0, `SIMPLICITY` 1, `NOVELTY` 2, `MALWARE` 3 (a yes counts as 100, so sum / mass / 100 is the share of yes), then charter axis k at `FIELDS` + k; `toolRating(digest, key)` over every finalized round, key `bytes32(index)` for a fixed field and `keccak256(axisId)` for a charter axis; each a sum of REP x score and the REP mass. `getRound` gives a round's stage (None, Open, Finalizing, Done), weight, review count and whether it finalized before the tool concluded. The daemon's close reads them pinned to the previous anchor.
- Reviews count for any tool with a bond left, including one whose author asked to unbond or whose bond fell below `minStake` after a slash. Epoch 0's REP snapshot is the Substrate's deployment, so genesis REP must exist by then (the core mints it before the module is prepared). `Reviewed`, `ReviewSettled` and `EpochStarted` carry each review's values, its accuracy and each epoch's axis ids and unscored default, so the close can work from logs.
- `ToolBond(substrate, rep, registry, governor, timelock, params)`. `setParams(Params)`: timelock only; emits `ParamsSet` and `AppealPeriodSet`. Genesis defaults: 100 ATN bond, 1-day reveal window, degrade 10%, author slash 100%, reviewer share 40%, 30-day unbond delay, 3-day appeal period (env `TOOLBOND_*` overrides). The bond needs `RepToken.setSlasher(toolBond, true)`, granted when the module is attached.

Bonds are flat for now; scaling them with a tool's usage is a later step. Bonds are only as sound as ATN itself, which depends on the Substrate's anchors.

## Genesis (AutonetSetup)

`contracts/modules/AutonetSetup.sol` is the `autonet` [module](modules.md): it launches a jurisdiction's whole Autonet layer in one transaction. It depends on no other module. At origination it is prepared between `JurisdictionFactory.deployCore` and `finalize` (the werule wizard's Autonet module, and `scripts/deploy-autonet-jurisdiction.js`); a live jurisdiction attaches it by a proposal built with `ModuleProcessor.installCalls`:

1. `JurisdictionFactory.deployCore` (Governor, Timelock, Registry, RepToken)
2. `EconomySetup.prepareInstallation(core, data)` (Economy and EconomyRepClaim; the reference jurisdiction has one, Autonet doesn't need it)
3. `AutonetSetup.prepareInstallation(core, abi.encode(AutonetParams, ToolBond.Params))` deploys the Substrate (treasury = Registry, governor = Timelock, anchorer = the AnchorElection, `genesisRoot` = the ATN genesis claim root of a fork or split, zero for a new network), the AnchorElection (autonet `contracts/core/AnchorElection.sol`), AutonetVault, AutonetRepClaim, ToolBond, ServiceRegistry and PaymentChannel. `id` comes from `lastPreparedBy(preparer)`; `deploymentOf(id)` returns `{ substrate, anchorElection, vault, repClaim, toolBond, serviceRegistry, paymentChannel, charter, epochRules }`.
4. `JurisdictionFactory.finalize(core, [economy, autonet], keys, values)` attaches both in order. For the autonet installation that means `minter` rights for the REP claim, `slasher` rights for ToolBond, the AnchorElection as an option source on the governor (`HomebaseDAO.setOptionSource`, which the launching factory may call until the handover), the `jurisdiction.autonet.*` keys (every Autonet contract, including `anchor_election`, plus `rep_token`, `dao`, `timelock`, `registry`, and `charter` and `epoch_rules` when given) and `modules.autonet`; `keys` carries the parities. The grants happen while the factory is still RepToken admin, so nothing needs a proposal afterwards. The daemon joins a jurisdiction from those Registry keys alone.

The charter is the Registry entry `jurisdiction.autonet.charter`, the full JSON text `{"axes":[{"id":"...","thesis":"..."}]}`. Each DAO defines its own axes, its values, each scored on its own; correctness, simplicity, novelty and malware are fixed review fields, not axes. The default charter holds four value axes. Daemons hash the entry's exact bytes (sha256 of the UTF-8 string, never re-serialized) and read it pinned to the previous anchor's block, so a charter changed by proposal applies from the next epoch. Changing the charter or the epoch rules is a constitutional proposal: it needs the DAO's supermajority of all REP (see [governance.md](governance.md)). `jurisdiction.autonet.epoch_rules` is the version of the epoch math (`"2"`); it changes only when that math does, and a daemon refuses to join a DAO whose version it doesn't support. The build metadata defaults the charter to v1 and fixes the epoch rules version; every setting can be changed by proposal (a new challenge window applies to channels opened after the change). werule shows that default charter read-only when it installs Autonet, at creation or on an existing DAO, and always passes it, so a jurisdiction can't start on a charter written on the spot: it changes it later by constitutional proposal. AutonetSetup still takes any charter, so a fork or split carries its parent's.

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
| `test/tool-bond.test.js` | Against the real Substrate and a RepToken: slasher rights, author-only bonding, unbond delay and round lock, bounty, REP snapshot weights and households, commit-reveal and invalid reviews, accuracy over every field with the unscored default, malware verdicts from the anchored close, the author's appeal and the DAO's ruling, bond shares, batched finalize, parameter bounds |

The real contracts come from `test/fixtures/autonet/` (ABI and bytecode, with the source commit in `SOURCE.json`). Refresh them after changing the autonet contracts: compile in the autonet repo, then `node scripts/sync-autonet-artifacts.js [path to autonet]`. The vault unit test still uses a small stand-in, `contracts/test/MockAutonetATN.sol`.
