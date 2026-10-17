// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./ProposalLifecycle.sol";

/// @notice The parts of the autonet Substrate a bond needs: tool authorship, the ATN token and the
///         anchored epochs.
interface IToolBondSubstrate {
    struct Anchor {
        string epochId;
        bytes32 epochRoot;
        bytes32 prevEpochRoot;
        bytes32 prevAnchorHash;
        string agentMintCid;
        bytes32 payloadHash;
        address submitter;
        uint256 blockNumber;
        uint256 timestamp;
        bytes32 agentMintRoot;
        uint256 windowBurned;
        uint256 mintPool;
        uint256 minted;
    }

    function toolAuthor(bytes32 manifestDigest) external view returns (address);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function payForService(address recipient, uint256 amount, bytes32 requestId) external returns (bool);
    function anchorCount() external view returns (uint256);
    function getAnchor(uint256 index) external view returns (Anchor memory);
    function deployedAt() external view returns (uint256);
}

/// @notice The parts of the jurisdiction RepToken the settlements need: snapshots and slashing.
interface IToolBondRep {
    function balanceOf(address account) external view returns (uint256);
    function getPastBalance(address account, uint256 timepoint) external view returns (uint256);
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256);
    function slash(address from, uint256 amount) external returns (uint256);
    function reassign(address to, uint256 amount) external;
}

/// @notice The jurisdiction Registry: the charter, and the treasury forfeits go to.
interface IToolBondRegistry {
    function getRegistryValue(string memory key) external view returns (string memory);
}

/// @title ToolBond
/// @notice ATN stakes behind autonet tools, and staked reviews that rate them.
///
///         Every published tool carries its author's ATN bond (any tool runs with the daemon's full
///         authority). A review scores a tool on each axis of the jurisdiction's charter, from -100 to
///         100, and on harm, from 0 (safe) to 100 (malicious). Ratings are a gradient: this contract
///         keeps, per tool and per axis, the REP-weighted rating and the REP mass behind it, and the
///         daemons, agents and their owners decide what is trustworthy enough to run.
///
///         Reviews follow the Substrate's epochs: epoch e runs from anchor e-1 (or the Substrate's
///         deployment) to anchor e. During the epoch each agent commits once, with an ATN stake of any
///         size, to a hidden batch of reviews; after anchor e the batch is revealed, by the agent or
///         by anyone holding its plaintext, within `revealWindow`. A review weighs the reviewer's REP
///         at the epoch's start. Each tool's reviews in an epoch form a round, which settles against
///         its own REP-weighted means:
///
///         - Accuracy: how close a review lands to the means, harm weighing `harmWeightBps` against a
///           charter axis's 10000. Each review loses stake x (1 - accuracy) to the round's pool and
///           gets the rest back; the pool goes to the reviews by stake x accuracy, through the
///           Substrate's service rail so only winnings count as earnings. No ATN is created.
///         - REP: each review loses REP x `degradeBps` x (1 - accuracy), reassigned to the reviews by
///           REP x accuracy. No REP is created.
///         - Harm: the settled harm H (the REP-weighted mean, or the DAO's on appeal) slashes H of the
///           author's bond and H x `authorSlashBps` of their REP. The slashed bond goes to the reviews
///           by REP x harm accuracy. Any H above zero waits out the appeal window first.
///
///         A round with no REP behind it settles nothing: its stakes are refunded. A batch never
///         revealed loses its whole stake to the treasury and `degradeBps` of its REP, the most a
///         revealed review could have cost, so revealing always beats withholding.
contract ToolBond {
    enum Stage { None, Open, Cooling, Finalizing, Done }

    struct Bond {
        address author;
        uint256 stake;
        uint256 unbondRequestedAt; // 0 when bonded
        uint256 unbondEpoch;       // the epoch the unbond was requested in
        uint32 pending;            // rounds on this tool not yet finalized
    }

    struct Epoch {
        bool started;
        uint8 axes;
        uint48 snapshot;           // REP timepoint: the epoch's start
        uint64 revealWindow;       // fixed when the epoch starts
        bytes32 charterHash;       // sha256 of the charter's registry value
        uint256 supply;            // REP supply at the snapshot
        bytes32[] axisIds;         // keccak256 of each charter axis id, in charter order
    }

    struct Commit {
        bytes32 commitment;
        uint128 stake;
        uint128 weight;            // REP at the epoch's snapshot
        bool revealed;
        bool forfeited;
    }

    /// @notice A review as committed and revealed. `scores` holds one int8 per charter axis (-100..100,
    ///         or -128 for no score), or nothing; `harm` is 0..100, or 255 for no score.
    struct ReviewInput {
        bytes32 digest;
        bytes scores;
        uint8 harm;
        uint256 stake;
        bytes32 evidenceHash;
    }

    struct Review {
        address reviewer;
        uint8 harm;
        bool claimed;
        uint64 accuracy;           // 1e18 scale; UNINFORMATIVE when nothing could be scored
        bytes16 scores;
        uint128 stake;
        uint128 weight;
        uint64 harmAccuracy;
    }

    struct Round {
        Stage stage;
        bool overruled;
        uint48 appealEnds;
        uint32 processed;          // reviews processed by finalize
        uint256 weight;            // REP behind the round's reviews
        uint256 harmSum;           // sum of REP x harm
        uint256 harmMass;          // REP behind harm scores
        uint256 settledHarm;       // H, 1e18 scale
        uint256 stakes;
        uint256 lossPool;          // ATN lost by inaccurate reviews
        uint256 keepSum;           // ATN kept by all reviews
        uint256 repPool;           // REP slashed this round
        uint256 repWin;            // sum of REP x accuracy
        uint256 bondPool;          // the author's slashed bond
        uint256 harmWin;           // sum of REP x harm accuracy
        Review[] reviews;
    }

    struct Axis {
        int128 sum;                // sum of REP x score
        uint128 mass;              // REP behind the scores
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_AXES = 16;
    int8 public constant NO_SCORE = -128;
    uint8 public constant NO_HARM = 255;
    uint64 private constant UNINFORMATIVE = type(uint64).max;
    bytes16 private constant NO_SCORES = bytes16(0x80808080808080808080808080808080); // NO_SCORE on every axis
    string public constant CHARTER_KEY = "jurisdiction.autonet.charter";

    IToolBondSubstrate public immutable substrate;
    IToolBondRep public immutable rep;
    IToolBondRegistry public immutable registry; // the treasury, and the charter
    address public immutable governor; // with the timelock, the proposal lifecycle that floors the appeal window
    address public immutable timelock;

    uint256 public minStake;         // ATN base units behind each tool
    uint256 public revealWindow;     // seconds to reveal after an epoch's anchor
    uint256 public degradeBps;       // REP a fully wrong review, or a withheld batch, loses
    uint256 public authorSlashBps;   // REP the author of a fully harmful tool loses (scaled by H)
    uint256 public unbondDelay;      // seconds a bond stays reviewable after its author asks to leave
    uint256 public reviewerShareBps; // share of a tool's mints its reviewers split (the daemon applies it)
    uint256 public appealPeriod;     // seconds to appeal a settled harm to the DAO, never below one proposal lifecycle
    uint256 public harmWeightBps;    // harm's weight in a review's accuracy; a charter axis weighs BPS

    mapping(bytes32 => Bond) public bonds;
    mapping(uint256 => Epoch) private _epochs;
    mapping(uint256 => mapping(address => Commit)) public commits;
    mapping(bytes32 => mapping(uint256 => Round)) private _rounds;
    mapping(bytes32 => mapping(uint256 => mapping(uint256 => Axis))) private _roundAxes;
    mapping(bytes32 => mapping(uint256 => mapping(address => uint256))) private _reviewIndex; // index + 1
    mapping(bytes32 => mapping(bytes32 => Axis)) private _toolAxes;
    mapping(bytes32 => Axis) private _toolHarm;

    event Bonded(bytes32 indexed digest, address indexed author, uint256 amount, uint256 stake);
    event UnbondRequested(bytes32 indexed digest, uint256 availableAt);
    event Unbonded(bytes32 indexed digest, address indexed author, uint256 amount);
    event EpochStarted(uint256 indexed epoch, bytes32 charterHash, uint256 axes, uint48 snapshot, uint256 supply);
    event Committed(uint256 indexed epoch, address indexed agent, uint256 stake, uint256 weight);
    event Reviewed(bytes32 indexed digest, uint256 indexed epoch, address indexed reviewer, bytes scores, uint8 harm,
        uint256 stake, uint256 weight, bytes32 evidenceHash);
    event Revealed(uint256 indexed epoch, address indexed agent, uint256 reviews, uint256 refunded);
    event Forfeited(uint256 indexed epoch, address indexed agent, uint256 stake, uint256 rep);
    event HarmSettled(bytes32 indexed digest, uint256 indexed epoch, uint256 harm, uint48 appealEnds);
    event Overruled(bytes32 indexed digest, uint256 indexed epoch, uint256 harm);
    event Finalized(bytes32 indexed digest, uint256 indexed epoch, uint256 harm, uint256 bondSlashed,
        uint256 lossPool, uint256 repPool);
    event Claimed(bytes32 indexed digest, uint256 indexed epoch, address indexed reviewer, uint256 refund,
        uint256 winnings, uint256 rep);
    event ParamsSet(uint256 minStake, uint256 revealWindow, uint256 degradeBps, uint256 authorSlashBps,
        uint256 unbondDelay, uint256 reviewerShareBps, uint256 harmWeightBps);
    event AppealPeriodSet(uint256 appealPeriod);

    error NotAuthor();
    error NotTimelock();
    error NotBonded();
    error RoundActive();
    error WrongStage();
    error TooEarly();
    error TooLate();
    error ZeroAmount();
    error NoWeight();
    error AlreadyCommitted();
    error BadReveal();
    error NothingToClaim();
    error BadParams();

    struct Params {
        uint256 minStake;
        uint256 revealWindow;
        uint256 degradeBps;
        uint256 authorSlashBps;
        uint256 unbondDelay;
        uint256 reviewerShareBps;
        uint256 appealPeriod;
        uint256 harmWeightBps;
    }

    constructor(address _substrate, address _rep, address _registry, address _governor, address _timelock, Params memory p) {
        substrate = IToolBondSubstrate(_substrate);
        rep = IToolBondRep(_rep);
        registry = IToolBondRegistry(_registry);
        governor = _governor;
        timelock = _timelock;
        _setParams(p);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// @notice Whether a tool has a live stake behind it. Unbonded tools leave the network's economy.
    function isBonded(bytes32 digest) public view returns (bool) {
        Bond storage b = bonds[digest];
        return b.unbondRequestedAt == 0 && b.stake >= minStake && b.stake > 0;
    }

    /// @notice The epoch taking commits now: the number of anchors so far.
    function currentEpoch() public view returns (uint256) {
        return substrate.anchorCount();
    }

    /// @notice An epoch's reveal deadline, or 0 while it is still open.
    function revealEnds(uint256 epoch) public view returns (uint256) {
        if (substrate.anchorCount() <= epoch) return 0;
        Epoch storage e = _epochs[epoch];
        return substrate.getAnchor(epoch).timestamp + (e.started ? e.revealWindow : revealWindow);
    }

    function epochInfo(uint256 epoch) external view returns (
        bool started, bytes32 charterHash, bytes32[] memory axisIds, uint48 snapshot, uint256 supply, uint256 revealDeadline
    ) {
        Epoch storage e = _epochs[epoch];
        return (e.started, e.charterHash, e.axisIds, e.snapshot, e.supply, revealEnds(epoch));
    }

    /// @notice The appeal window after harm settles: appealPeriod, never shorter than one proposal
    ///         lifecycle plus two days, so the DAO always has time to overrule by proposal.
    function appealWindow() public view returns (uint256) {
        return ProposalLifecycle.appealWindow(appealPeriod, governor, timelock);
    }

    function getRound(bytes32 digest, uint256 epoch) external view returns (
        Stage stage, bool overruled, uint48 appealEnds, uint256 weight, uint256 harmSum, uint256 harmMass,
        uint256 settledHarm, uint256 stakes, uint256 reviewCount
    ) {
        Round storage r = _rounds[digest][epoch];
        return (r.stage, r.overruled, r.appealEnds, r.weight, r.harmSum, r.harmMass, r.settledHarm, r.stakes,
            r.reviews.length);
    }

    /// @notice A round's sum of REP x score and REP mass on charter axis `i`: the mean is sum / mass.
    function roundAxis(bytes32 digest, uint256 epoch, uint256 i) external view returns (int256 sum, uint256 mass) {
        Axis storage a = _roundAxes[digest][epoch][i];
        return (a.sum, a.mass);
    }

    /// @notice A tool's rating on a charter axis over every finalized round: sum of REP x score and
    ///         the REP mass behind it. `axisId` is keccak256 of the axis id.
    function toolRating(bytes32 digest, bytes32 axisId) external view returns (int256 sum, uint256 mass) {
        Axis storage a = _toolAxes[digest][axisId];
        return (a.sum, a.mass);
    }

    /// @notice A tool's harm over every finalized round: sum of REP x harm (0..100) and the REP mass.
    function toolHarm(bytes32 digest) external view returns (uint256 sum, uint256 mass) {
        Axis storage a = _toolHarm[digest];
        return (uint256(int256(a.sum)), a.mass);
    }

    function reviewAt(bytes32 digest, uint256 epoch, uint256 i) external view returns (Review memory) {
        return _rounds[digest][epoch].reviews[i];
    }

    function reviewOf(bytes32 digest, uint256 epoch, address reviewer) external view returns (Review memory r) {
        uint256 idx = _reviewIndex[digest][epoch][reviewer];
        if (idx != 0) r = _rounds[digest][epoch].reviews[idx - 1];
    }

    /// @notice The commitment an agent submits for its epoch's batch: hides the reviews until reveal.
    function commitmentOf(uint256 epoch, address agent, ReviewInput[] calldata reviews, bytes32 salt)
        public pure returns (bytes32)
    {
        return keccak256(abi.encode(epoch, agent, reviews, salt));
    }

    // ── Author ───────────────────────────────────────────────────────────────

    /// @notice Stake (or top up) ATN behind a tool. Only its Substrate author can; approve this contract first.
    ///         Topping up cancels a pending unbond.
    function bond(bytes32 digest, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (substrate.toolAuthor(digest) != msg.sender) revert NotAuthor();
        Bond storage b = bonds[digest];
        b.author = msg.sender;
        b.stake += amount;
        b.unbondRequestedAt = 0;
        substrate.transferFrom(msg.sender, address(this), amount);
        emit Bonded(digest, msg.sender, amount, b.stake);
    }

    /// @notice Stop vouching for a tool. It stops counting as bonded at once, but stays reviewable: the
    ///         stake leaves only after unbondDelay, after the current epoch's reviews are revealed, and
    ///         once every round on the tool is finalized.
    function requestUnbond(bytes32 digest) external {
        Bond storage b = bonds[digest];
        if (msg.sender != b.author) revert NotAuthor();
        if (b.stake == 0) revert NotBonded();
        b.unbondRequestedAt = block.timestamp;
        b.unbondEpoch = currentEpoch();
        emit UnbondRequested(digest, block.timestamp + unbondDelay);
    }

    function withdraw(bytes32 digest) external {
        Bond storage b = bonds[digest];
        if (msg.sender != b.author) revert NotAuthor();
        if (b.unbondRequestedAt == 0) revert NotBonded();
        if (block.timestamp < b.unbondRequestedAt + unbondDelay) revert TooEarly();
        uint256 ends = revealEnds(b.unbondEpoch);
        if (ends == 0 || block.timestamp <= ends) revert TooEarly();
        if (b.pending != 0) revert RoundActive();
        uint256 amount = b.stake;
        b.stake = 0;
        b.unbondRequestedAt = 0;
        if (amount > 0) substrate.transfer(msg.sender, amount);
        emit Unbonded(digest, msg.sender, amount);
    }

    // ── Reviews ──────────────────────────────────────────────────────────────

    /// @notice Commit this epoch's hidden batch of reviews, staking `stake` ATN (approve this contract
    ///         first). Once per agent per epoch; needs REP at the epoch's start or a stake.
    function commit(bytes32 commitment, uint256 stake) external {
        uint256 epoch = currentEpoch();
        Epoch storage e = _epochs[epoch];
        if (!e.started) _startEpoch(epoch, e);
        Commit storage c = commits[epoch][msg.sender];
        if (c.commitment != 0) revert AlreadyCommitted();
        if (commitment == 0) revert BadReveal();
        uint256 weight = rep.getPastBalance(msg.sender, e.snapshot);
        if (weight == 0 && stake == 0) revert NoWeight();
        c.commitment = commitment;
        c.stake = uint128(stake);
        c.weight = uint128(weight);
        if (stake > 0) substrate.transferFrom(msg.sender, address(this), stake);
        emit Committed(epoch, msg.sender, stake, weight);
    }

    /// @notice Reveal an agent's batch once its epoch is anchored. Anyone holding the plaintext and salt
    ///         can relay it. The stakes must add up to the committed stake; a review that can't count
    ///         (an unbonded tool, the author's own, a repeat, malformed scores) has its stake refunded.
    function reveal(uint256 epoch, address agent, ReviewInput[] calldata reviews, bytes32 salt) external {
        uint256 ends = revealEnds(epoch);
        if (ends == 0) revert TooEarly();
        if (block.timestamp > ends) revert TooLate();
        Commit storage c = commits[epoch][agent];
        if (c.commitment == 0 || c.revealed) revert BadReveal();
        if (commitmentOf(epoch, agent, reviews, salt) != c.commitment) revert BadReveal();
        c.revealed = true;

        uint256 total;
        uint256 refund;
        uint256 counted;
        uint8 axes = _epochs[epoch].axes;
        for (uint256 i = 0; i < reviews.length; i++) {
            ReviewInput calldata ri = reviews[i];
            total += ri.stake;
            if (_record(epoch, agent, c.weight, axes, ri)) counted++;
            else refund += ri.stake;
        }
        if (total != c.stake) revert BadReveal();
        if (refund > 0) substrate.transfer(agent, refund);
        emit Revealed(epoch, agent, counted, refund);
    }

    /// @notice A batch not revealed in time loses its whole stake to the treasury and degradeBps of
    ///         the agent's REP at the epoch's start. Anyone can enforce it.
    function forfeit(uint256 epoch, address agent) external {
        uint256 ends = revealEnds(epoch);
        if (ends == 0 || block.timestamp <= ends) revert TooEarly();
        Commit storage c = commits[epoch][agent];
        if (c.commitment == 0 || c.revealed || c.forfeited) revert WrongStage();
        c.forfeited = true;
        uint256 burned = c.weight > 0 ? rep.slash(agent, uint256(c.weight) * degradeBps / BPS) : 0;
        if (c.stake > 0) substrate.transfer(address(registry), c.stake);
        emit Forfeited(epoch, agent, c.stake, burned);
    }

    /// @notice The DAO's ruling on a round's harm, by proposal, within the appeal window. Final:
    ///         finalization may follow at once.
    function daoOverrule(bytes32 digest, uint256 epoch, uint8 harm) external {
        if (msg.sender != timelock) revert NotTimelock();
        if (harm > 100) revert BadParams();
        Round storage r = _rounds[digest][epoch];
        if (r.stage != Stage.Cooling) revert WrongStage();
        if (block.timestamp > r.appealEnds) revert TooLate();
        r.settledHarm = uint256(harm) * 1e18 / 100;
        r.overruled = true;
        emit Overruled(digest, epoch, r.settledHarm);
    }

    /// @notice Settle a round once its epoch's reveals are in. A round with harm waits out the appeal
    ///         window first. Processes up to `maxReviews` reviews per call; call again until Done.
    function finalize(bytes32 digest, uint256 epoch, uint256 maxReviews) external {
        Round storage r = _rounds[digest][epoch];
        if (r.stage == Stage.Open) {
            if (block.timestamp <= revealEnds(epoch)) revert TooEarly();
            if (r.weight == 0) {
                // No REP behind the round: nothing settles, every stake is refunded on claim
                _done(digest, epoch, r, 0);
                return;
            }
            r.settledHarm = r.harmMass == 0 ? 0 : r.harmSum * 1e18 / (r.harmMass * 100);
            if (r.settledHarm > 0) {
                r.stage = Stage.Cooling;
                r.appealEnds = uint48(block.timestamp + appealWindow());
                emit HarmSettled(digest, epoch, r.settledHarm, r.appealEnds);
                return;
            }
            r.stage = Stage.Finalizing;
        } else if (r.stage == Stage.Cooling) {
            if (!r.overruled && block.timestamp <= r.appealEnds) revert TooEarly();
            r.stage = Stage.Finalizing;
        } else if (r.stage != Stage.Finalizing) {
            revert WrongStage();
        }

        uint256 end = r.processed + maxReviews;
        if (end > r.reviews.length) end = r.reviews.length;
        for (uint256 i = r.processed; i < end; i++) _settle(digest, epoch, r, r.reviews[i]);
        r.processed = uint32(end);
        if (end < r.reviews.length) return;

        // The round's scores join the tool's ratings
        Epoch storage e = _epochs[epoch];
        for (uint256 i = 0; i < e.axes; i++) {
            Axis storage a = _roundAxes[digest][epoch][i];
            Axis storage t = _toolAxes[digest][e.axisIds[i]];
            (t.sum, t.mass) = (t.sum + a.sum, t.mass + a.mass);
        }
        Axis storage h = _toolHarm[digest];
        (h.sum, h.mass) = (h.sum + int128(int256(r.harmSum)), h.mass + uint128(r.harmMass));

        // Harm slashes the author's bond and REP in proportion
        uint256 slashed;
        if (r.settledHarm > 0) {
            Bond storage b = bonds[digest];
            slashed = b.stake * r.settledHarm / 1e18;
            b.stake -= slashed;
            r.repPool += rep.slash(b.author, rep.balanceOf(b.author) * authorSlashBps / BPS * r.settledHarm / 1e18);
            if (r.harmWin == 0) {
                if (slashed > 0) substrate.transfer(address(registry), slashed);
            } else {
                r.bondPool = slashed;
            }
        }
        // Nobody kept anything (every review fully wrong): the losses go to the treasury
        if (r.keepSum == 0 && r.lossPool > 0) {
            substrate.transfer(address(registry), r.lossPool);
            r.lossPool = 0;
        }
        _done(digest, epoch, r, slashed);
    }

    /// @notice A review's settlement: its stake back less losses, its share of the losses and of any
    ///         slashed bond, and its share of the slashed REP. Anyone can claim it for the reviewer.
    function claim(bytes32 digest, uint256 epoch, address reviewer) external {
        Round storage r = _rounds[digest][epoch];
        if (r.stage != Stage.Done) revert WrongStage();
        uint256 idx = _reviewIndex[digest][epoch][reviewer];
        if (idx == 0) revert NothingToClaim();
        Review storage v = r.reviews[idx - 1];
        if (v.claimed) revert NothingToClaim();
        v.claimed = true;

        uint256 refund;
        uint256 winnings;
        uint256 repShare;
        if (r.weight == 0 || v.accuracy == UNINFORMATIVE) {
            refund = v.stake;
        } else {
            refund = _keep(v.stake, v.accuracy);
            if (r.keepSum > 0) winnings = r.lossPool * refund / r.keepSum;
            if (r.harmWin > 0 && v.harm != NO_HARM) {
                winnings += r.bondPool * (uint256(v.weight) * v.harmAccuracy / 1e18) / r.harmWin;
            }
            if (r.repWin > 0) repShare = r.repPool * (uint256(v.weight) * v.accuracy / 1e18) / r.repWin;
        }
        if (refund > 0) substrate.transfer(reviewer, refund);
        // Through the service rail, so the winnings count as the reviewer's earnings
        if (winnings > 0) substrate.payForService(reviewer, winnings, digest);
        if (repShare > 0) rep.reassign(reviewer, repShare);
        emit Claimed(digest, epoch, reviewer, refund, winnings, repShare);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    function _startEpoch(uint256 epoch, Epoch storage e) private {
        uint256 snapshot = epoch == 0 ? substrate.deployedAt() : substrate.getAnchor(epoch - 1).timestamp;
        if (snapshot >= block.timestamp) revert TooEarly();
        e.started = true;
        e.snapshot = uint48(snapshot);
        e.revealWindow = uint64(revealWindow);
        e.supply = rep.getPastTotalSupply(snapshot);
        if (address(registry) != address(0)) {
            bytes memory charter = bytes(registry.getRegistryValue(CHARTER_KEY));
            if (charter.length > 0) e.charterHash = sha256(charter);
            e.axisIds = _axisIds(charter);
            e.axes = uint8(e.axisIds.length);
        }
        emit EpochStarted(epoch, e.charterHash, e.axes, e.snapshot, e.supply);
    }

    /// @dev The charter's axis ids, in order, from its compact JSON: every "id": must be followed by a
    ///      quoted id of [a-z0-9_], distinct, at most MAX_AXES. Anything else yields no axes, so the
    ///      epoch rates harm only (daemons refuse such a charter anyway).
    function _axisIds(bytes memory c) private pure returns (bytes32[] memory ids) {
        bytes32[] memory found = new bytes32[](MAX_AXES);
        uint256 n;
        for (uint256 i = 0; i + 5 <= c.length; i++) {
            if (c[i] != '"' || c[i + 1] != "i" || c[i + 2] != "d" || c[i + 3] != '"' || c[i + 4] != ":") continue;
            uint256 start = i + 6;
            if (start > c.length || c[i + 5] != '"' || n == MAX_AXES) return new bytes32[](0);
            uint256 j = start;
            while (j < c.length && c[j] != '"') {
                bytes1 ch = c[j];
                if (!((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch == "_")) return new bytes32[](0);
                j++;
            }
            if (j == c.length || j == start) return new bytes32[](0);
            bytes memory id = new bytes(j - start);
            for (uint256 k = 0; k < id.length; k++) id[k] = c[start + k];
            bytes32 h = keccak256(id);
            for (uint256 k = 0; k < n; k++) if (found[k] == h) return new bytes32[](0);
            found[n++] = h;
            i = j;
        }
        ids = new bytes32[](n);
        for (uint256 k = 0; k < n; k++) ids[k] = found[k];
    }

    /// @dev Adds one revealed review to its tool's round. False when it can't count.
    function _record(uint256 epoch, address agent, uint256 weight, uint8 axes, ReviewInput calldata ri)
        private returns (bool)
    {
        Bond storage b = bonds[ri.digest];
        if (b.stake == 0 || b.author == agent) return false;
        if (_reviewIndex[ri.digest][epoch][agent] != 0) return false;
        if (ri.scores.length != 0 && ri.scores.length != axes) return false;
        if (ri.harm > 100 && ri.harm != NO_HARM) return false;
        for (uint256 i = 0; i < ri.scores.length; i++) {
            int8 s = int8(uint8(ri.scores[i]));
            if (s != NO_SCORE && (s < -100 || s > 100)) return false;
        }

        Round storage r = _rounds[ri.digest][epoch];
        if (r.stage == Stage.None) {
            r.stage = Stage.Open;
            b.pending++;
        }
        for (uint256 i = 0; i < ri.scores.length; i++) {
            int8 s = int8(uint8(ri.scores[i]));
            if (s == NO_SCORE || weight == 0) continue;
            Axis storage a = _roundAxes[ri.digest][epoch][i];
            (a.sum, a.mass) = (a.sum + int128(int256(weight) * s), a.mass + uint128(weight));
        }
        if (ri.harm != NO_HARM && weight > 0) {
            r.harmSum += weight * ri.harm;
            r.harmMass += weight;
        }
        r.weight += weight;
        r.stakes += ri.stake;
        r.reviews.push(Review({
            reviewer: agent, harm: ri.harm, claimed: false, accuracy: 0,
            scores: ri.scores.length == 0 ? NO_SCORES : bytes16(ri.scores),
            stake: uint128(ri.stake), weight: uint128(weight), harmAccuracy: 0
        }));
        _reviewIndex[ri.digest][epoch][agent] = r.reviews.length;
        emit Reviewed(ri.digest, epoch, agent, ri.scores, ri.harm, ri.stake, weight, ri.evidenceHash);
        return true;
    }

    /// @dev One review's accuracy against the round's means, and its losses into the round's pools.
    function _settle(bytes32 digest, uint256 epoch, Round storage r, Review storage v) private {
        uint256 num;
        uint256 den;
        uint8 axes = _epochs[epoch].axes;
        for (uint256 i = 0; i < axes; i++) {
            int8 s = int8(uint8(v.scores[i]));
            Axis storage a = _roundAxes[digest][epoch][i];
            if (s == NO_SCORE || a.mass == 0) continue;
            // 1 - |score - mean| / 200, as |score x mass - sum| / (200 x mass)
            int256 d = int256(s) * int256(uint256(a.mass)) - a.sum;
            uint256 dist = uint256(d < 0 ? -d : d) * 1e18 / (200 * uint256(a.mass));
            num += (1e18 - dist) * BPS;
            den += BPS;
        }
        if (v.harm != NO_HARM && r.harmMass > 0) {
            uint256 h = uint256(v.harm) * 1e18 / 100;
            uint256 hd = h > r.settledHarm ? h - r.settledHarm : r.settledHarm - h;
            v.harmAccuracy = uint64(1e18 - hd);
            num += uint256(v.harmAccuracy) * harmWeightBps;
            den += harmWeightBps;
            r.harmWin += uint256(v.weight) * v.harmAccuracy / 1e18;
        }
        if (den == 0) {
            v.accuracy = UNINFORMATIVE; // nothing to measure it against: refunded, no gain or loss
            return;
        }
        v.accuracy = uint64(num / den);
        uint256 keep = _keep(v.stake, v.accuracy);
        r.lossPool += v.stake - keep;
        r.keepSum += keep;
        if (v.weight > 0) {
            r.repPool += rep.slash(v.reviewer, uint256(v.weight) * degradeBps / BPS * (1e18 - v.accuracy) / 1e18);
            r.repWin += uint256(v.weight) * v.accuracy / 1e18;
        }
    }

    function _keep(uint256 stake, uint64 accuracy) private pure returns (uint256) {
        return stake - stake * (1e18 - accuracy) / 1e18;
    }

    function _done(bytes32 digest, uint256 epoch, Round storage r, uint256 slashed) private {
        r.stage = Stage.Done;
        bonds[digest].pending--;
        emit Finalized(digest, epoch, r.settledHarm, slashed, r.lossPool, r.repPool);
    }

    // ── Governance ───────────────────────────────────────────────────────────

    function setParams(Params calldata p) external {
        if (msg.sender != timelock) revert NotTimelock();
        _setParams(p);
    }

    function _setParams(Params memory p) private {
        if (p.degradeBps > BPS || p.authorSlashBps > BPS || p.reviewerShareBps > BPS || p.revealWindow == 0
            || p.revealWindow > type(uint64).max || p.harmWeightBps > 100 * BPS) revert BadParams();
        minStake = p.minStake;
        revealWindow = p.revealWindow;
        degradeBps = p.degradeBps;
        authorSlashBps = p.authorSlashBps;
        unbondDelay = p.unbondDelay;
        reviewerShareBps = p.reviewerShareBps;
        appealPeriod = p.appealPeriod;
        harmWeightBps = p.harmWeightBps;
        emit AppealPeriodSet(p.appealPeriod);
        emit ParamsSet(p.minStake, p.revealWindow, p.degradeBps, p.authorSlashBps, p.unbondDelay,
            p.reviewerShareBps, p.harmWeightBps);
    }
}
