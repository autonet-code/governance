# Autonet Integration

How a jurisdiction (the DAO suite in this repo) attaches to the Autonet network.

The Autonet network's economics live on its own **Substrate** contract in the autonet repo ([github.com/autonet-code/node](https://github.com/autonet-code/node), `contracts/core/Substrate.sol`). **ATN is minted and accounted there, never in this repo.** The old jurisdiction-local `Autonet.sol` token was deleted. What remains here is a set of small satellite contracts that either sell Substrate ATN into the DAO treasury or turn Substrate activity into governance weight (RepToken).

Related: [architecture.md](architecture.md), [governance.md](governance.md), [registry-settings.md](registry-settings.md), [technical-reference.md](technical-reference.md), [security.md](security.md), [deployments.md](deployments.md).

## Status at a glance

| Contract | Role | Status (from code and scripts) |
|----------|------|-------------------------------|
| `AutonetVault` | Sells Substrate ATN for whitelisted ERC20s; payment goes to the Registry | **Live.** Deployed on Shadownet and registered under `jurisdiction.autonet.vault` (`scripts/submit-autonet-registry-keys.js`) |
| `AutonetRepClaim` | Mints REP 1:1 against ATN an agent provably earned on the Substrate | **Live.** Granted minter rights by proposal (the 2026-07-10 flag-day proposal on Shadownet); registered under `jurisdiction.autonet.rep_claim` |
| `ToolBond` | ATN stakes behind every tool, and malware verdicts settled by REP-weighted auditor flags with DAO appeal | **Reworked (2026-10-13).** Deployed by `AutonetSetup` with its slasher grant; nodes run tools only while `isBonded`, by default only `isVetted` |
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

`contracts/AutonetRepClaim.sol`. REP as a pull claim on ATN an agent provably earned ("voice is always work-backed").

- Earnings base per agent: `substrate.agentMintTotal(agent) + substrate.serviceEarnings(agent)`, both cumulative and monotonic on the Substrate, in ATN base units (1 ATN = 1e6).
- `claim(agent)`: permissionless trigger. Mints `(base - watermark) * 1e12` REP **to the agent** (never the caller) with `RepToken.mintDelegated`, so the agent votes its own REP (and signs Substrate anchors with it) unless it already chose a delegate, and advances the watermark. Reverts `NothingToClaim` on zero delta. Emits `RepClaimed(agent, earningsDelta, repMinted)`.
- `claimable(agent)`, `earningsBase(agent)`: views.
- Constants: `ATN_BASE = 1e6`, `REP_DECIMALS = 1e18`, `REP_PER_ATN_BASE = 1e12`. Hardcoded 1:1 in whole tokens; no rate knob, no admin, no pause.
- Constructor optionally mints a genesis REP seed (`genesisHolders`, `genesisAmounts`). That requires the contract to already be a minter, so in practice pass an empty seed and mint the seed by proposal (the Shadownet flag-day proposal minted `1000e18` to a dev wallet).

Only registered Substrate agents can claim (`NotAgent` otherwise): earnings paid to other addresses, such as a VentureVault, never become REP.

Trust assumptions: the Substrate's earnings ledgers are honest and monotonic; RepToken grants this contract minter rights. Since autonet `45ae758` only the DAO's timelock can anchor an epoch, so every anchor is an ordinary DAO proposal calling `Substrate.anchor` (indexed as type `atn epoch`), and an epoch can mint at most the service fees burned in the window before it. Proposals are decided as soon as the outcome can't change (docs/governance.md), so an anchor backed by a majority of delegated REP passes in one block plus the timelock delay. Delegating REP to an agent hands it that weight. There is no baseline: an agent's first claim covers all earnings recorded on the Substrate up to that point.

## ToolBond

`contracts/ToolBond.sol`. Every published tool carries an ATN stake (any tool runs with the daemon's full authority). Nodes ignore a tool unless `isBonded(digest)` and run it by default only once `isVetted(digest)`. Malware verdicts are settled by REP-weighted auditor flags, with the DAO as court of appeal (the ERC20Project appeal model). No arbiter.

- `bond(digest, amount)`: only `Substrate.toolAuthor(digest)`; pulls ATN (approve first). Topping up cancels a pending unbond. `isBonded` needs `stake >= minStake`, no pending unbond and no past slash. A new version is a new digest with its own stake and verdict.
- `requestUnbond`, then `withdraw` after `unbondDelay`: the tool stops counting at once; rounds can still open until the delay passes, and no withdrawal while a round is active.
- `commitFlag(digest, commitment)`: any REP holder but the author, one flag per round. The commitment is `commitmentOf(digest, round, auditor, red, evidenceHash, salt)`: green means "checked, clean", red cites the malicious code. `evidenceHash` is daemon-defined (tool digest, code reference for red, audit transcript hash, pinned dependency digests) and opaque to the contract. The first commit opens a round with a REP snapshot one second earlier; a flag weighs the auditor's snapshot balance (zero weighs nothing, REP gained later doesn't count). Commits close when the committed weight reaches `thresholdBps` of the snapshot supply; a round below it lapses after `reviewWindow` (`lapse`) with nothing paid or slashed.
- `revealFlag(digest, red, evidenceHash, salt)` within `revealWindow`, then `settle(digest)`: the heavier revealed color wins (a tie is void) and the appeal window `appealWindow()` starts: `appealPeriod`, never shorter than one proposal lifecycle (voting delay, voting period and timelock delay, read live from the governor and timelock) plus two days. `daoOverrule(digest, malware)`: the timelock, by proposal, within that window; final at once.
- `finalize(digest, maxAuditors)`: anyone, after the window (batched, call until done). Losing flaggers and committers who never revealed lose `degradeBps` of their snapshot REP. Malware: the author loses `authorSlashBps` of their REP, the digest can never be bonded again, the finder (earliest red commit) gets `finderBps` of the stake, and the rest waits for the red flaggers. Clean: the tool is vetted and the green flaggers become its auditors, splitting `auditorShareBps` of its mints by REP (applied by the daemon at epoch close).
- `claim(digest, round)`: each winning flagger takes its weight's share of the round's slashed REP (`RepToken.reassign`, so REP moves and is never created) and, on malware, of the remaining stake. ATN pays through `Substrate.payForService`, so bounties are service earnings and can be claimed as REP.
- A clean tool can be reopened on new evidence; a pending malware verdict unvets it at once.
- `ToolBond(substrate, rep, governor, timelock, params)`. `setParams(Params)`: timelock only; emits `ParamsSet` and `AppealPeriodSet`. Genesis defaults: 100 ATN stake, threshold 5% of REP, 14-day review, 2-day reveal, finder 50%, degrade 10%, author slash 100%, auditor share 40%, 30-day unbond delay, 10-day appeal period (env `TOOLBOND_*` overrides). The bond needs `RepToken.setSlasher(toolBond, true)`, granted when the module is attached.

Stakes are flat for now; scaling them with a tool's usage is a later step. Bonds are only as sound as ATN itself, which depends on the Substrate's anchor authority.

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
3. `AutonetSetup.prepareInstallation(core, abi.encode(AutonetParams, ToolBond.Params))` deploys the Substrate (treasury = Registry, governor = Timelock, this RepToken), AutonetVault, AutonetRepClaim, ToolBond, ServiceRegistry, PaymentChannel and VentureVaultFactory. `id` comes from `lastPreparedBy(preparer)`; `deploymentOf(id)` returns `{ substrate, vault, repClaim, toolBond, serviceRegistry, paymentChannel, ventureVaultFactory, charterHash, charterUri }`.
4. `JurisdictionFactory.finalize(core, [economy, autonet], keys, values)` attaches both in order. For the autonet installation that means `minter` rights for the REP claim, `slasher` rights for ToolBond, the `jurisdiction.autonet.*` keys (every Autonet contract plus `rep_token`, `dao`, `timelock`, `registry`, and the charter when `charterHash` is nonzero) and `modules.autonet`; `keys` carries the parities. The grants happen while the factory is still RepToken admin, so nothing needs a proposal afterwards. The daemon joins a jurisdiction from those Registry keys alone.

The charter is two Registry entries: `jurisdiction.autonet.charter` (the sha256 of the canonical charter, `0x` plus 64 lowercase hex) and `jurisdiction.autonet.charter_uri`. The DAO changes them by proposal like any Registry entry; the daemon compares its `charter_hash()` against `jurisdiction.autonet.charter`. The build metadata fixes `charterHash` and `charterUri` to the current charter, so the wizard doesn't show them; every setting can be changed by proposal (a new challenge window applies to channels opened after the change).

The Substrate takes the vault as its minter and the vault takes the Substrate. The vault is the launch's first CREATE (its address follows from the setup's nonce, which each launch advances by exactly seven, so from the installation id), so the Substrate is created with CREATE2 at an address computed beforehand. The creation code of the Substrate, ServiceRegistry, PaymentChannel and VentureVaultFactory (from `test/fixtures/autonet`) and of ToolBond (from this repo) lives on-chain in five code blobs fixed when AutonetSetup is deployed (`scripts/lib/modules.js` `deployAutonetSetup`), so a preparer picks parameters but never code. `scripts/deploy-jurisdiction-suite.js` deploys and publishes AutonetSetup with the suite. A launch costs about 11M gas.

Timing env vars are seconds in whole minutes (`VOTING_DELAY_SECS`, `VOTING_PERIOD_SECS`, `TIMELOCK_DELAY_SECS`). Test networks use `0 / 120 / 0`. The genesis REP goes to the deployer, who delegates it (for example to the anchor agent) so anchors reach quorum.

### Minter swap (from the retired mirror)

`ReputationMirror` (removed from this repo; it read reputation the Substrate no longer mints) was the minter on early Shadownet jurisdictions. Swap it in one proposal:

1. `RepToken.setMinter(<AutonetRepClaim>, true)`
2. `RepToken.setMinter(<ReputationMirror>, false)`

`scripts/deploy-autonet-rep-claim.js` prints the calldata (`MIRROR_ADDR` adds the revoke).

## Tests

| File | Covers |
|------|--------|
| `test/autonet-setup.test.js` | AutonetSetup at origination: the whole layer wired and live at genesis, a second launch from the same setup, no charter entries without a charter hash, unknown installations |
| `test/autonet-integration.test.js` | A jurisdiction wired to the **real** autonet contracts: Substrate on the predicted vault address with the Registry as treasury and the timelock as governor, minter grant and parity by proposal, vault sale, service-fee split, REP from service and tool-pool earnings, service fee retuned by proposal, payment-channel settlement, charter changed by proposal, vault pause |
| `test/autonet-vault.test.js` | Parity math (USDC and DAI into ATN at jurisdiction-unit parity), uncapped, dust, de-whitelisting, routing, pause, admin, reentrancy |
| `test/autonet-rep-claim.test.js` | Against the real Substrate: 1e12 scaling, summed base, watermark idempotency, permissionless trigger, registered agents only, genesis seed, no mint without grant |
| `test/tool-bond.test.js` | Against the real Substrate and a RepToken: slasher rights, author-only bonding, unbond delay and round lock, REP snapshot weights, commit-reveal, malware and clean payouts, silent committers, ties, DAO overrule window, batched finalize, lapse, parameter bounds |
| `test/coin-offering.test.js` | Cap, auto-delegation, reclaiming votes, 6 to 18 parity |

The real contracts come from `test/fixtures/autonet/` (ABI and bytecode, with the source commit in `SOURCE.json`). Refresh them after changing the autonet contracts: compile in the autonet repo, then `node scripts/sync-autonet-artifacts.js [path to autonet]`. The vault unit test still uses a small stand-in, `contracts/test/MockAutonetATN.sol`.
