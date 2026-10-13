# Autonet Integration

How a jurisdiction (the DAO suite in this repo) attaches to the Autonet network.

The Autonet network's economics live on its own **Substrate** contract in the autonet repo ([github.com/autonet-code/node](https://github.com/autonet-code/node), `contracts/core/Substrate.sol`). **ATN is minted and accounted there, never in this repo.** The old jurisdiction-local `Autonet.sol` token was deleted. What remains here is a set of small satellite contracts that either sell Substrate ATN into the DAO treasury or turn Substrate activity into governance weight (RepToken).

Related: [architecture.md](architecture.md), [governance.md](governance.md), [registry-settings.md](registry-settings.md), [technical-reference.md](technical-reference.md), [security.md](security.md), [deployments.md](deployments.md).

## Status at a glance

| Contract | Role | Status (from code and scripts) |
|----------|------|-------------------------------|
| `AutonetVault` | Sells Substrate ATN for whitelisted ERC20s; payment goes to the Registry | **Live.** Deployed on Shadownet and registered under `jurisdiction.autonet.vault` (`scripts/submit-autonet-registry-keys.js`) |
| `AutonetRepClaim` | Mints REP 1:1 against ATN an agent provably earned on the Substrate | **Live.** Granted minter rights by proposal (the 2026-07-10 flag-day proposal on Shadownet); registered under `jurisdiction.autonet.rep_claim` |
| `ToolBond` | ATN stakes behind every tool, and malware verdicts settled by REP-weighted auditor flags with DAO appeal | **Reworked (2026-10-13).** Deployed by `AutonetGenesis` with its slasher grant; nodes run tools only while `isBonded`, by default only `isVetted` |
| `CoinOffering` | Sells the jurisdiction's own transferable governance token (ATNB) under a DAO-set cap | **Tested in isolation** (`deployCOLocal.js`, `deployTestCOShadownet.js`, `deployTestCOBaseSepolia.js`). Not part of the Autonet genesis flow |

> New jurisdictions get `AutonetRepClaim` (empty genesis seed) and its minter grant at genesis (see [Genesis](#genesis-autonetgenesis)). Jurisdictions that still have the retired ReputationMirror as a minter revoke it by proposal (see [Minter swap](#minter-swap-from-the-retired-mirror)).

## Parity: one registry key, one formula

`RepToken` (economy reputation), `CoinOffering` and `AutonetVault` all price payment tokens from the same Registry key:

```
jurisdiction.parity.<lowercase 0x token address>      (native currency: 0xeeee...eeee)
```

The value is a decimal string holding an **18-decimal fixed-point multiplier from payment-token base units into jurisdiction units** (REP base units, 18 decimals). One parity means the same thing everywhere:

```
RepToken, CoinOffering:  out = paymentAmount * parity / 1e18               (REP / ATNB, 18 dec)
AutonetVault:            out = paymentAmount * parity / 1e18 / 1e12         (ATN, 6 dec)
```

1 ATN (1e6 base units) prices like 1 REP (1e18), the same 1:1 that `AutonetRepClaim` uses, so the vault only divides by `REP_PER_ATN_BASE = 1e12`. A USDC parity of `1e30` makes 1 USDC worth 1 REP when earned in a project, 1 ATNB in the coin offering and 1 ATN from the vault.

Absent, empty or `"0"` means the token is not whitelisted (`TokenNotRegistered` in the vault and CO; zero reputation in RepToken). Values are parsed with `Strings.parseUint`, so they must be plain integers (`"1000000000000000000"`, not `"1e18"`).

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

Trust assumptions: the Substrate's earnings ledgers are honest and monotonic; RepToken grants this contract minter rights. Since autonet `c390bd8` the Substrate enforces this on chain: an anchor needs EIP-712 signatures from registered agents holding more than `anchorQuorumBps` of this RepToken's votes (read at the previous anchor's timestamp), and an epoch can mint at most the service fees burned in the window before it. REP held by members counts toward that quorum only once delegated to a registered agent, so delegating to an agent hands it both anchor and governance weight. There is no baseline: an agent's first claim covers all earnings recorded on the Substrate up to that point.

## ToolBond

`contracts/ToolBond.sol`. Every published tool carries an ATN stake (any tool runs with the daemon's full authority). Nodes ignore a tool unless `isBonded(digest)` and run it by default only once `isVetted(digest)`. Malware verdicts are settled by REP-weighted auditor flags, with the DAO as court of appeal (the ERC20Project appeal model). No arbiter.

- `bond(digest, amount)`: only `Substrate.toolAuthor(digest)`; pulls ATN (approve first). Topping up cancels a pending unbond. `isBonded` needs `stake >= minStake`, no pending unbond and no past slash. A new version is a new digest with its own stake and verdict.
- `requestUnbond`, then `withdraw` after `unbondDelay`: the tool stops counting at once; rounds can still open until the delay passes, and no withdrawal while a round is active.
- `commitFlag(digest, commitment)`: any REP holder but the author, one flag per round. The commitment is `commitmentOf(digest, round, auditor, red, evidenceHash, salt)`: green means "checked, clean", red cites the malicious code. `evidenceHash` is daemon-defined (tool digest, code reference for red, audit transcript hash, pinned dependency digests) and opaque to the contract. The first commit opens a round with a REP snapshot one second earlier; a flag weighs the auditor's snapshot balance (zero weighs nothing, REP gained later doesn't count). Commits close when the committed weight reaches `thresholdBps` of the snapshot supply; a round below it lapses after `reviewWindow` (`lapse`) with nothing paid or slashed.
- `revealFlag(digest, red, evidenceHash, salt)` within `revealWindow`, then `settle(digest)`: the heavier revealed color wins (a tie is void) and the appeal window `Economy.effectiveAppealPeriod()` starts. `daoOverrule(digest, malware)`: the timelock, by proposal, within that window; final at once.
- `finalize(digest, maxAuditors)`: anyone, after the window (batched, call until done). Losing flaggers and committers who never revealed lose `degradeBps` of their snapshot REP. Malware: the author loses `authorSlashBps` of their REP, the digest can never be bonded again, the finder (earliest red commit) gets `finderBps` of the stake, and the rest waits for the red flaggers. Clean: the tool is vetted and the green flaggers become its auditors, splitting `auditorShareBps` of its mints by REP (applied by the daemon at epoch close).
- `claim(digest, round)`: each winning flagger takes its weight's share of the round's slashed REP (`RepToken.reassign`, so REP moves and is never created) and, on malware, of the remaining stake. ATN pays through `Substrate.payForService`, so bounties are service earnings and can be claimed as REP.
- A clean tool can be reopened on new evidence; a pending malware verdict unvets it at once.
- `setParams(Params)`: timelock only. Genesis defaults: 100 ATN stake, threshold 5% of REP, 14-day review, 2-day reveal, finder 50%, degrade 10%, author slash 100%, auditor share 40%, unbond delay review + reveal + appeal + 1 day (env `TOOLBOND_*` overrides). The bond needs `RepToken.setSlasher(toolBond, true)`, granted by proposal.

Stakes are flat for now; scaling them with a tool's usage is a later step. Bonds are only as sound as ATN itself, which depends on the Substrate's anchor authority.

## CoinOffering

`contracts/CoinOffering.sol`. Sells ATNB (a transferable RepToken used as the governance token) for whitelisted ERC20s.

- `buy(paymentToken, paymentAmount)`: same parity math and routing as the vault, but mints ATNB via `RepToken.mint` (the CO must be a minter) and enforces `totalMinted + atnbOut <= saleCap` (`CapExceeded`). Emits `TokensPurchased`.
- `setSaleCap(newCap)`: admin only, never below `totalMinted`. `saleCap = 0` (the default) means closed.
- `pause`, `unpause`, `transferAdmin`: admin only. `remaining()` view.
- Delegation is handled by the token: with `RepToken.setDefaultDelegate(executionDelegate)` set, buyers are auto-delegated on first receipt and can later self-delegate. Inventory holders can be excluded with `setAutoDelegateExempt`.

The contract header still describes a "DAO mints inventory to the CO" model. The code mints on demand to the buyer; there is no inventory.

## Genesis (AutonetGenesis)

`contracts/AutonetGenesis.sol` launches a jurisdiction's whole Autonet layer in one transaction, between TrustlessFactory's `deployDAOToken` and finalize. It is what the werule wizard's "Autonet jurisdiction" type calls, and what `scripts/deploy-autonet-jurisdiction.js` calls:

1. `TrustlessFactory.deployInfrastructure` (Economy, Timelock, Registry)
2. `TrustlessFactory.deployDAOToken` (RepToken, governor)
3. `AutonetGenesis.launch(jurisdiction, autonetParams, toolBondParams)` deploys the Substrate (treasury = Registry, governor = Timelock, this RepToken), AutonetVault, AutonetRepClaim, ToolBond, ServiceRegistry, PaymentChannel, VentureVaultFactory and CharterAnchor (genesis charter anchored in its constructor when a hash is given).
4. `TrustlessFactory.configureAndFinalizeWithGrants(..., keys, values, minters, slashers)` with `AutonetGenesis.registryEntries(repToken)` (the `jurisdiction.autonet.*` keys: every Autonet contract plus `rep_token`, `dao`, `timelock`, `economy`, `registry`), parities, `minters = [repClaim]` and `slashers = [toolBond]`. The grants happen while the factory is still RepToken admin, so nothing needs a proposal afterwards. The daemon joins a jurisdiction from those Registry keys alone.

The Substrate takes the vault as its minter and the vault takes the Substrate. The vault is the launch's first CREATE (its address follows from the genesis contract's nonce, which each launch advances by exactly eight), so the Substrate is created with CREATE2 at an address computed beforehand. The autonet contracts' creation code lives on-chain in code blobs fixed when AutonetGenesis is deployed (`scripts/lib/autonet-genesis.js`, from `test/fixtures/autonet`), so a launcher picks parameters but never code. `scripts/deployFullFactorySuiteShadownet.js` deploys AutonetGenesis with the suite (Firestore field `autonetGenesis`). A launch costs about 11M gas.

Timing env vars are seconds in whole minutes (`VOTING_DELAY_SECS`, `VOTING_PERIOD_SECS`, `TIMELOCK_DELAY_SECS`). Test networks use `0 / 120 / 0`. The genesis REP goes to the deployer, who delegates it (for example to the anchor agent) so anchors reach quorum.

### Minter swap (from the retired mirror)

`ReputationMirror` (removed from this repo; it read reputation the Substrate no longer mints) was the minter on early Shadownet jurisdictions. Swap it in one proposal:

1. `RepToken.setMinter(<AutonetRepClaim>, true)`
2. `RepToken.setMinter(<ReputationMirror>, false)`

`scripts/deploy-autonet-rep-claim.js` prints the calldata (`MIRROR_ADDR` adds the revoke).

## Tests

| File | Covers |
|------|--------|
| `test/autonet-integration.test.js` | A jurisdiction wired to the **real** autonet contracts: Substrate on the predicted vault address with the Registry as treasury and the timelock as governor, minter grant and parity by proposal, vault sale, service-fee split, REP from service and tool-pool earnings, service fee retuned by proposal, payment-channel settlement, CharterAnchor by proposal, vault pause |
| `test/autonet-vault.test.js` | Parity math (USDC and DAI into ATN at jurisdiction-unit parity), uncapped, dust, de-whitelisting, routing, pause, admin, reentrancy |
| `test/autonet-rep-claim.test.js` | Against the real Substrate: 1e12 scaling, summed base, watermark idempotency, permissionless trigger, registered agents only, genesis seed, no mint without grant |
| `test/tool-bond.test.js` | Against the real Substrate and a RepToken: slasher rights, author-only bonding, unbond delay and round lock, REP snapshot weights, commit-reveal, malware and clean payouts, silent committers, ties, DAO overrule window, batched finalize, lapse, parameter bounds |
| `test/coin-offering.test.js` | Cap, auto-delegation, reclaiming votes, 6 to 18 parity |

The real contracts come from `test/fixtures/autonet/` (ABI and bytecode, with the source commit in `SOURCE.json`). Refresh them after changing the autonet contracts: compile in the autonet repo, then `node scripts/sync-autonet-artifacts.js [path to autonet]`. The vault unit test still uses a small stand-in, `contracts/test/MockAutonetATN.sol`.
