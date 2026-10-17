// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./ProposalLifecycle.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice The parts of the jurisdiction RepToken the verdicts need: snapshots and slashing.
interface IContentCourtRep {
    function getPastBalance(address account, uint256 timepoint) external view returns (uint256);
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256);
    function slash(address from, uint256 amount) external returns (uint256);
    function reassign(address to, uint256 amount) external;
}

/// @title ContentCourt
/// @notice REP-weighted labels on third-party content (a YouTube video, a post), applied by the
///         jurisdiction's members through a browser extension and settled on-chain only when contested.
///
///         Labels live off-chain. A member binds a signing key (held by their extension) to their address
///         with `setLabelKey`, and the key signs EIP-712 `Label`s: a subject (keccak256 of "yt:<videoId>"),
///         a label from the DAO's taxonomy, a value in basis points (5000 or more asserts the label
///         applies) and the time it was issued. Clients weigh each label by its holder's REP, counting
///         only labels whose key was bound at `issuedAt`, so every counted label is attributable here.
///
///         Anyone can contest a (subject, label) pair by opening a case with a deposit. REP holders vote
///         by commit-reveal: the round closes once committed weight reaches `thresholdBps`
///         of the snapshot supply, the heavier side wins, and payouts wait out the jurisdiction's appeal
///         window, during which the DAO can overrule by proposal. While the case is open, anyone can
///         submit signed off-chain labels on the pair as evidence. Then:
///
///         Losing and silent jurors lose `degradeBps` of their snapshot REP; holders whose submitted labels
///         asserted the losing side lose `assertionSlashBps` of theirs. All of it is reassigned to the
///         winning jurors by weight, so no REP is created. The verdict becomes the pair's on-chain
///         `standing`, which clients apply over their own tally. The deposit returns to the opener unless
///         the verdict went against them (or the case lapsed), in which case it goes to the treasury.
contract ContentCourt is EIP712, ReentrancyGuard {
    enum Stage { None, Commit, Reveal, Cooling, Finalizing, Done }
    enum Verdict { None, Applies, Rejected, Void }

    struct Label {
        bytes32 subject;
        bytes32 label;
        uint16 value;     // basis points; >= 5000 asserts the label applies
        uint48 issuedAt;
    }

    struct LabelKey {
        address holder;   // bound forever: a key never moves to another holder
        uint48 validFrom;
        uint48 validUntil;
        bool revoked;     // permanent, so an old grant signature can't revive the key
    }

    struct Case {
        bytes32 subject;
        bytes32 label;
        address opener;
        bool openerApplies;   // the side the opener argues
        uint256 deposit;
        Stage stage;
        Verdict verdict;
        bool overruled;
        uint48 snapshot;
        uint48 openedAt;
        uint48 revealEnds;
        uint48 appealEnds;
        uint256 threshold;
        uint256 committed;
        uint256 appliesWeight;
        uint256 rejectsWeight;
        uint32 processed;     // jurors, then asserters, processed by finalize
        uint256 repPool;      // REP slashed this case, reassigned to winning jurors
        uint256 winnerWeight;
        address[] jurors;
        address[] asserters;
    }

    struct Vote {
        bytes32 commitment;
        uint256 weight;
        bool revealed;
        bool applies;
        bool claimed;
        bytes32 evidenceHash;
    }

    struct Assertion {
        uint256 weight;
        bool appliesSeen;  // some submitted label asserted the label applies
        bool rejectsSeen;  // some submitted label asserted it doesn't
    }

    struct Params {
        uint256 caseDeposit;       // native currency to open a case
        uint256 thresholdBps;      // share of snapshot REP supply that closes commits
        uint256 reviewWindow;      // seconds a case may stay below threshold before it lapses
        uint256 revealWindow;      // seconds to reveal once the threshold is reached
        uint256 degradeBps;        // share of snapshot REP a losing or silent juror loses
        uint256 assertionSlashBps; // share of snapshot REP a holder loses per losing off-chain label
        uint256 appealPeriod;      // seconds to appeal a verdict to the DAO, never below one proposal lifecycle
    }

    uint256 public constant BPS = 10_000;
    bytes32 public constant LABEL_TYPEHASH =
        keccak256("Label(bytes32 subject,bytes32 label,uint16 value,uint48 issuedAt)");
    bytes32 public constant KEY_GRANT_TYPEHASH = keccak256("KeyGrant(address holder,uint48 validUntil)");

    IContentCourtRep public immutable rep;
    address public immutable governor; // with the timelock, the proposal lifecycle that floors the appeal window
    address public immutable timelock;
    address payable public immutable treasury;

    uint256 public caseDeposit;
    uint256 public thresholdBps;
    uint256 public reviewWindow;
    uint256 public revealWindow;
    uint256 public degradeBps;
    uint256 public assertionSlashBps;
    uint256 public appealPeriod;

    mapping(bytes32 => bool) public labelActive;   // the DAO's taxonomy, by keccak256(name)
    mapping(address => LabelKey) public labelKeys;
    mapping(bytes32 => mapping(bytes32 => Verdict)) public standing; // subject => label => last final verdict
    mapping(bytes32 => mapping(bytes32 => uint256)) public latestCase; // subject => label => case id (0 = none)
    mapping(address => uint256) public refunds;     // deposits owed back to openers

    uint256 public caseCount;
    mapping(uint256 => Case) private _cases;
    mapping(uint256 => mapping(address => Vote)) public votes;
    mapping(uint256 => mapping(address => Assertion)) public assertions;

    event LabelKeySet(address indexed key, address indexed holder, uint48 validUntil);
    event LabelKeyRevoked(address indexed key, address indexed holder);
    event LabelSet(bytes32 indexed label, string name, bool active);
    event CaseOpened(uint256 indexed caseId, bytes32 indexed subject, bytes32 indexed label, address opener,
        bool openerApplies, uint48 snapshot, uint256 threshold);
    event VoteCommitted(uint256 indexed caseId, address indexed juror, uint256 weight);
    event ThresholdReached(uint256 indexed caseId, uint48 revealEnds);
    event VoteRevealed(uint256 indexed caseId, address indexed juror, bool applies, bytes32 evidenceHash);
    event AssertionSubmitted(uint256 indexed caseId, address indexed holder, address key, bool applies, uint48 issuedAt);
    event CaseLapsed(uint256 indexed caseId);
    event VerdictReached(uint256 indexed caseId, Verdict verdict, uint48 appealEnds);
    event Overruled(uint256 indexed caseId, Verdict verdict);
    event Finalized(uint256 indexed caseId, Verdict verdict, uint256 repPool);
    event Claimed(uint256 indexed caseId, address indexed juror, uint256 rep);
    event Refunded(address indexed opener, uint256 amount);
    event ParamsSet(uint256 caseDeposit, uint256 thresholdBps, uint256 reviewWindow, uint256 revealWindow,
        uint256 degradeBps, uint256 assertionSlashBps, uint256 appealPeriod);

    error NotTimelock();
    error NotHolder();
    error KeyTaken();
    error KeyRevoked();
    error BadSignature();
    error BadExpiry();
    error UnknownLabel();
    error CaseActive();
    error BadDeposit();
    error WrongStage();
    error TooEarly();
    error TooLate();
    error NoWeight();
    error AlreadyVoted();
    error BadReveal();
    error BadAssertion();
    error NothingToClaim();
    error BadParams();
    error TransferFailed();

    constructor(address _rep, address _governor, address _timelock, address payable _treasury, Params memory p)
        EIP712("ContentCourt", "1")
    {
        rep = IContentCourtRep(_rep);
        governor = _governor;
        timelock = _timelock;
        treasury = _treasury;
        _setParams(p);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// @notice The holder a key signed for at `at`, or zero if it wasn't bound then.
    function holderOf(address key, uint48 at) public view returns (address) {
        LabelKey storage k = labelKeys[key];
        if (k.holder == address(0) || at < k.validFrom || at > k.validUntil) return address(0);
        return k.holder;
    }

    /// @notice The appeal window after a verdict: appealPeriod, never shorter than one proposal
    ///         lifecycle plus two days, so the DAO always has time to overrule by proposal.
    function appealWindow() public view returns (uint256) {
        return ProposalLifecycle.appealWindow(appealPeriod, governor, timelock);
    }

    function getCase(uint256 caseId) external view returns (
        bytes32 subject, bytes32 label, address opener, bool openerApplies, Stage stage, Verdict verdict,
        bool overruled, uint48 snapshot, uint48 revealEnds, uint48 appealEnds, uint256 threshold,
        uint256 committed, uint256 appliesWeight, uint256 rejectsWeight, uint256 jurorCount, uint256 asserterCount
    ) {
        Case storage c = _cases[caseId];
        return (c.subject, c.label, c.opener, c.openerApplies, c.stage, c.verdict, c.overruled, c.snapshot,
            c.revealEnds, c.appealEnds, c.threshold, c.committed, c.appliesWeight, c.rejectsWeight,
            c.jurors.length, c.asserters.length);
    }

    function jurorAt(uint256 caseId, uint256 i) external view returns (address) {
        return _cases[caseId].jurors[i];
    }

    function asserterAt(uint256 caseId, uint256 i) external view returns (address) {
        return _cases[caseId].asserters[i];
    }

    /// @notice The commitment a juror submits: hides the side and evidence until reveal.
    function commitmentOf(uint256 caseId, address juror, bool applies, bytes32 evidenceHash, bytes32 salt)
        public pure returns (bytes32)
    {
        return keccak256(abi.encode(caseId, juror, applies, evidenceHash, salt));
    }

    /// @notice The EIP-712 digest a key signs for a label.
    function labelDigest(Label calldata l) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(LABEL_TYPEHASH, l.subject, l.label, l.value, l.issuedAt)));
    }

    function keyGrantDigest(address holder, uint48 validUntil) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(KEY_GRANT_TYPEHASH, holder, validUntil)));
    }

    // ── Keys ─────────────────────────────────────────────────────────────────

    /// @notice Bind a signing key to the caller until `validUntil`, or extend it. The key consents by
    ///         signing a KeyGrant, so nobody can claim someone else's key.
    function setLabelKey(address key, uint48 validUntil, bytes calldata keySig) external {
        if (validUntil <= block.timestamp) revert BadExpiry();
        if (ECDSA.recover(keyGrantDigest(msg.sender, validUntil), keySig) != key) revert BadSignature();
        LabelKey storage k = labelKeys[key];
        if (k.revoked) revert KeyRevoked();
        if (k.holder == address(0)) {
            k.holder = msg.sender;
            k.validFrom = uint48(block.timestamp);
        } else if (k.holder != msg.sender) {
            revert KeyTaken();
        }
        k.validUntil = validUntil;
        emit LabelKeySet(key, msg.sender, validUntil);
    }

    /// @notice Stop a key for good. Labels it signed before now stay attributable to the holder.
    function revokeLabelKey(address key) external {
        LabelKey storage k = labelKeys[key];
        if (k.holder != msg.sender) revert NotHolder();
        if (k.revoked) revert KeyRevoked();
        k.revoked = true;
        if (k.validUntil > block.timestamp) k.validUntil = uint48(block.timestamp);
        emit LabelKeyRevoked(key, msg.sender);
    }

    // ── Cases ────────────────────────────────────────────────────────────────

    /// @notice Contest a label on a piece of content, arguing that it applies or that it doesn't.
    function openCase(bytes32 subject, bytes32 label, bool applies) external payable returns (uint256 caseId) {
        if (!labelActive[label]) revert UnknownLabel();
        if (msg.value != caseDeposit) revert BadDeposit();
        uint256 prev = latestCase[subject][label];
        if (prev != 0 && _cases[prev].stage != Stage.Done) {
            Case storage p = _cases[prev];
            if (p.stage != Stage.Commit || block.timestamp <= p.openedAt + reviewWindow) revert CaseActive();
            _lapse(prev);
        }

        caseId = ++caseCount;
        latestCase[subject][label] = caseId;
        Case storage c = _cases[caseId];
        c.subject = subject;
        c.label = label;
        c.opener = msg.sender;
        c.openerApplies = applies;
        c.deposit = msg.value;
        c.stage = Stage.Commit;
        c.openedAt = uint48(block.timestamp);
        c.snapshot = uint48(block.timestamp - 1);
        c.threshold = rep.getPastTotalSupply(c.snapshot) * thresholdBps / BPS;
        emit CaseOpened(caseId, subject, label, msg.sender, applies, c.snapshot, c.threshold);
    }

    /// @notice Commit a hidden vote. Commits close once the threshold is reached.
    function commitVote(uint256 caseId, bytes32 commitment) external {
        Case storage c = _cases[caseId];
        if (c.stage != Stage.Commit) revert WrongStage();
        if (block.timestamp > c.openedAt + reviewWindow) revert TooLate();
        Vote storage v = votes[caseId][msg.sender];
        if (v.weight != 0) revert AlreadyVoted();
        uint256 weight = rep.getPastBalance(msg.sender, c.snapshot);
        if (weight == 0) revert NoWeight();
        v.commitment = commitment;
        v.weight = weight;
        c.jurors.push(msg.sender);
        c.committed += weight;
        emit VoteCommitted(caseId, msg.sender, weight);

        if (c.committed >= c.threshold) {
            c.stage = Stage.Reveal;
            c.revealEnds = uint48(block.timestamp + revealWindow);
            emit ThresholdReached(caseId, c.revealEnds);
        }
    }

    /// @notice Reveal a committed vote. The evidence hash binds the juror's reasoning, kept off-chain for an appeal.
    function revealVote(uint256 caseId, bool applies, bytes32 evidenceHash, bytes32 salt) external {
        Case storage c = _cases[caseId];
        if (c.stage != Stage.Reveal) revert WrongStage();
        if (block.timestamp > c.revealEnds) revert TooLate();
        Vote storage v = votes[caseId][msg.sender];
        if (v.weight == 0 || v.revealed) revert BadReveal();
        if (evidenceHash == bytes32(0)) revert BadReveal();
        if (commitmentOf(caseId, msg.sender, applies, evidenceHash, salt) != v.commitment) revert BadReveal();
        v.revealed = true;
        v.applies = applies;
        v.evidenceHash = evidenceHash;
        if (applies) c.appliesWeight += v.weight;
        else c.rejectsWeight += v.weight;
        emit VoteRevealed(caseId, msg.sender, applies, evidenceHash);
    }

    /// @notice Put a member's signed off-chain label on the case's pair on record, until the case finalizes.
    ///         `issuedAt` is the signer's own claim, so labels can't be ordered: a holder answers for every
    ///         label they signed on the pair, and a later label never cancels an earlier one. A holder who
    ///         signed both sides loses either way, but only once.
    function submitAssertion(uint256 caseId, Label calldata l, bytes calldata sig) external {
        Case storage c = _cases[caseId];
        if (c.stage != Stage.Commit && c.stage != Stage.Reveal && c.stage != Stage.Cooling) revert WrongStage();
        if (l.subject != c.subject || l.label != c.label || l.value > BPS) revert BadAssertion();
        address key = ECDSA.recover(labelDigest(l), sig);
        address holder = holderOf(key, l.issuedAt);
        if (holder == address(0)) revert BadSignature();

        Assertion storage a = assertions[caseId][holder];
        bool applies = l.value >= BPS / 2;
        if (applies ? a.appliesSeen : a.rejectsSeen) revert BadAssertion();
        if (!a.appliesSeen && !a.rejectsSeen) {
            c.asserters.push(holder);
            a.weight = rep.getPastBalance(holder, c.snapshot);
        }
        if (applies) a.appliesSeen = true;
        else a.rejectsSeen = true;
        emit AssertionSubmitted(caseId, holder, key, applies, l.issuedAt);
    }

    /// @notice After the reveal window, anyone records the verdict and starts the appeal window.
    function settle(uint256 caseId) external {
        Case storage c = _cases[caseId];
        if (c.stage != Stage.Reveal) revert WrongStage();
        if (block.timestamp <= c.revealEnds) revert TooEarly();
        c.verdict = c.appliesWeight > c.rejectsWeight ? Verdict.Applies
            : c.rejectsWeight > c.appliesWeight ? Verdict.Rejected : Verdict.Void;
        c.stage = Stage.Cooling;
        c.appealEnds = uint48(block.timestamp + appealWindow());
        emit VerdictReached(caseId, c.verdict, c.appealEnds);
    }

    /// @notice Close a case that never reached its threshold. Nobody is slashed; the deposit goes to the treasury.
    function lapse(uint256 caseId) external {
        Case storage c = _cases[caseId];
        if (c.stage != Stage.Commit) revert WrongStage();
        if (block.timestamp <= c.openedAt + reviewWindow) revert TooEarly();
        _lapse(caseId);
    }

    /// @notice The DAO's decision on appeal, by proposal, within the appeal window. Final at once.
    function daoOverrule(uint256 caseId, bool applies) external {
        if (msg.sender != timelock) revert NotTimelock();
        Case storage c = _cases[caseId];
        if (c.stage != Stage.Cooling) revert WrongStage();
        if (block.timestamp > c.appealEnds) revert TooLate();
        c.verdict = applies ? Verdict.Applies : Verdict.Rejected;
        c.overruled = true;
        emit Overruled(caseId, c.verdict);
    }

    /// @notice Enforce the verdict once the appeal window has passed (or the DAO has ruled). Processes up to
    ///         `max` jurors and asserters per call so any number fits; call again until Done.
    function finalize(uint256 caseId, uint256 max) external nonReentrant {
        Case storage c = _cases[caseId];
        if (c.stage == Stage.Cooling) {
            if (!c.overruled && block.timestamp <= c.appealEnds) revert TooEarly();
            c.stage = Stage.Finalizing;
        } else if (c.stage != Stage.Finalizing) {
            revert WrongStage();
        }

        uint256 nj = c.jurors.length;
        uint256 total = nj + c.asserters.length;
        uint256 end = c.processed + max;
        if (end > total) end = total;
        bool decided = c.verdict != Verdict.Void;
        bool appliesWon = c.verdict == Verdict.Applies;
        for (uint256 i = c.processed; i < end; i++) {
            if (i < nj) {
                address j = c.jurors[i];
                Vote storage v = votes[caseId][j];
                if (_wins(c.verdict, v)) {
                    c.winnerWeight += v.weight;
                } else if (!v.revealed || decided) {
                    c.repPool += rep.slash(j, v.weight * degradeBps / BPS);
                }
            } else {
                address h = c.asserters[i - nj];
                Assertion storage a = assertions[caseId][h];
                if (decided && (appliesWon ? a.rejectsSeen : a.appliesSeen)) {
                    c.repPool += rep.slash(h, a.weight * assertionSlashBps / BPS);
                }
            }
        }
        c.processed = uint32(end);
        if (end < total) return;

        if (decided) standing[c.subject][c.label] = c.verdict;
        c.stage = Stage.Done;
        // The opener gets the deposit back unless the verdict went against them
        if (!decided || c.openerApplies == appliesWon) {
            refunds[c.opener] += c.deposit;
        } else {
            _toTreasury(c.deposit);
        }
        emit Finalized(caseId, c.verdict, c.repPool);
    }

    /// @notice A winning juror's share of the REP slashed in a finalized case.
    function claim(uint256 caseId) external {
        Case storage c = _cases[caseId];
        if (c.stage != Stage.Done) revert WrongStage();
        Vote storage v = votes[caseId][msg.sender];
        if (v.claimed || !_wins(c.verdict, v)) revert NothingToClaim();
        v.claimed = true;
        uint256 share = c.repPool * v.weight / c.winnerWeight;
        if (share > 0) rep.reassign(msg.sender, share);
        emit Claimed(caseId, msg.sender, share);
    }

    /// @notice Withdraw returned deposits.
    function withdrawRefund() external nonReentrant {
        uint256 amount = refunds[msg.sender];
        if (amount == 0) revert NothingToClaim();
        refunds[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Refunded(msg.sender, amount);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    function _wins(Verdict verdict, Vote storage v) private view returns (bool) {
        if (!v.revealed) return false;
        return (verdict == Verdict.Applies && v.applies) || (verdict == Verdict.Rejected && !v.applies);
    }

    function _lapse(uint256 caseId) private {
        Case storage c = _cases[caseId];
        c.stage = Stage.Done;
        c.verdict = Verdict.Void;
        _toTreasury(c.deposit);
        emit CaseLapsed(caseId);
    }

    function _toTreasury(uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = treasury.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ── Governance ───────────────────────────────────────────────────────────

    /// @notice Add or retire a label in the taxonomy. Retiring one stops new cases; standings remain.
    function setLabel(string calldata name, bool active) external {
        if (msg.sender != timelock) revert NotTimelock();
        bytes32 id = keccak256(bytes(name));
        labelActive[id] = active;
        emit LabelSet(id, name, active);
    }

    function setParams(Params calldata p) external {
        if (msg.sender != timelock) revert NotTimelock();
        _setParams(p);
    }

    function _setParams(Params memory p) private {
        if (p.thresholdBps == 0 || p.thresholdBps > BPS || p.degradeBps > BPS || p.assertionSlashBps > BPS
            || p.reviewWindow == 0 || p.revealWindow == 0) revert BadParams();
        caseDeposit = p.caseDeposit;
        thresholdBps = p.thresholdBps;
        reviewWindow = p.reviewWindow;
        revealWindow = p.revealWindow;
        degradeBps = p.degradeBps;
        assertionSlashBps = p.assertionSlashBps;
        appealPeriod = p.appealPeriod;
        emit ParamsSet(p.caseDeposit, p.thresholdBps, p.reviewWindow, p.revealWindow, p.degradeBps, p.assertionSlashBps,
            p.appealPeriod);
    }
}
