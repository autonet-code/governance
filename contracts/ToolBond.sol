// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./IGovernedEconomy.sol";

/// @notice The parts of the autonet Substrate a bond needs: tool authorship, agent identity and the ATN token.
interface IToolBondSubstrate {
    function toolAuthor(bytes32 manifestDigest) external view returns (address);
    function isRegistered(address agent) external view returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function payForService(address recipient, uint256 amount, bytes32 requestId) external returns (bool);
}

/// @title ToolBond
/// @notice ATN stakes behind autonet tools that replace a core harness part. The harness loads such a
///         tool only while `isBonded(digest)`. Any registered agent can accuse a bonded tool of being
///         malicious by posting a counter-bond and an evidence CID (a daemon-signed trace of the run).
///         The jurisdiction's arbiter rules; the DAO can overrule by proposal within the appeal window,
///         and decides alone if the arbiter stays silent. This is the dispute half of the trustless
///         projects, without the escrow.
///
///         Malicious: the whole stake pays the accuser through Substrate.payForService, so the bounty
///         lands in the accuser's service earnings (and so can be claimed as REP), the counter-bond is
///         returned and the digest can never be bonded again. Not malicious: the counter-bond goes to
///         the author. No ruling within DISPUTE_TIMEOUT: both bonds go back.
contract ToolBond {
    enum Stage { None, Open, Ruled }

    struct Bond {
        address author;
        uint256 stake;
        uint256 unbondRequestedAt; // 0 when bonded
        bool slashed;
    }

    struct Dispute {
        Stage stage;
        address accuser;
        uint256 counterBond;
        string evidenceCid;
        uint256 openedAt;
        bool malicious;    // the arbiter's ruling, once Ruled
        uint256 appealEnds;
    }

    /// @notice After this long without a ruling or overrule, anyone can close a dispute with both bonds returned.
    uint256 public constant DISPUTE_TIMEOUT = 150 days;

    IToolBondSubstrate public immutable substrate;
    IGovernedEconomy public immutable economy; // source of the jurisdiction's appeal window
    address public immutable timelock;

    address public arbiter;
    uint256 public minStake;       // ATN base units
    uint256 public counterBond;    // ATN base units an accuser posts
    uint256 public arbiterWindow;  // seconds the arbiter has before the DAO may decide alone
    uint256 public unbondDelay;    // seconds a stake stays slashable after the author asks to leave

    mapping(bytes32 => Bond) public bonds;
    mapping(bytes32 => Dispute) public disputes;

    event Bonded(bytes32 indexed digest, address indexed author, uint256 amount, uint256 stake);
    event UnbondRequested(bytes32 indexed digest, uint256 availableAt);
    event Unbonded(bytes32 indexed digest, address indexed author, uint256 amount);
    event Accused(bytes32 indexed digest, address indexed accuser, string evidenceCid);
    event Ruled(bytes32 indexed digest, bool malicious, uint256 appealEnds);
    event Resolved(bytes32 indexed digest, bool malicious, bool overruled);
    event DisputeExpired(bytes32 indexed digest);
    event ParamsSet(address arbiter, uint256 minStake, uint256 counterBond, uint256 arbiterWindow, uint256 unbondDelay);

    error NotAuthor();
    error NotArbiter();
    error NotTimelock();
    error NotAgent();
    error Slashed();
    error NotBonded();
    error DisputeOpen();
    error WrongStage();
    error TooEarly();
    error TooLate();
    error ZeroAmount();
    error UnbondDelayTooShort();

    constructor(
        address _substrate,
        address _economy,
        address _timelock,
        address _arbiter,
        uint256 _minStake,
        uint256 _counterBond,
        uint256 _arbiterWindow,
        uint256 _unbondDelay
    ) {
        substrate = IToolBondSubstrate(_substrate);
        economy = IGovernedEconomy(_economy);
        timelock = _timelock;
        _setParams(_arbiter, _minStake, _counterBond, _arbiterWindow, _unbondDelay);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// @notice What the harness checks before loading a tool that replaces a core part.
    function isBonded(bytes32 digest) external view returns (bool) {
        Bond storage b = bonds[digest];
        return !b.slashed && b.unbondRequestedAt == 0 && b.stake >= minStake && b.stake > 0;
    }

    /// @notice The appeal window after a ruling: the jurisdiction's, which never undercuts a proposal lifecycle.
    function appealWindow() public view returns (uint256) {
        return economy.effectiveAppealPeriod();
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

    /// @notice Stop vouching for a tool. It stops counting as bonded at once but stays slashable for unbondDelay.
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
        if (disputes[digest].stage != Stage.None) revert DisputeOpen();
        uint256 amount = b.stake;
        b.stake = 0;
        b.unbondRequestedAt = 0;
        substrate.transfer(msg.sender, amount);
        emit Unbonded(digest, msg.sender, amount);
    }

    // ── Dispute ──────────────────────────────────────────────────────────────

    /// @notice Accuse a staked tool. Registered agents only; posts the counter-bond (approve it first).
    function accuse(bytes32 digest, string calldata evidenceCid) external {
        if (!substrate.isRegistered(msg.sender)) revert NotAgent();
        Bond storage b = bonds[digest];
        if (b.stake == 0 || b.slashed) revert NotBonded();
        Dispute storage d = disputes[digest];
        if (d.stage != Stage.None) revert DisputeOpen();
        uint256 posted = counterBond;
        disputes[digest] = Dispute({
            stage: Stage.Open,
            accuser: msg.sender,
            counterBond: posted,
            evidenceCid: evidenceCid,
            openedAt: block.timestamp,
            malicious: false,
            appealEnds: 0
        });
        if (posted > 0) substrate.transferFrom(msg.sender, address(this), posted);
        emit Accused(digest, msg.sender, evidenceCid);
    }

    function rule(bytes32 digest, bool malicious) external {
        if (msg.sender != arbiter) revert NotArbiter();
        Dispute storage d = disputes[digest];
        if (d.stage != Stage.Open) revert WrongStage();
        d.stage = Stage.Ruled;
        d.malicious = malicious;
        d.appealEnds = block.timestamp + appealWindow();
        emit Ruled(digest, malicious, d.appealEnds);
    }

    /// @notice The DAO's decision, by proposal: within the appeal window of a ruling, or once the arbiter has
    ///         been silent past arbiterWindow.
    function daoOverrule(bytes32 digest, bool malicious) external {
        if (msg.sender != timelock) revert NotTimelock();
        Dispute storage d = disputes[digest];
        if (d.stage == Stage.Ruled) {
            if (block.timestamp > d.appealEnds) revert TooLate();
        } else if (d.stage == Stage.Open) {
            if (block.timestamp <= d.openedAt + arbiterWindow) revert TooEarly();
        } else {
            revert WrongStage();
        }
        _resolve(digest, malicious, true);
    }

    /// @notice Anyone can enforce the arbiter's ruling once the appeal window has passed.
    function finalize(bytes32 digest) external {
        Dispute storage d = disputes[digest];
        if (d.stage != Stage.Ruled) revert WrongStage();
        if (block.timestamp <= d.appealEnds) revert TooEarly();
        _resolve(digest, d.malicious, false);
    }

    /// @notice Close a dispute nobody decided: both bonds return.
    function expire(bytes32 digest) external {
        Dispute storage d = disputes[digest];
        if (d.stage != Stage.Open) revert WrongStage();
        if (block.timestamp <= d.openedAt + DISPUTE_TIMEOUT) revert TooEarly();
        address accuser = d.accuser;
        uint256 posted = d.counterBond;
        delete disputes[digest];
        if (posted > 0) substrate.transfer(accuser, posted);
        emit DisputeExpired(digest);
    }

    function _resolve(bytes32 digest, bool malicious, bool overruled) private {
        Dispute memory d = disputes[digest];
        delete disputes[digest];
        Bond storage b = bonds[digest];
        if (malicious) {
            uint256 bounty = b.stake;
            b.stake = 0;
            b.unbondRequestedAt = 0;
            b.slashed = true;
            if (d.counterBond > 0) substrate.transfer(d.accuser, d.counterBond);
            // Through the service rail, so the bounty counts as the accuser's earnings
            if (bounty > 0) substrate.payForService(d.accuser, bounty, digest);
        } else if (d.counterBond > 0) {
            substrate.transfer(b.author, d.counterBond);
        }
        emit Resolved(digest, malicious, overruled);
    }

    // ── Governance ───────────────────────────────────────────────────────────

    function setParams(address _arbiter, uint256 _minStake, uint256 _counterBond, uint256 _arbiterWindow, uint256 _unbondDelay) external {
        if (msg.sender != timelock) revert NotTimelock();
        _setParams(_arbiter, _minStake, _counterBond, _arbiterWindow, _unbondDelay);
    }

    // A stake must stay slashable for at least one full ruling plus appeal, or an author could leave the
    // moment an accusation looks likely.
    function _setParams(address _arbiter, uint256 _minStake, uint256 _counterBond, uint256 _arbiterWindow, uint256 _unbondDelay) private {
        if (_unbondDelay < _arbiterWindow + appealWindow()) revert UnbondDelayTooShort();
        arbiter = _arbiter;
        minStake = _minStake;
        counterBond = _counterBond;
        arbiterWindow = _arbiterWindow;
        unbondDelay = _unbondDelay;
        emit ParamsSet(_arbiter, _minStake, _counterBond, _arbiterWindow, _unbondDelay);
    }
}
