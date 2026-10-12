# Immediate Release

Backers can mark part of each contribution as **immediate**: it is paid to the contractor when the contract is signed, as operating capital. The rest is **locked** in escrow until the project closes. Backers price their trust in the contractor through the split.

Implemented in `contracts/NativeProject.sol` and `contracts/ERC20Project.sol`; the cap lives on `contracts/Economy.sol`. For the full project lifecycle see [economy.md](economy.md); for the parameter see [registry-settings.md](registry-settings.md).

## Rules

| Rule | Behaviour |
|------|-----------|
| Cap | Each contribution's `immediateBps <= economy.maxImmediateBps()`. Default 2000 (20%), DAO-settable up to 5000 (50%) via `setMaxImmediateBps` |
| Fees | The immediate payout goes through the same fee path as escrow: platform fee to the Registry, author fee to the author, net to the contractor |
| Voting | Release/dispute weight is the backer's locked amount only. A backer with nothing locked cannot vote |
| Quorum base | `totalLocked` (immediate funds are excluded) |
| Arbitration fee base | `totalLocked * arbitrationFeeBps / 10000`, computed at signing |
| Before signing | Withdrawals return the full contribution, immediate included |
| DAO veto before signing | Backers get the immediate portion back too |
| After signing | Immediate funds are gone for good; no outcome claws them back |
| Defaults | Plain `sendFunds()`, native `receive()`, and the author's funding at `createProject` are 0% immediate |

## Functions

```solidity
// NativeProject
function sendFundsWithImmediate(uint immediateBps) public payable;
function sendFunds() public payable;                  // 0% immediate

// ERC20Project (caller approves the project first)
function sendFundsWithImmediate(uint256 amount, uint immediateBps) public;
function sendFunds(uint256 amount) public;            // 0% immediate
```

Allowed in Open and Pending. Emits `SendFunds(who, amount, immediateBps)`.

## Accounting

Per backer, amounts are stored rather than derived, so repeated contributions with different splits accumulate exactly:

```solidity
struct Contribution { uint total; uint immediate; uint locked; }
mapping(address => Contribution) public contributions;

uint public totalImmediate;     // sum of immediate portions
uint public totalLocked;        // sum of locked portions
uint public immediateReleased;  // set to totalImmediate at signing; 0 means never signed
```

`immediate = amount * immediateBps / 10000`, `locked = amount - immediate`.

At `signContract()`: the arbitration fee is fixed from `totalLocked`, the contractor stakes half, `immediateReleased = totalImmediate`, and `totalImmediate` is paid out through `_payWithFees`. `ImmediateFundsReleased(contractor, net)` reports the contractor's net.

## After close

A closed project only distributes locked funds. `percent` (arbiter or DAO ruling) applies to the locked pool, not to the original total, so immediate funds are not counted against the contractor's share:

```
no arbitration:   backer exit = locked * (100 - disputeResolution) / 100
                  (+ immediate, if the contract was never signed)
arbitration:      pool = totalLocked - (arbitrationFee - arbitrationFee / 2)
                  contractor = pool * percent / 100
                  backer exit = pool * (100 - percent) / 100 * locked / totalLocked
```

What the backer spent, `spentBy(backer) = total - exit`, includes the immediate portion whenever the contract was signed. That is the basis for the backer's REP (see [economy.md](economy.md#reputation)).

## Example

Backer A gives 6,000 at 20% immediate, backer B gives 4,000 at 0%. Platform and author fees 1%, arbitration fee 10%.

| | A | B | Total |
|---|---|---|---|
| Immediate | 1,200 | 0 | 1,200 |
| Locked (vote weight) | 4,800 | 4,000 | 8,800 |

At signing the contractor stakes 440 and receives 1,200 - 12 platform - 11.88 author = 1,176.12.

If arbitration ends at 50%: pool = 8,800 - 440 = 8,360. Contractor gross 4,180. A gets 4,180 * 4,800 / 8,800 = 2,280; B gets 1,900. A spent 3,720, B spent 2,100.

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Contractor takes the advance and disappears | Backer chose the exposure; cap bounds it; the DAO can veto during cooling-off, which is at least a full proposal lifecycle (see [economy.md](economy.md#cooling-off)) |
| Contractor's sock puppet funds at high immediate % to control the vote | Immediate funds carry no vote |
| REP farming via immediate release plus `reimburse()` | Every REP-earning payout pays the platform fee (floor 1%), so each REP minted costs the farmer at least that fee in the treasury (`test/security.test.js`) |
| Arbitration leaves the contractor over-advanced | Accepted: the ruling splits only the locked pool; the advance is the backer's sunk risk |
