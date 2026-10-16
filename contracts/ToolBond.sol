// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./ProposalLifecycle.sol";

/// @notice The parts of the autonet Substrate a bond needs: tool authorship and the ATN token.
interface IToolBondSubstrate {
    function toolAuthor(bytes32 manifestDigest) external view returns (address);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function payForService(address recipient, uint256 amount, bytes32 requestId) external returns (bool);
}

/// @notice The parts of the jurisdiction RepToken the verdicts need: snapshots and slashing.
interface IToolBondRep {
    function balanceOf(address account) external view returns (uint256);
    function getPastBalance(address account, uint256 timepoint) external view returns (uint256);
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256);
    function slash(address from, uint256 amount) external returns (uint256);
    function reassign(address to, uint256 amount) external;
}

/// @title ToolBond
/// @notice ATN stakes behind autonet tools, and REP-settled verdicts on whether a tool is malware.
///         The harness runs a tool only while `isBonded(digest)`, and by default only once it is
///         also `isVetted(digest)`.
///
///         Auditors flag a tool green ("checked, clean") or red ("malware", citing the code) by
///         commit-reveal, so nobody can copy a running tally. A flag weighs the auditor's REP at the
///         round's snapshot; auditors stake no ATN and zero REP weighs nothing. Once the committed
///         weight reaches `thresholdBps` of the snapshot supply, commits close and flags reveal. The
///         heavier color wins. Payouts wait out the jurisdiction's appeal window, during which the
///         DAO can overrule by proposal (the ERC20Project appeal model). Then:
///
///         Malware: the finder (earliest red commit) takes `finderBps` of the stake, the red flaggers
///         split the rest by REP, all through Substrate.payForService so it counts as their service
///         earnings. The author loses `authorSlashBps` of their REP and the digest can never be
///         bonded again. Clean: the green flaggers become the tool's auditors and split
///         `auditorShareBps` of its mints by REP (applied by the daemon at epoch close). Either way the losing flaggers, and anyone who committed but
///         never revealed, lose `degradeBps` of their snapshot REP; all REP slashed in a round is
///         reassigned to the winners by weight. No REP is created: payouts never exceed what was slashed.
///
///         A clean tool stays bonded and a new round can open on new evidence.
contract ToolBond {
    enum Stage { None, Commit, Reveal, Cooling, Finalizing, Done }
    enum Verdict { None, Clean, Malware, Void }

    struct Bond {
        address author;
        uint256 stake;
        uint256 unbondRequestedAt; // 0 when bonded
        uint32 round;              // current (or last) round
        bool vetted;               // a round finalized clean
        bool slashed;              // a round finalized malware
    }

    struct Round {
        Stage stage;
        Verdict verdict;
        bool overruled;
        uint48 snapshot;
        uint48 openedAt;
        uint48 revealEnds;
        uint48 appealEnds;
        uint256 threshold;     // REP weight that closes commits
        uint256 committed;     // total committed weight
        uint256 greenWeight;   // revealed
        uint256 redWeight;     // revealed
        address finder;        // earliest revealed red commit
        uint32 finderIndex;
        uint32 processed;      // auditors processed by finalize
        uint256 repPool;       // REP slashed this round, reassigned to winners
        uint256 atnPool;       // stake left for winners after the finder's share
        uint256 winnerWeight;
        address[] auditors;
    }

    struct Flag {
        bytes32 commitment;
        uint256 weight;
        uint32 index;
        bool revealed;
        bool red;
        bool claimed;
        bytes32 evidenceHash;
    }

    uint256 public constant BPS = 10_000;

    IToolBondSubstrate public immutable substrate;
    IToolBondRep public immutable rep;
    address public immutable governor; // with the timelock, the proposal lifecycle that floors the appeal window
    address public immutable timelock;

    uint256 public minStake;        // ATN base units behind each tool
    uint256 public thresholdBps;    // share of snapshot REP supply that settles a round
    uint256 public reviewWindow;    // seconds a round may stay below threshold before it lapses
    uint256 public revealWindow;    // seconds to reveal once the threshold is reached
    uint256 public finderBps;       // finder's share of a malicious tool's stake
    uint256 public degradeBps;      // share of snapshot REP a losing or silent flagger loses
    uint256 public authorSlashBps;  // share of REP a malicious tool's author loses
    uint256 public unbondDelay;     // seconds a stake stays reviewable after the author asks to leave
    uint256 public auditorShareBps; // share of a vetted tool's mints its auditors split (the daemon applies it)
    uint256 public appealPeriod;    // seconds to appeal a verdict to the DAO, never below one proposal lifecycle (appealWindow)

    mapping(bytes32 => Bond) public bonds;
    mapping(bytes32 => mapping(uint32 => Round)) private _rounds;
    mapping(bytes32 => mapping(uint32 => mapping(address => Flag))) public flags;

    event Bonded(bytes32 indexed digest, address indexed author, uint256 amount, uint256 stake);
    event UnbondRequested(bytes32 indexed digest, uint256 availableAt);
    event Unbonded(bytes32 indexed digest, address indexed author, uint256 amount);
    event RoundOpened(bytes32 indexed digest, uint32 indexed round, uint48 snapshot, uint256 threshold);
    event FlagCommitted(bytes32 indexed digest, uint32 indexed round, address indexed auditor, uint256 weight);
    event ThresholdReached(bytes32 indexed digest, uint32 indexed round, uint48 revealEnds);
    event FlagRevealed(bytes32 indexed digest, uint32 indexed round, address indexed auditor, bool red, bytes32 evidenceHash);
    event RoundLapsed(bytes32 indexed digest, uint32 indexed round);
    event VerdictReached(bytes32 indexed digest, uint32 indexed round, Verdict verdict, uint48 appealEnds);
    event Overruled(bytes32 indexed digest, uint32 indexed round, Verdict verdict);
    event Finalized(bytes32 indexed digest, uint32 indexed round, Verdict verdict, uint256 repPool, uint256 atnPool);
    event Claimed(bytes32 indexed digest, uint32 indexed round, address indexed auditor, uint256 atn, uint256 rep);
    event ParamsSet(uint256 minStake, uint256 thresholdBps, uint256 reviewWindow, uint256 revealWindow,
        uint256 finderBps, uint256 degradeBps, uint256 authorSlashBps, uint256 unbondDelay, uint256 auditorShareBps);

    event AppealPeriodSet(uint256 appealPeriod);

    error NotAuthor();
    error NotTimelock();
    error Slashed();
    error NotBonded();
    error RoundActive();
    error WrongStage();
    error TooEarly();
    error TooLate();
    error ZeroAmount();
    error NoWeight();
    error AlreadyFlagged();
    error BadReveal();
    error NothingToClaim();
    error BadParams();

    struct Params {
        uint256 minStake;
        uint256 thresholdBps;
        uint256 reviewWindow;
        uint256 revealWindow;
        uint256 finderBps;
        uint256 degradeBps;
        uint256 authorSlashBps;
        uint256 unbondDelay;
        uint256 auditorShareBps;
        uint256 appealPeriod;
    }

    constructor(address _substrate, address _rep, address _governor, address _timelock, Params memory p) {
        substrate = IToolBondSubstrate(_substrate);
        rep = IToolBondRep(_rep);
        governor = _governor;
        timelock = _timelock;
        _setParams(p);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// @notice Whether a tool has a live stake behind it. Unbonded tools leave the network's economy.
    function isBonded(bytes32 digest) public view returns (bool) {
        Bond storage b = bonds[digest];
        return !b.slashed && b.unbondRequestedAt == 0 && b.stake >= minStake && b.stake > 0;
    }

    /// @notice Bonded and found clean by a finalized round, with no malware verdict pending since:
    ///         what nodes run by default.
    function isVetted(bytes32 digest) external view returns (bool) {
        Bond storage b = bonds[digest];
        if (!isBonded(digest) || !b.vetted) return false;
        Round storage r = _rounds[digest][b.round];
        return !((r.stage == Stage.Cooling || r.stage == Stage.Finalizing) && r.verdict == Verdict.Malware);
    }

    /// @notice The appeal window after a verdict: appealPeriod, never shorter than one proposal
    ///         lifecycle plus two days, so the DAO always has time to overrule by proposal.
    function appealWindow() public view returns (uint256) {
        return ProposalLifecycle.appealWindow(appealPeriod, governor, timelock);
    }

    function getRound(bytes32 digest, uint32 round) external view returns (
        Stage stage, Verdict verdict, bool overruled, uint48 snapshot, uint48 revealEnds, uint48 appealEnds,
        uint256 threshold, uint256 committed, uint256 greenWeight, uint256 redWeight, address finder,
        uint256 auditorCount
    ) {
        Round storage r = _rounds[digest][round];
        return (r.stage, r.verdict, r.overruled, r.snapshot, r.revealEnds, r.appealEnds, r.threshold,
            r.committed, r.greenWeight, r.redWeight, r.finder, r.auditors.length);
    }

    function auditorAt(bytes32 digest, uint32 round, uint256 i) external view returns (address) {
        return _rounds[digest][round].auditors[i];
    }

    /// @notice The commitment an auditor submits: hides the color and evidence until reveal.
    function commitmentOf(bytes32 digest, uint32 round, address auditor, bool red, bytes32 evidenceHash, bytes32 salt)
        public pure returns (bytes32)
    {
        return keccak256(abi.encode(digest, round, auditor, red, evidenceHash, salt));
    }

    // ── Author ───────────────────────────────────────────────────────────────

    /// @notice Stake (or top up) ATN behind a tool. Only its Substrate author can; approve this contract first.
    ///         Topping up cancels a pending unbond.
    function bond(bytes32 digest, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (substrate.toolAuthor(digest) != msg.sender) revert NotAuthor();
        Bond storage b = bonds[digest];
        if (b.slashed) revert Slashed();
        b.author = msg.sender;
        b.stake += amount;
        b.unbondRequestedAt = 0;
        substrate.transferFrom(msg.sender, address(this), amount);
        emit Bonded(digest, msg.sender, amount, b.stake);
    }

    /// @notice Stop vouching for a tool. It stops counting as bonded at once, but a round can still open
    ///         until unbondDelay passes, and the stake stays until every open round is finished.
    function requestUnbond(bytes32 digest) external {
        Bond storage b = bonds[digest];
        if (msg.sender != b.author) revert NotAuthor();
        if (b.stake == 0) revert NotBonded();
        b.unbondRequestedAt = block.timestamp;
        emit UnbondRequested(digest, block.timestamp + unbondDelay);
    }

    function withdraw(bytes32 digest) external {
        Bond storage b = bonds[digest];
        if (msg.sender != b.author) revert NotAuthor();
        if (b.unbondRequestedAt == 0) revert NotBonded();
        if (block.timestamp < b.unbondRequestedAt + unbondDelay) revert TooEarly();
        if (_active(digest, b.round)) revert RoundActive();
        uint256 amount = b.stake;
        b.stake = 0;
        b.unbondRequestedAt = 0;
        b.vetted = false;
        substrate.transfer(msg.sender, amount);
        emit Unbonded(digest, msg.sender, amount);
    }

    // ── Flags ────────────────────────────────────────────────────────────────

    /// @notice Commit a hidden flag. The first commit on a tool with no active round opens one, with
    ///         its REP snapshot one second before. Commits close once the threshold is reached.
    function commitFlag(bytes32 digest, bytes32 commitment) external {
        Bond storage b = bonds[digest];
        if (b.stake == 0 || b.slashed) revert NotBonded();
        if (msg.sender == b.author) revert NotAuthor();
        if (b.unbondRequestedAt != 0 && block.timestamp >= b.unbondRequestedAt + unbondDelay) revert TooLate();

        Round storage r = _rounds[digest][b.round];
        if (r.stage == Stage.Commit && block.timestamp > r.openedAt + reviewWindow) {
            _lapse(digest, b);
            r = _rounds[digest][b.round];
        }
        if (r.stage == Stage.None || r.stage == Stage.Done) {
            if (r.stage == Stage.Done) b.round++;
            r = _rounds[digest][b.round];
            r.stage = Stage.Commit;
            r.openedAt = uint48(block.timestamp);
            r.snapshot = uint48(block.timestamp - 1);
            r.threshold = rep.getPastTotalSupply(r.snapshot) * thresholdBps / BPS;
            emit RoundOpened(digest, b.round, r.snapshot, r.threshold);
        }
        if (r.stage != Stage.Commit) revert WrongStage();

        Flag storage f = flags[digest][b.round][msg.sender];
        if (f.weight != 0) revert AlreadyFlagged();
        uint256 weight = rep.getPastBalance(msg.sender, r.snapshot);
        if (weight == 0) revert NoWeight();
        f.commitment = commitment;
        f.weight = weight;
        f.index = uint32(r.auditors.length);
        r.auditors.push(msg.sender);
        r.committed += weight;
        emit FlagCommitted(digest, b.round, msg.sender, weight);

        if (r.committed >= r.threshold) {
            r.stage = Stage.Reveal;
            r.revealEnds = uint48(block.timestamp + revealWindow);
            emit ThresholdReached(digest, b.round, r.revealEnds);
        }
    }

    /// @notice Reveal a committed flag. A red flag's evidence hash binds the exact malicious code it cites;
    ///         a green one binds the audit transcript. Both stay off-chain as evidence for an appeal.
    function revealFlag(bytes32 digest, bool red, bytes32 evidenceHash, bytes32 salt) external {
        uint32 round = bonds[digest].round;
        Round storage r = _rounds[digest][round];
        if (r.stage != Stage.Reveal) revert WrongStage();
        if (block.timestamp > r.revealEnds) revert TooLate();
        Flag storage f = flags[digest][round][msg.sender];
        if (f.weight == 0 || f.revealed) revert BadReveal();
        if (evidenceHash == bytes32(0)) revert BadReveal();
        if (commitmentOf(digest, round, msg.sender, red, evidenceHash, salt) != f.commitment) revert BadReveal();
        f.revealed = true;
        f.red = red;
        f.evidenceHash = evidenceHash;
        if (red) {
            r.redWeight += f.weight;
            if (r.finder == address(0) || f.index < r.finderIndex) {
                r.finder = msg.sender;
                r.finderIndex = f.index;
            }
        } else {
            r.greenWeight += f.weight;
        }
        emit FlagRevealed(digest, round, msg.sender, red, evidenceHash);
    }

    /// @notice After the reveal window, anyone records the crowd's verdict and starts the appeal window.
    function settle(bytes32 digest) external {
        uint32 round = bonds[digest].round;
        Round storage r = _rounds[digest][round];
        if (r.stage != Stage.Reveal) revert WrongStage();
        if (block.timestamp <= r.revealEnds) revert TooEarly();
        r.verdict = r.redWeight > r.greenWeight ? Verdict.Malware
            : r.greenWeight > r.redWeight ? Verdict.Clean : Verdict.Void;
        r.stage = Stage.Cooling;
        r.appealEnds = uint48(block.timestamp + appealWindow());
        emit VerdictReached(digest, round, r.verdict, r.appealEnds);
    }

    /// @notice Close a round that never reached its threshold. Nothing is paid or slashed.
    function lapse(bytes32 digest) external {
        Bond storage b = bonds[digest];
        Round storage r = _rounds[digest][b.round];
        if (r.stage != Stage.Commit) revert WrongStage();
        if (block.timestamp <= r.openedAt + reviewWindow) revert TooEarly();
        _lapse(digest, b);
    }

    /// @notice The DAO's decision on appeal, by proposal, within the appeal window. It is final:
    ///         finalization may follow at once.
    function daoOverrule(bytes32 digest, bool malware) external {
        if (msg.sender != timelock) revert NotTimelock();
        uint32 round = bonds[digest].round;
        Round storage r = _rounds[digest][round];
        if (r.stage != Stage.Cooling) revert WrongStage();
        if (block.timestamp > r.appealEnds) revert TooLate();
        r.verdict = malware ? Verdict.Malware : Verdict.Clean;
        r.overruled = true;
        emit Overruled(digest, round, r.verdict);
    }

    /// @notice Enforce the verdict once the appeal window has passed (or the DAO has ruled). Processes up
    ///         to `maxAuditors` flaggers per call so any number of them fits; call again until Done.
    function finalize(bytes32 digest, uint256 maxAuditors) external {
        Bond storage b = bonds[digest];
        uint32 round = b.round;
        Round storage r = _rounds[digest][round];
        if (r.stage == Stage.Cooling) {
            if (!r.overruled && block.timestamp <= r.appealEnds) revert TooEarly();
            r.stage = Stage.Finalizing;
        } else if (r.stage != Stage.Finalizing) {
            revert WrongStage();
        }

        // Losers and silent committers lose part of their snapshot REP, into this round's pool
        uint256 end = r.processed + maxAuditors;
        if (end > r.auditors.length) end = r.auditors.length;
        for (uint256 i = r.processed; i < end; i++) {
            address a = r.auditors[i];
            Flag storage f = flags[digest][round][a];
            if (_wins(r.verdict, f)) {
                r.winnerWeight += f.weight;
            } else if (!f.revealed || r.verdict != Verdict.Void) {
                r.repPool += rep.slash(a, f.weight * degradeBps / BPS);
            }
        }
        r.processed = uint32(end);
        if (end < r.auditors.length) return;

        if (r.verdict == Verdict.Malware) {
            r.repPool += rep.slash(b.author, rep.balanceOf(b.author) * authorSlashBps / BPS);
            uint256 stake = b.stake;
            b.stake = 0;
            b.unbondRequestedAt = 0;
            b.slashed = true;
            b.vetted = false;
            uint256 finderShare = r.finder == address(0) ? 0 : stake * finderBps / BPS;
            r.atnPool = stake - finderShare;
            // Through the service rail, so the bounty counts as the finder's earnings
            if (finderShare > 0) substrate.payForService(r.finder, finderShare, digest);
            // A DAO malware verdict with no red flaggers: the stake goes to the jurisdiction
            if (r.winnerWeight == 0 && r.atnPool > 0) {
                substrate.transfer(timelock, r.atnPool);
                r.atnPool = 0;
            }
        } else if (r.verdict == Verdict.Clean) {
            b.vetted = true;
        }
        r.stage = Stage.Done;
        emit Finalized(digest, round, r.verdict, r.repPool, r.atnPool);
    }

    /// @notice A winning flagger's share of a finalized round: slashed REP and, on malware, the stake.
    function claim(bytes32 digest, uint32 round) external {
        Round storage r = _rounds[digest][round];
        if (r.stage != Stage.Done) revert WrongStage();
        Flag storage f = flags[digest][round][msg.sender];
        if (f.claimed || !_wins(r.verdict, f)) revert NothingToClaim();
        f.claimed = true;
        uint256 repShare = r.repPool * f.weight / r.winnerWeight;
        uint256 atnShare = r.atnPool * f.weight / r.winnerWeight;
        if (repShare > 0) rep.reassign(msg.sender, repShare);
        if (atnShare > 0) substrate.payForService(msg.sender, atnShare, digest);
        emit Claimed(digest, round, msg.sender, atnShare, repShare);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    function _wins(Verdict v, Flag storage f) private view returns (bool) {
        if (!f.revealed) return false;
        return (v == Verdict.Malware && f.red) || (v == Verdict.Clean && !f.red);
    }

    function _active(bytes32 digest, uint32 round) private view returns (bool) {
        Round storage r = _rounds[digest][round];
        if (r.stage == Stage.Commit) return block.timestamp <= r.openedAt + reviewWindow;
        return r.stage != Stage.None && r.stage != Stage.Done;
    }

    function _lapse(bytes32 digest, Bond storage b) private {
        Round storage r = _rounds[digest][b.round];
        r.stage = Stage.Done;
        r.verdict = Verdict.Void;
        emit RoundLapsed(digest, b.round);
    }

    // ── Governance ───────────────────────────────────────────────────────────

    function setParams(Params calldata p) external {
        if (msg.sender != timelock) revert NotTimelock();
        _setParams(p);
    }

    function _setParams(Params memory p) private {
        if (p.thresholdBps == 0 || p.thresholdBps > BPS || p.finderBps > BPS || p.degradeBps > BPS
            || p.authorSlashBps > BPS || p.auditorShareBps > BPS || p.reviewWindow == 0 || p.revealWindow == 0) revert BadParams();
        // A stake must stay put for at least one full review, so an author can't leave the moment flags pile up
        if (p.unbondDelay < p.reviewWindow) revert BadParams();
        minStake = p.minStake;
        thresholdBps = p.thresholdBps;
        reviewWindow = p.reviewWindow;
        revealWindow = p.revealWindow;
        finderBps = p.finderBps;
        degradeBps = p.degradeBps;
        authorSlashBps = p.authorSlashBps;
        unbondDelay = p.unbondDelay;
        auditorShareBps = p.auditorShareBps;
        appealPeriod = p.appealPeriod;
        emit AppealPeriodSet(p.appealPeriod);
        emit ParamsSet(p.minStake, p.thresholdBps, p.reviewWindow, p.revealWindow, p.finderBps, p.degradeBps,
            p.authorSlashBps, p.unbondDelay, p.auditorShareBps);
    }
}
