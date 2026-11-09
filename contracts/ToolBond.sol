// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {DaoProposalHold} from "./DaoProposalHold.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

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
    function getAgentOwner(address agent) external view returns (address);
}

/// @notice The parts of the jurisdiction RepToken the settlements need: snapshots and slashing.
interface IToolBondRep {
    function balanceOf(address account) external view returns (uint256);
    function getPastBalance(address account, uint256 timepoint) external view returns (uint256);
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256);
    function slash(address from, uint256 amount) external returns (uint256);
    function reassign(address to, uint256 amount) external;
}

/// @notice The jurisdiction Registry: the charter, review settings and sanctions.
interface IToolBondRegistry {
    function getRegistryValue(string memory key) external view returns (string memory);
}

/// @title ToolBond
/// @notice ATN bonds behind autonet tools, and REP-weighted reviews that rate them.
///
///         Every published tool carries its author's ATN bond. A review rates a tool on four fixed
///         fields, the same in every jurisdiction and all required: correctness (-100..100),
///         simplicity (0..100), novelty (0..100) and malware (yes or no, NIST SP 800-53 "malicious
///         code"). It also scores each axis of the jurisdiction's charter (-100..100), each optional:
///         an unscored axis counts at `jurisdiction.autonet.unscored_axis_bps` of the top score, with
///         the review's weight. This contract keeps, per round and per tool, the REP-weighted sum and
///         the REP mass of every field and axis; the daemons' close turns them into pay.
///
///         Reviews follow the Substrate's epochs: epoch e runs from anchor e-1 (or the Substrate's
///         deployment) to anchor e. During the epoch each agent whose household holds REP commits once
///         to a hidden batch of reviews; after anchor e the batch is revealed, by the agent or by anyone
///         holding its plaintext, within `revealWindow`. REP sits with households (an agent's owner
///         wallet, autonet decision 2026-10-27), so a review weighs its household's REP at the epoch's
///         start, once per tool and epoch: the household's agent that committed first carries it and
///         later ones review at zero weight. Commits are hidden, so their order says nothing about the
///         reviews, and the order of reveals can't pick which review counts. Each tool's reviews in an
///         epoch form a round, which settles against its own REP-weighted means:
///
///         - Accuracy: the mean over every field and charter axis of how close a review lands to the
///           round's other reviews (its own weight left out, so a lone reviewer can't be right by
///           construction). Each review loses REP x `degradeBps` x (1 - accuracy), reassigned to the
///           reviews by REP x accuracy. No REP is created.
///         - Bounty: ATN anyone adds for a tool's reviewers, apart from the bond. Each round pays out of
///           it as it finalizes: a review takes bounty x its REP weight / the REP a tool needs to
///           conclude (`jurisdiction.autonet.mint_gate_rep_bps` of the epoch's supply) x its accuracy,
///           scaled down together if they'd overspend it, to its household, unless sanctioned. What's
///           left goes back to the author with the bond.
///
///         Malware is judged once per tool, when it concludes: when an anchored close names it, its
///         reviewers having reached the conclusion threshold. If more than half the REP of its rounds
///         finalized by then said yes, an appeal window opens, in which the tool's author can take it to
///         the DAO. Then the author's bond loses that share and the bonding household's REP burns
///         that share of `authorSlashBps`, never more than the REP that said yes, unless the DAO ruled
///         it isn't malware. The slashed bond goes to the reviewers who said yes, by REP.
///
///         A commit declares how many reviews it holds, and a batch never revealed loses that many
///         times `degradeBps` of its REP, the most its revealed reviews could have cost, so revealing
///         always beats withholding.
contract ToolBond {
    enum Stage { None, Open, Finalizing, Done }

    struct Bond {
        address author;
        uint256 stake;
        uint256 unbondRequestedAt; // 0 when bonded
        uint32 pending;            // rounds on this tool not yet finalized
        uint256 bounty;            // ATN for the tool's reviewers, paid out as rounds finalize
    }

    struct Epoch {
        bool started;
        uint8 axes;
        uint16 unscoredBps;        // what an unscored charter axis counts as, bps of the top score
        uint48 snapshot;           // REP timepoint: the epoch's start
        uint64 revealWindow;       // fixed when the epoch starts
        bytes32 charterHash;       // sha256 of the charter's registry value
        uint256 supply;            // REP supply at the snapshot
        bytes32[] axisIds;         // keccak256 of each charter axis id, in charter order
    }

    struct Commit {
        bytes32 commitment;
        uint128 weight;            // REP at the epoch's snapshot
        bool revealed;
        bool forfeited;
    }

    /// @notice A review as committed and revealed. The four fixed fields are required: a value out of
    ///         range makes the review invalid. `scores` holds one int8 per charter axis (-100..100, or
    ///         -128 for unscored), or nothing (every axis unscored).
    struct ReviewInput {
        bytes32 digest;
        int8 correctness;          // -100..100
        uint8 simplicity;          // 0..100
        uint8 novelty;             // 0..100
        uint8 malware;             // 1 yes, 0 no
        bytes scores;
        bytes32 evidenceHash;
    }

    struct Review {
        address reviewer;
        int8 correctness;
        uint8 simplicity;
        uint8 novelty;
        uint8 malware;
        bool claimed;
        bool bountied;             // takes a part of the round's bounty
        bool bondClaimed;          // took its share of a slashed bond
        uint64 accuracy;           // 1e18 scale; UNINFORMATIVE with no other review to measure it against
        uint128 weight;
        bytes16 scores;            // charter axes as revealed, NO_SCORE where unscored
    }

    struct Round {
        Stage stage;
        bool beforeConclusion;     // finalized before the tool concluded: its yes votes share a slashed bond
        uint32 processed;          // reviews processed by finalize
        uint256 weight;            // REP behind the round's reviews
        uint256 repPool;           // REP slashed from reviewers this round
        uint256 repWin;            // sum of REP x accuracy
        uint256 bountyBase;        // the tool's bounty when the round started finalizing
        uint256 bountyNeed;        // REP a tool needs to conclude, at the epoch's supply
        uint256 bountyWin;         // sum of REP x accuracy of the reviews taking a part
        uint256 bountyPool;        // the bounty the round pays out
        Review[] reviews;
    }

    /// @notice A tool's malware verdict, formed once when it concludes
    struct Verdict {
        uint48 concludedAt;
        uint48 appealEnds;         // 0 unless more than half said malware
        uint48 heldUntil;          // the latest moment a registered DAO appeal could land
        uint8 ruling;              // the DAO's: 0 none, 1 malware, 2 not malware
        bool settled;
        uint64 share;              // REP-weighted share of yes at conclusion, 1e18 scale
        uint256 yesMass;           // REP that said yes, in rounds finalized before conclusion
        uint256 bondPool;          // the slashed bond, for those reviewers
    }

    struct Axis {
        int128 sum;                // sum of REP x score
        uint128 mass;              // REP behind the scores
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_AXES = 16;
    /// @notice Round field indexes: the fixed fields, then charter axis k at FIELDS + k. Per tool the
    ///         fixed fields are keyed bytes32(index), the axes by keccak256 of their id.
    uint256 public constant CORRECTNESS = 0;
    uint256 public constant SIMPLICITY = 1;
    uint256 public constant NOVELTY = 2;
    uint256 public constant MALWARE = 3;
    uint256 public constant FIELDS = 4;
    int8 public constant NO_SCORE = -128;
    uint64 private constant UNINFORMATIVE = type(uint64).max;
    bytes16 private constant NO_SCORES = bytes16(0x80808080808080808080808080808080); // NO_SCORE on every axis
    string public constant CHARTER_KEY = "jurisdiction.autonet.charter";
    string public constant MINT_GATE_KEY = "jurisdiction.autonet.mint_gate_rep_bps";
    uint256 public constant DEFAULT_MINT_GATE_BPS = 100;
    string public constant UNSCORED_KEY = "jurisdiction.autonet.unscored_axis_bps";
    uint256 public constant DEFAULT_UNSCORED_BPS = 5000;
    /// @notice Tags a concluded tool's leaf in an anchor's agentMintRoot: keccak256(bytes.concat(
    ///         keccak256(abi.encode(CONCLUDED_TAG, digest, shareBps)))), shareBps the close's share of
    ///         the reviewing REP that said malware. Three words, so it never reads as a mint leaf.
    bytes32 public constant CONCLUDED_TAG = keccak256("autonet.tool_concluded");

    IToolBondSubstrate public immutable substrate;
    IToolBondRep public immutable rep;
    IToolBondRegistry public immutable registry; // the treasury, the charter and review settings
    address public immutable governor; // with the timelock, how long a registered appeal holds a verdict
    address public immutable timelock;

    uint256 public minStake;         // ATN base units behind each tool
    uint256 public revealWindow;     // seconds to reveal after an epoch's anchor
    uint256 public degradeBps;       // REP a fully wrong review, or a withheld one, loses
    uint256 public authorSlashBps;   // REP the author of malware loses (scaled by the share of yes)
    uint256 public unbondDelay;      // seconds a bond stays reviewable after its author asks to leave
    uint256 public reviewerShareBps; // share of a tool's mints its reviewers split (the daemon applies it)
    uint256 public appealPeriod;     // seconds the author has to register a DAO appeal of a malware verdict

    mapping(bytes32 => Bond) public bonds;
    mapping(bytes32 => Verdict) public verdicts;
    mapping(uint256 => Epoch) private _epochs;
    mapping(uint256 => mapping(address => Commit)) public commits;
    mapping(bytes32 => mapping(uint256 => Round)) private _rounds;
    mapping(bytes32 => mapping(uint256 => mapping(uint256 => Axis))) private _roundAxes;
    mapping(bytes32 => mapping(uint256 => mapping(address => uint256))) private _reviewIndex; // index + 1
    mapping(bytes32 => mapping(bytes32 => Axis)) private _toolAxes;
    struct Committer {
        address household;         // the owner wallet whose REP the batch weighs, read at commit
        uint32 seq;                // commit order in the epoch, from 1
    }
    mapping(uint256 => mapping(address => Committer)) private _committers;
    mapping(uint256 => uint32) private _commitCount;
    mapping(bytes32 => mapping(uint256 => mapping(address => uint256))) private _householdReview; // index + 1
    mapping(uint256 => mapping(address => uint256)) public reviewCountOf; // reviews a commit declared
    /// @notice The household that bonded a tool, liable for malware: its author's owner at the first bond
    mapping(bytes32 => address) public bondHousehold;

    event Bonded(bytes32 indexed digest, address indexed author, uint256 amount, uint256 stake);
    event UnbondRequested(bytes32 indexed digest, uint256 availableAt);
    event Unbonded(bytes32 indexed digest, address indexed author, uint256 amount, uint256 bounty);
    event BountyAdded(bytes32 indexed digest, address indexed from, uint256 amount, uint256 bounty);
    event BountyPaid(bytes32 indexed digest, uint256 indexed epoch, address indexed household, uint256 amount);
    event EpochStarted(uint256 indexed epoch, bytes32 charterHash, bytes32[] axisIds, uint48 snapshot, uint256 supply,
        uint256 unscoredBps);
    event Committed(uint256 indexed epoch, address indexed agent, uint256 weight);
    event Reviewed(bytes32 indexed digest, uint256 indexed epoch, address indexed reviewer, int8 correctness,
        uint8 simplicity, uint8 novelty, uint8 malware, bytes scores, uint256 weight, bytes32 evidenceHash);
    event ReviewSettled(bytes32 indexed digest, uint256 indexed epoch, address indexed reviewer, uint256 accuracy);
    event Revealed(uint256 indexed epoch, address indexed agent, uint256 reviews);
    /// @notice A review lost its household's weight to one from the household's earlier commit.
    event ReviewUnweighted(bytes32 indexed digest, uint256 indexed epoch, address indexed reviewer);
    event Forfeited(uint256 indexed epoch, address indexed agent, uint256 rep);
    event Finalized(bytes32 indexed digest, uint256 indexed epoch, uint256 repPool);
    event Claimed(bytes32 indexed digest, uint256 indexed epoch, address indexed reviewer, uint256 rep);
    event Concluded(bytes32 indexed digest, uint256 anchorIndex, uint256 malwareShare, uint48 appealEnds);
    event DaoProposalRegistered(bytes32 indexed digest, uint256 indexed proposalId, uint48 heldUntil);
    event MalwareRuled(bytes32 indexed digest, bool malware);
    event MalwareSettled(bytes32 indexed digest, bool malware, uint256 bondSlashed, uint256 repBurned);
    event AuthorRepBurned(bytes32 indexed digest, address indexed household, uint256 amount);
    event BondShareClaimed(bytes32 indexed digest, uint256 indexed epoch, address indexed reviewer, uint256 amount);
    event ParamsSet(uint256 minStake, uint256 revealWindow, uint256 degradeBps, uint256 authorSlashBps,
        uint256 unbondDelay, uint256 reviewerShareBps);
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
    error BadProof();
    error NothingToClaim();
    error BadParams();
    error NotAboutTool();
    error MalwareSuspected();

    struct Params {
        uint256 minStake;
        uint256 revealWindow;
        uint256 degradeBps;
        uint256 authorSlashBps;
        uint256 unbondDelay;
        uint256 reviewerShareBps;
        uint256 appealPeriod;
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
        bool started, bytes32 charterHash, bytes32[] memory axisIds, uint48 snapshot, uint256 supply,
        uint256 revealDeadline, uint256 unscoredBps
    ) {
        Epoch storage e = _epochs[epoch];
        return (e.started, e.charterHash, e.axisIds, e.snapshot, e.supply, revealEnds(epoch), e.unscoredBps);
    }

    function getRound(bytes32 digest, uint256 epoch) external view returns (
        Stage stage, uint256 weight, uint256 reviewCount, bool beforeConclusion
    ) {
        Round storage r = _rounds[digest][epoch];
        return (r.stage, r.weight, r.reviews.length, r.beforeConclusion);
    }

    /// @notice A round's bounty: the tool's bounty when it started finalizing, the REP a tool needs to
    ///         conclude, the REP x accuracy taking a part, and what the round pays out once Done
    function roundBounty(bytes32 digest, uint256 epoch) external view returns (
        uint256 base, uint256 need, uint256 win, uint256 pool
    ) {
        Round storage r = _rounds[digest][epoch];
        return (r.bountyBase, r.bountyNeed, r.bountyWin, r.bountyPool);
    }

    /// @notice Whether a Registry sanction is in force on [account]: `sanction.<address>` (lowercase) is
    ///         set, and isn't JSON with an integer `until` already past
    function sanctioned(address account) public view returns (bool) {
        bytes memory v = bytes(registry.getRegistryValue(string.concat("sanction.", Strings.toHexString(account))));
        if (v.length == 0) return false;
        for (uint256 i = 0; i + 7 <= v.length; i++) {
            bytes7 w;
            assembly ("memory-safe") { w := mload(add(add(v, 32), i)) }
            if (w != '"until"') continue;
            uint256 j = i + 7;
            while (j < v.length && v[j] == " ") j++;
            if (j == v.length || v[j] != ":") return true;
            j++;
            while (j < v.length && v[j] == " ") j++;
            (uint256 until, bool ok) = _uint(v, j);
            return !ok || block.timestamp <= until;
        }
        return true;
    }

    /// @notice A round's sum of REP x score and REP mass on field `i` (CORRECTNESS..MALWARE, then charter
    ///         axis k at FIELDS + k): the mean is sum / mass. A malware yes counts as 100.
    function roundAxis(bytes32 digest, uint256 epoch, uint256 i) external view returns (int256 sum, uint256 mass) {
        Axis storage a = _roundAxes[digest][epoch][i];
        return (a.sum, a.mass);
    }

    /// @notice A tool's rating over every finalized round: sum of REP x score and the REP mass behind it.
    ///         `key` is bytes32(field index) for a fixed field, keccak256 of the id for a charter axis.
    function toolRating(bytes32 digest, bytes32 key) external view returns (int256 sum, uint256 mass) {
        Axis storage a = _toolAxes[digest][key];
        return (a.sum, a.mass);
    }

    function reviewAt(bytes32 digest, uint256 epoch, uint256 i) external view returns (Review memory) {
        return _rounds[digest][epoch].reviews[i];
    }

    function reviewOf(bytes32 digest, uint256 epoch, address reviewer) external view returns (Review memory r) {
        uint256 idx = _reviewIndex[digest][epoch][reviewer];
        if (idx != 0) r = _rounds[digest][epoch].reviews[idx - 1];
    }

    /// @notice The household an agent's batch in `epoch` weighs (its owner wallet when it committed).
    function householdOf(uint256 epoch, address agent) public view returns (address) {
        return _committers[epoch][agent].household;
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
        // Fixed at the first bond: a later owner rotation and top-up can't move the liability
        if (bondHousehold[digest] == address(0)) bondHousehold[digest] = _household(msg.sender);
        b.stake += amount;
        b.unbondRequestedAt = 0;
        substrate.transferFrom(msg.sender, address(this), amount);
        emit Bonded(digest, msg.sender, amount, b.stake);
    }

    /// @notice Stop vouching for a tool. It stops counting as bonded at once, but stays reviewable: the
    ///         stake and the unclaimed bounty leave only after unbondDelay, once every round on the tool
    ///         is finalized and no malware verdict is open.
    function requestUnbond(bytes32 digest) external {
        Bond storage b = bonds[digest];
        if (msg.sender != b.author) revert NotAuthor();
        if (b.stake == 0 && b.bounty == 0) revert NotBonded();
        b.unbondRequestedAt = block.timestamp;
        emit UnbondRequested(digest, block.timestamp + unbondDelay);
    }

    function withdraw(bytes32 digest) external {
        Bond storage b = bonds[digest];
        if (msg.sender != b.author) revert NotAuthor();
        if (b.unbondRequestedAt == 0) revert NotBonded();
        if (block.timestamp < b.unbondRequestedAt + unbondDelay) revert TooEarly();
        Verdict storage v = verdicts[digest];
        if (b.pending != 0 || (v.appealEnds != 0 && !v.settled)) revert RoundActive();
        // Caught before the verdict: more than half the REP of its finalized rounds says malware
        Axis storage m = _toolAxes[digest][bytes32(MALWARE)];
        if (v.concludedAt == 0 && uint256(int256(m.sum)) / 100 * 2 > m.mass) revert MalwareSuspected();
        uint256 amount = b.stake;
        uint256 bounty = b.bounty;
        b.stake = 0;
        b.bounty = 0;
        b.unbondRequestedAt = 0;
        if (amount + bounty > 0) substrate.transfer(msg.sender, amount + bounty);
        emit Unbonded(digest, msg.sender, amount, bounty);
    }

    // ── Bounty ───────────────────────────────────────────────────────────────

    /// @notice Add ATN to a bonded tool's bounty (approve this contract first). Anyone can. Rounds pay
    ///         out of it as they finalize; what's left goes back to the author with the bond.
    function addBounty(bytes32 digest, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        Bond storage b = bonds[digest];
        if (b.author == address(0)) revert NotBonded();
        b.bounty += amount;
        substrate.transferFrom(msg.sender, address(this), amount);
        emit BountyAdded(digest, msg.sender, amount, b.bounty);
    }

    // ── Reviews ──────────────────────────────────────────────────────────────

    /// @notice Commit this epoch's hidden batch of `reviews` reviews. Once per agent per epoch, and only
    ///         if its household held REP at the epoch's start. The count is public and the reveal must
    ///         match it: it sets the forfeit.
    function commit(bytes32 commitment, uint256 reviews) external {
        uint256 epoch = currentEpoch();
        Epoch storage e = _epochs[epoch];
        if (!e.started) _startEpoch(epoch, e);
        Commit storage c = commits[epoch][msg.sender];
        if (c.commitment != 0) revert AlreadyCommitted();
        if (commitment == 0) revert BadReveal();
        address household = _household(msg.sender);
        uint256 weight = rep.getPastBalance(household, e.snapshot);
        if (weight == 0) revert NoWeight();
        _committers[epoch][msg.sender] = Committer(household, ++_commitCount[epoch]);
        reviewCountOf[epoch][msg.sender] = reviews;
        c.commitment = commitment;
        c.weight = uint128(weight);
        emit Committed(epoch, msg.sender, weight);
    }

    /// @notice Reveal an agent's batch once its epoch is anchored. Anyone holding the plaintext and salt
    ///         can relay it. A review that can't count (an unbonded tool, its own household's, a repeat,
    ///         a fixed field missing or out of range, malformed scores) is skipped.
    function reveal(uint256 epoch, address agent, ReviewInput[] calldata reviews, bytes32 salt) external {
        uint256 ends = revealEnds(epoch);
        if (ends == 0) revert TooEarly();
        if (block.timestamp > ends) revert TooLate();
        Commit storage c = commits[epoch][agent];
        if (c.commitment == 0 || c.revealed) revert BadReveal();
        if (commitmentOf(epoch, agent, reviews, salt) != c.commitment) revert BadReveal();
        if (reviews.length != reviewCountOf[epoch][agent]) revert BadReveal();
        c.revealed = true;

        uint256 counted;
        uint8 axes = _epochs[epoch].axes;
        for (uint256 i = 0; i < reviews.length; i++) {
            if (_record(epoch, agent, c.weight, axes, reviews[i])) counted++;
        }
        emit Revealed(epoch, agent, counted);
    }

    /// @notice A batch not revealed in time loses, per declared review, degradeBps of the REP it weighed
    ///         (its household's). Anyone can enforce it.
    function forfeit(uint256 epoch, address agent) external {
        uint256 ends = revealEnds(epoch);
        if (ends == 0 || block.timestamp <= ends) revert TooEarly();
        Commit storage c = commits[epoch][agent];
        if (c.commitment == 0 || c.revealed || c.forfeited) revert WrongStage();
        c.forfeited = true;
        uint256 burned = rep.slash(householdOf(epoch, agent), reviewCountOf[epoch][agent] * c.weight * degradeBps / BPS);
        emit Forfeited(epoch, agent, burned);
    }

    /// @notice Settle a round once its epoch's reveals are in. Processes up to `maxReviews` reviews per
    ///         call; call again until Done.
    function finalize(bytes32 digest, uint256 epoch, uint256 maxReviews) external {
        Round storage r = _rounds[digest][epoch];
        if (r.stage == Stage.Open) {
            if (block.timestamp <= revealEnds(epoch)) revert TooEarly();
            // The round's bounty is the tool's balance now, so the order of reviews inside it doesn't matter
            r.stage = Stage.Finalizing;
            r.bountyBase = bonds[digest].bounty;
            if (r.bountyBase > 0) r.bountyNeed = _registryBps(MINT_GATE_KEY, DEFAULT_MINT_GATE_BPS) * _epochs[epoch].supply / BPS;
        } else if (r.stage != Stage.Finalizing) {
            revert WrongStage();
        }

        uint256 end = r.processed + maxReviews;
        if (end > r.reviews.length) end = r.reviews.length;
        for (uint256 i = r.processed; i < end; i++) _settle(digest, epoch, r, r.reviews[i]);
        r.processed = uint32(end);
        if (end < r.reviews.length) return;

        // The round's sums join the tool's ratings
        Epoch storage e = _epochs[epoch];
        for (uint256 i = 0; i < FIELDS + e.axes; i++) {
            Axis storage a = _roundAxes[digest][epoch][i];
            Axis storage t = _toolAxes[digest][i < FIELDS ? bytes32(i) : e.axisIds[i - FIELDS]];
            (t.sum, t.mass) = (t.sum + a.sum, t.mass + a.mass);
        }
        // The bounty's parts, scaled down together so they never spend more than there is
        if (r.bountyWin > 0) {
            uint256 pool = r.bountyNeed == 0 ? r.bountyBase : r.bountyBase * r.bountyWin / r.bountyNeed;
            if (pool > r.bountyBase) pool = r.bountyBase;
            Bond storage b = bonds[digest];
            if (pool > b.bounty) pool = b.bounty;
            b.bounty -= pool;
            r.bountyPool = pool;
        }
        r.stage = Stage.Done;
        r.beforeConclusion = verdicts[digest].concludedAt == 0;
        bonds[digest].pending--;
        emit Finalized(digest, epoch, r.repPool);
    }

    /// @notice A review's settlement: its share of the slashed REP, and its part of the bounty (to its
    ///         household). Anyone can claim it for the reviewer.
    function claim(bytes32 digest, uint256 epoch, address reviewer) external {
        Round storage r = _rounds[digest][epoch];
        if (r.stage != Stage.Done) revert WrongStage();
        uint256 idx = _reviewIndex[digest][epoch][reviewer];
        if (idx == 0) revert NothingToClaim();
        Review storage v = r.reviews[idx - 1];
        if (v.claimed) revert NothingToClaim();
        v.claimed = true;

        uint256 repShare;
        if (v.accuracy != UNINFORMATIVE) {
            uint256 won = uint256(v.weight) * v.accuracy / 1e18;
            if (r.repWin > 0) repShare = r.repPool * won / r.repWin;
            if (v.bountied && r.bountyPool > 0) {
                uint256 part = r.bountyPool * won / r.bountyWin;
                if (part > 0) {
                    address household = householdOf(epoch, reviewer);
                    substrate.transfer(household, part);
                    emit BountyPaid(digest, epoch, household, part);
                }
            }
        }
        if (repShare > 0) rep.reassign(householdOf(epoch, reviewer), repShare);
        emit Claimed(digest, epoch, reviewer, repShare);
    }

    // ── Malware verdict ──────────────────────────────────────────────────────

    /// @notice Record that a tool concluded, from its leaf in an anchored close's agentMintRoot, with
    ///         the close's share of the reviewing REP that said malware. Anyone can, once per tool. More
    ///         than half opens the appeal window.
    function conclude(bytes32 digest, uint256 anchorIndex, uint256 shareBps, bytes32[] calldata proof) external {
        if (bonds[digest].author == address(0)) revert NotBonded();
        Verdict storage v = verdicts[digest];
        if (v.concludedAt != 0) revert WrongStage();
        if (shareBps > BPS) revert BadProof();
        // Sorted-pair hashing over a double-hashed leaf, like the Substrate's mint claims
        bytes32 node = keccak256(bytes.concat(keccak256(abi.encode(CONCLUDED_TAG, digest, shareBps))));
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            node = node < p ? keccak256(abi.encode(node, p)) : keccak256(abi.encode(p, node));
        }
        if (node != substrate.getAnchor(anchorIndex).agentMintRoot) revert BadProof();

        v.concludedAt = uint48(block.timestamp);
        v.share = uint64(shareBps * 1e18 / BPS);
        // The REP that said yes in the rounds finalized so far: who shares a slashed bond
        v.yesMass = uint256(int256(_toolAxes[digest][bytes32(MALWARE)].sum)) / 100;
        if (shareBps * 2 > BPS) v.appealEnds = uint48(block.timestamp + appealPeriod);
        else v.settled = true;
        emit Concluded(digest, anchorIndex, v.share, v.appealEnds);
    }

    /// @notice The tool's author appeals a malware verdict: registers a live DAO proposal calling
    ///         daoOverrule on it, before the appeal window ends. The verdict then can't settle until the
    ///         latest registered proposal could no longer land. One timestamp per tool, so filing many
    ///         costs nothing extra and none holds past its own lifecycle.
    function registerDaoProposal(
        bytes32 digest,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas,
        bytes32 descriptionHash
    ) external {
        Verdict storage v = verdicts[digest];
        if (v.appealEnds == 0 || v.settled || v.ruling != 0) revert WrongStage();
        if (block.timestamp > v.appealEnds) revert TooLate();
        if (msg.sender != bonds[digest].author && msg.sender != bondHousehold[digest]) revert NotAuthor();
        bool about;
        for (uint256 i = 0; i < targets.length; i++) {
            if (targets[i] != address(this) || calldatas[i].length < 68) continue;
            if (bytes4(calldatas[i][:4]) != this.daoOverrule.selector) continue;
            if (bytes32(calldatas[i][4:36]) == digest) about = true;
        }
        if (!about) revert NotAboutTool();
        uint256 id = DaoProposalHold.proposalId(governor, targets, values, calldatas, descriptionHash);
        uint256 until = DaoProposalHold.holdUntil(governor, timelock, id);
        if (until > v.heldUntil) v.heldUntil = uint48(until);
        emit DaoProposalRegistered(digest, id, uint48(until));
    }

    /// @notice The DAO's ruling on a malware verdict, by proposal, within the appeal window or, once
    ///         registered in time, whenever it lands before settlement. Final.
    function daoOverrule(bytes32 digest, bool malware) external {
        if (msg.sender != timelock) revert NotTimelock();
        Verdict storage v = verdicts[digest];
        if (v.appealEnds == 0 || v.settled || v.ruling != 0) revert WrongStage();
        if (block.timestamp > v.appealEnds && v.heldUntil == 0) revert TooLate();
        v.ruling = malware ? 1 : 2;
        emit MalwareRuled(digest, malware);
    }

    /// @notice Settle a malware verdict after the appeal window and any registered appeal, or at once
    ///         after the DAO's ruling. Malware slashes the share of yes of the author's bond (all of it
    ///         when the DAO ruled malware), for the reviewers who said yes, and burns that share of
    ///         authorSlashBps of the bonding household's REP, never more than the REP that said yes.
    function settleMalware(bytes32 digest) external {
        Verdict storage v = verdicts[digest];
        if (v.appealEnds == 0 || v.settled) revert WrongStage();
        if (v.ruling == 0 && (block.timestamp <= v.appealEnds || block.timestamp <= v.heldUntil)) revert TooEarly();
        v.settled = true;
        bool malware = v.ruling != 2;
        uint256 slashed;
        uint256 burned;
        if (malware) {
            // The DAO's ruling replaces the reviewers' answer
            uint256 share = v.ruling == 1 ? 1e18 : v.share;
            Bond storage b = bonds[digest];
            slashed = b.stake * share / 1e18;
            b.stake -= slashed;
            // Nobody on chain to share it (no yes in a finalized round): the treasury's
            if (v.yesMass > 0) v.bondPool = slashed;
            else if (slashed > 0) substrate.transfer(address(registry), slashed);
            address liable = bondHousehold[digest];
            uint256 repSlash = rep.balanceOf(liable) * authorSlashBps / BPS * share / 1e18;
            if (repSlash > v.yesMass) repSlash = v.yesMass;
            if (repSlash > 0) {
                burned = rep.slash(liable, repSlash);
                emit AuthorRepBurned(digest, liable, burned);
            }
        }
        emit MalwareSettled(digest, malware, slashed, burned);
    }

    /// @notice A yes review's share of a tool's slashed bond, by REP, from a round finalized before the
    ///         tool concluded. Paid through the Substrate's service rail, so it counts as the reviewer's
    ///         earnings. Anyone can claim it for the reviewer.
    function claimBondShare(bytes32 digest, uint256 epoch, address reviewer) external {
        Verdict storage vd = verdicts[digest];
        Round storage r = _rounds[digest][epoch];
        uint256 idx = _reviewIndex[digest][epoch][reviewer];
        if (vd.bondPool == 0 || !r.beforeConclusion || idx == 0) revert NothingToClaim();
        Review storage v = r.reviews[idx - 1];
        if (v.malware != 1 || v.weight == 0 || v.bondClaimed) revert NothingToClaim();
        v.bondClaimed = true;
        uint256 amount = vd.bondPool * v.weight / vd.yesMass;
        if (amount > 0) substrate.payForService(reviewer, amount, digest);
        emit BondShareClaimed(digest, epoch, reviewer, amount);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    function _startEpoch(uint256 epoch, Epoch storage e) private {
        uint256 snapshot = epoch == 0 ? substrate.deployedAt() : substrate.getAnchor(epoch - 1).timestamp;
        if (snapshot >= block.timestamp) revert TooEarly();
        e.started = true;
        e.snapshot = uint48(snapshot);
        e.revealWindow = uint64(revealWindow);
        e.supply = rep.getPastTotalSupply(snapshot);
        e.unscoredBps = uint16(DEFAULT_UNSCORED_BPS);
        if (address(registry) != address(0)) {
            bytes memory charter = bytes(registry.getRegistryValue(CHARTER_KEY));
            if (charter.length > 0) e.charterHash = sha256(charter);
            e.axisIds = _axisIds(charter);
            e.axes = uint8(e.axisIds.length);
            e.unscoredBps = uint16(_registryBps(UNSCORED_KEY, DEFAULT_UNSCORED_BPS));
        }
        emit EpochStarted(epoch, e.charterHash, e.axisIds, e.snapshot, e.supply, e.unscoredBps);
    }

    /// @dev The charter's axis ids, in order, from its compact JSON: every "id": must be followed by a
    ///      quoted id of [a-z0-9_], distinct, at most MAX_AXES. Anything else yields no axes, so the
    ///      epoch rates the fixed fields only (daemons refuse such a charter anyway).
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
        address household = householdOf(epoch, agent);
        // No household reviews its own tool
        if (b.stake == 0 || b.author == agent || bondHousehold[ri.digest] == household
            || _household(b.author) == household) return false;
        if (_reviewIndex[ri.digest][epoch][agent] != 0) return false;
        // Every fixed field is required
        if (ri.correctness < -100 || ri.correctness > 100 || ri.simplicity > 100 || ri.novelty > 100
            || ri.malware > 1) return false;
        if (ri.scores.length != 0 && ri.scores.length != axes) return false;
        for (uint256 i = 0; i < ri.scores.length; i++) {
            int8 s = int8(uint8(ri.scores[i]));
            if (s != NO_SCORE && (s < -100 || s > 100)) return false;
        }

        Round storage r = _rounds[ri.digest][epoch];
        if (r.stage == Stage.None) {
            r.stage = Stage.Open;
            b.pending++;
        }
        // One weight per household: the review from its earliest commit carries it
        uint256 held = _householdReview[ri.digest][epoch][household];
        if (held != 0) {
            Review storage prior = r.reviews[held - 1];
            if (_committers[epoch][agent].seq < _committers[epoch][prior.reviewer].seq) {
                _tally(ri.digest, epoch, prior, false);
                r.weight -= prior.weight;
                prior.weight = 0;
                emit ReviewUnweighted(ri.digest, epoch, prior.reviewer);
            } else {
                weight = 0;
            }
        }
        r.reviews.push(Review({
            reviewer: agent, correctness: ri.correctness, simplicity: ri.simplicity, novelty: ri.novelty,
            malware: ri.malware, claimed: false, bountied: false, bondClaimed: false, accuracy: 0,
            weight: uint128(weight), scores: ri.scores.length == 0 ? NO_SCORES : bytes16(ri.scores)
        }));
        _reviewIndex[ri.digest][epoch][agent] = r.reviews.length;
        if (weight > 0) {
            _householdReview[ri.digest][epoch][household] = r.reviews.length;
            _tally(ri.digest, epoch, r.reviews[r.reviews.length - 1], true);
            r.weight += weight;
        }
        emit Reviewed(ri.digest, epoch, agent, ri.correctness, ri.simplicity, ri.novelty, ri.malware, ri.scores,
            weight, ri.evidenceHash);
        return true;
    }

    /// @dev Adds a review's weight to its round's sums, or takes it back out.
    function _tally(bytes32 digest, uint256 epoch, Review storage v, bool add) private {
        Epoch storage e = _epochs[epoch];
        uint256 w = v.weight;
        for (uint256 i = 0; i < FIELDS + e.axes; i++) {
            Axis storage a = _roundAxes[digest][epoch][i];
            int128 x = int128(int256(w) * _value(v, i, e.unscoredBps) / 100);
            (a.sum, a.mass) = add ? (a.sum + x, a.mass + uint128(w)) : (a.sum - x, a.mass - uint128(w));
        }
    }

    /// @dev A review's value on field `i`, in hundredths of a score point: unscored axes at the default.
    function _value(Review storage v, uint256 i, uint256 unscoredBps) private view returns (int256) {
        if (i == CORRECTNESS) return int256(v.correctness) * 100;
        if (i == SIMPLICITY) return int256(uint256(v.simplicity)) * 100;
        if (i == NOVELTY) return int256(uint256(v.novelty)) * 100;
        if (i == MALWARE) return int256(uint256(v.malware)) * 10000;
        int8 s = int8(uint8(v.scores[i - FIELDS]));
        return s == NO_SCORE ? int256(unscoredBps) : int256(s) * 100;
    }

    /// @dev An address's household: its owner wallet when it is a bound Substrate agent, else itself.
    function _household(address a) private view returns (address) {
        address owner = substrate.getAgentOwner(a);
        return owner == address(0) ? a : owner;
    }

    /// @dev One review's accuracy against the round's other reviews, and its REP and bounty stakes.
    function _settle(bytes32 digest, uint256 epoch, Round storage r, Review storage v) private {
        uint256 w = v.weight;
        uint256 others = r.weight - w;
        if (others == 0) {
            v.accuracy = UNINFORMATIVE; // nothing to measure it against: no gain or loss
            emit ReviewSettled(digest, epoch, v.reviewer, UNINFORMATIVE);
            return;
        }
        Epoch storage e = _epochs[epoch];
        uint256 n = FIELDS + e.axes;
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            int256 s = _value(v, i, e.unscoredBps);
            // 1 - |value - others' mean| / range, as |value x others - others' sum| / (range x others)
            int256 d = s * int256(others) - (int256(_roundAxes[digest][epoch][i].sum) * 100 - int256(w) * s);
            uint256 range = i == CORRECTNESS || i >= FIELDS ? 20000 : 10000;
            uint256 dist = uint256(d < 0 ? -d : d) * 1e18 / (range * others);
            total += dist < 1e18 ? 1e18 - dist : 0; // unscored defaults round to the wei
        }
        v.accuracy = uint64(total / n);
        emit ReviewSettled(digest, epoch, v.reviewer, v.accuracy);
        if (w > 0) {
            address household = householdOf(epoch, v.reviewer);
            r.repPool += rep.slash(household, w * degradeBps / BPS * (1e18 - v.accuracy) / 1e18);
            r.repWin += w * v.accuracy / 1e18;
            // A sanctioned reviewer's part stays in the bounty
            if (r.bountyBase > 0 && !sanctioned(v.reviewer) && (household == v.reviewer || !sanctioned(household))) {
                v.bountied = true;
                r.bountyWin += w * v.accuracy / 1e18;
            }
        }
    }

    /// The bps a Registry key holds; unset, malformed or above BPS is the default
    function _registryBps(string memory key, uint256 dflt) private view returns (uint256) {
        (uint256 bps, bool ok) = _uint(bytes(registry.getRegistryValue(key)), 0);
        return ok && bps <= BPS ? bps : dflt;
    }

    /// A decimal integer from [start] up to the end or the first non-digit; ok only if it has a digit
    /// and, read as a whole value (from 0), nothing follows
    function _uint(bytes memory v, uint256 start) private pure returns (uint256 n, bool ok) {
        uint256 j = start;
        while (j < v.length && v[j] >= "0" && v[j] <= "9" && j - start < 30) {
            n = n * 10 + uint8(v[j]) - 48;
            j++;
        }
        ok = j > start && (start > 0 || j == v.length);
    }

    // ── Governance ───────────────────────────────────────────────────────────

    function setParams(Params calldata p) external {
        if (msg.sender != timelock) revert NotTimelock();
        _setParams(p);
    }

    function _setParams(Params memory p) private {
        if (p.degradeBps > BPS || p.authorSlashBps > BPS || p.reviewerShareBps > BPS || p.revealWindow == 0
            || p.revealWindow > type(uint64).max) revert BadParams();
        minStake = p.minStake;
        revealWindow = p.revealWindow;
        degradeBps = p.degradeBps;
        authorSlashBps = p.authorSlashBps;
        unbondDelay = p.unbondDelay;
        reviewerShareBps = p.reviewerShareBps;
        appealPeriod = p.appealPeriod;
        emit AppealPeriodSet(p.appealPeriod);
        emit ParamsSet(p.minStake, p.revealWindow, p.degradeBps, p.authorSlashBps, p.unbondDelay, p.reviewerShareBps);
    }
}
