# ContentCourt

`contracts/ContentCourt.sol`. A jurisdiction satellite that lets members label third-party content (a YouTube video, a post) with the DAO's taxonomy, weighted by REP, and settles contested labels on-chain. A browser extension applies the labels in place (hide, blur, badge) for anyone who subscribes to the jurisdiction's feed. Sybil resistance comes from REP itself: weight is earned in the economy, not in moderation.

## Off-chain labels

Labels never touch the chain unless contested.

1. A member's extension generates a key. The key signs a `KeyGrant(address holder, uint48 validUntil)` and the member calls `setLabelKey(key, validUntil, keySig)` from their wallet. A key belongs to one holder forever; `revokeLabelKey` is permanent, so an old grant signature can't revive it.
2. The key signs EIP-712 `Label(bytes32 subject, bytes32 label, uint16 value, uint48 issuedAt)` under the domain `("ContentCourt", "1", chainId, address)`. `subject` is `keccak256("yt:<videoId>")`, `label` is `keccak256(name)`, `value` is in basis points (5000 or more asserts the label applies).
3. Labels travel over any transport (the extension uses Nostr relays). Clients weigh a label by `RepToken.balanceOf(holderOf(key, issuedAt))`, so every label they count is attributable here. `standing(subject, label)`, the last final verdict on the pair, overrides the client's tally.

## Cases

Anyone contests a pair with `openCase(subject, label, applies)` and exactly `caseDeposit` in native currency. REP holders vote by commit-reveal on a REP snapshot:

| Stage | What happens |
|-------|--------------|
| Commit | REP holders `commitVote` a hidden side, weighed at the snapshot one second before opening. Commits close when committed weight reaches `thresholdBps` of the snapshot supply. Below threshold after `reviewWindow`, the case lapses. |
| Reveal | `revealVote` within `revealWindow`. Then anyone calls `settle`: the heavier side wins, a tie is void. |
| Cooling | The appeal window, `appealWindow()`: `appealPeriod`, never shorter than one proposal lifecycle (the governor's voting delay and period plus the timelock delay, read live) plus two days. The timelock can `daoOverrule`, which is final at once. |
| Finalizing | `finalize(caseId, max)` in batches; then winning jurors `claim`. |

Until finalization, anyone can `submitAssertion(caseId, label, sig)`: a member's signed off-chain label on the pair. `issuedAt` is the signer's own claim, so labels can't be ordered; a holder answers for every label they signed on the pair, and a later one never cancels an earlier one. A holder who signed both sides is slashed once.

## Settlement

- Losing and silent jurors lose `degradeBps` of their snapshot REP (silent only, on a void case).
- Holders with a submitted label on the losing side lose `assertionSlashBps` of theirs (nothing on a void case).
- Everything slashed is reassigned to the winning jurors by weight, through `RepToken.slash` and `reassign`, so no REP is created. If the DAO overrules with no winning jurors, the slashed REP stays as the court's unspent credit.
- A decided verdict becomes `standing[subject][label]`.
- The deposit is refunded (pull, `withdrawRefund`) unless the verdict went against the opener; a lost or lapsed case sends it to the treasury.

## Governance

The timelock adds and retires labels (`setLabel(name, active)`) and sets `Params { caseDeposit, thresholdBps, reviewWindow, revealWindow, degradeBps, assertionSlashBps, appealPeriod }` (`ParamsSet`). The court needs slasher rights on the RepToken. It is the `content_court` [module](modules.md), with no dependencies: `ContentCourtSetup.prepareInstallation(core, abi.encode(Params))` deploys `ContentCourt(rep, governor, timelock, treasury, params)` (treasury = Registry), and attaching it grants the slasher rights and records `jurisdiction.content_court.court`, at origination or by proposal.

## Not yet

- Optimistic Merkle roots of the off-chain tally, so clients can verify feed snapshots instead of reading relays.
- An indexer for case events.
- Initial labels at installation (the taxonomy starts empty; the timelock adds labels with `setLabel`).
