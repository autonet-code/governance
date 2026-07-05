// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal read surface of the autonet Substrate.sol this mirror depends
///         on. `agentReputation` is the soulbound, MONOTONIC contribution ledger
///         (Substrate.sol: agentMintTotal, only ever `+=` in
///         recordTrainingForEpoch, no decrement / no transfer fn — verified
///         2026-07-05). `getAgentOwner` returns the human owner wallet an agent
///         is owner-bound to (address(0) = ownerless / legacy registerAgent path).
interface ISubstrateReputation {
    function agentReputation(address agent) external view returns (uint256);
    function getAgentOwner(address agent) external view returns (address);
}

/// @notice Minimal mint surface of RepToken this mirror needs. RepToken.mint is
///         gated to `admin || minters[msg.sender]`; the mirror must be granted
///         minter rights by the DAO timelock (RepToken.setMinter is
///         admin/timelock-gated). See deploy note in
///         scripts/deploy-reputation-mirror.js.
interface IMintableRepToken {
    function mint(address to, uint256 amount) external;
}

/// @title ReputationMirror
/// @notice Derivation mirror per docs/jurisdiction_wiring_map.md §B3: the
///         ratified rule is **mirror, don't bridge**. Two reputation ledgers
///         measure different things and belong to different entities —
///         `agentReputation` (agent, soulbound, the substrate VERDICT/quality
///         layer) vs. RepToken (human, IVotes, the DAO DIRECTION weight). No
///         token ever flows between them and no substrate token is custodied
///         here. This contract only READS agentReputation and, per period,
///         issues fresh RepToken to the HUMAN OWNER of each owner-bound agent,
///         proportional to the reputation that agent EARNED (delta) since its
///         last sync, scaled by the governable `repPerReputation` exchange rate.
///
///         Flow:  sync(agents[])  — anyone; per-agent, reads substrate,
///                                   accrues owner's pending balance by the delta
///                                   of reputation since that agent's last sync.
///                claim(owner)     — anyone; mints the owner's accrued pending
///                                   RepToken and zeroes the pending balance.
///
/// @dev    Anti-gaming, all enforced in-contract:
///         - Delta-based accrual over a MONOTONIC source: pending grows only by
///           new reputation, never re-counting old.
///         - Per-agent sync cursor (`syncedReputation[agent]`) makes
///           double-count impossible regardless of how often sync is called.
///         - Deploy-block baseline: an agent's FIRST sync sets its cursor to the
///           current substrate reputation and mints NOTHING, so reputation
///           earned before this mirror existed never accrues.
///         - Ownerless agents (getAgentOwner == address(0)) accrue nothing.
contract ReputationMirror {
    /// @notice The autonet Substrate contract this mirror reads reputation from.
    ISubstrateReputation public immutable substrate;
    /// @notice The RepToken this mirror mints. The mirror must be a minter on it.
    IMintableRepToken public immutable repToken;
    /// @notice The DAO timelock: the ONLY address allowed to change the rate.
    ///         This is the direction/quality exchange-rate governor.
    address public immutable timelock;

    /// @notice Advisory period length (seconds). The current period index is
    ///         `block.timestamp / period` (period == 0 => single period 0). The
    ///         mirror is idempotent per (agent, period): an agent contributes at
    ///         most once per period, so a burst of syncs within one period cannot
    ///         inflate accrual beyond the true reputation delta.
    uint256 public immutable period;

    /// @notice The block this mirror was deployed at — the baseline boundary.
    ///         Reputation earned before this is never accrued (enforced via the
    ///         first-sync-sets-cursor rule, this is recorded for auditability).
    uint256 public immutable deployBlock;

    /// @dev RATE KNOB — GOVERNABLE BY THE TIMELOCK ONLY.
    ///      This is the direction/quality exchange rate the user must eventually
    ///      bless (see wiring map §D.4 and CLAUDE.md "alignment pricing" — an
    ///      economic-model parameter). RepToken minted =
    ///      reputationDelta * repPerReputation / RATE_ONE.
    ///      Default RATE_ONE == 1:1.
    uint256 public constant RATE_ONE = 1e18;
    uint256 public repPerReputation;

    /// @dev agent => the substrate reputation value at that agent's last sync.
    ///      This is the per-agent cursor. The FIRST sync sets it to the current
    ///      substrate reputation and accrues nothing (baseline).
    mapping(address => uint256) public syncedReputation;

    /// @dev agent => whether the agent has ever been synced (distinguishes a
    ///      genuine cursor of 0 from "never seen", so the baseline mints nothing
    ///      exactly once).
    mapping(address => bool) public everSynced;

    /// @dev agent => the last period index in which this agent was synced
    ///      (recorded metadata for auditing / off-chain period accounting).
    ///      NOTE: correctness does NOT rely on this. Double-count is impossible
    ///      because accrual is the DELTA over the monotonic per-agent cursor
    ///      (`syncedReputation`): any re-sync within OR across periods sees the
    ///      already-advanced cursor and accrues only genuinely-new reputation.
    ///      "Idempotent per (agent, period)" therefore holds a fortiori — an
    ///      agent's reputation earned in a period can be booked at most once,
    ///      no matter how many times sync() is called.
    mapping(address => uint256) public lastSyncedPeriod;

    /// @dev owner => RepToken accrued but not yet claimed (18-decimals, already
    ///      rate-scaled).
    mapping(address => uint256) public pending;

    event RateUpdated(uint256 previous, uint256 current);
    event AgentSynced(
        address indexed agent,
        address indexed owner,
        uint256 reputationDelta,
        uint256 repAccrued,
        uint256 period
    );
    event Claimed(address indexed owner, uint256 amount);

    error NotTimelock();
    error NothingToClaim();
    error ZeroAddress();

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert NotTimelock();
        _;
    }

    /// @param _substrate  autonet Substrate.sol address (reputation source).
    /// @param _repToken   RepToken address (mint target). The mirror must be
    ///                    granted minter rights on it by the timelock.
    /// @param _period     Advisory period length in seconds (0 => single period).
    constructor(address _substrate, address _repToken, uint256 _period) {
        if (_substrate == address(0) || _repToken == address(0)) revert ZeroAddress();
        substrate = ISubstrateReputation(_substrate);
        repToken = IMintableRepToken(_repToken);
        timelock = _repTimelock(_repToken);
        period = _period;
        deployBlock = block.number;
        repPerReputation = RATE_ONE; // 1:1 default; timelock may change.
    }

    /// @dev The mirror's rate governor IS the RepToken's timelock — a single
    ///      source of truth, so the rate knob is governed by exactly the same
    ///      authority that governs the RepToken it mints. Read once at
    ///      construction and frozen (immutable).
    function _repTimelock(address _repToken) private view returns (address) {
        return IRepTokenTimelock(_repToken).timelockAddress();
    }

    /// @notice The current period index.
    function currentPeriod() public view returns (uint256) {
        if (period == 0) return 0;
        return block.timestamp / period;
    }

    /// @notice Sync a batch of agents for the current period. Permissionless.
    ///         For each agent: reads its current substrate reputation and owner;
    ///         accrues the DELTA since that agent's last sync to its owner's
    ///         pending balance (rate-scaled); advances the agent's cursor.
    ///         - First-ever sync of an agent sets the baseline and accrues nothing.
    ///         - A repeat sync of the same agent in the same period is a no-op.
    ///         - An ownerless agent accrues nothing (but still advances cursor).
    /// @param agents The agent addresses to sync. Duplicates within the array are
    ///               harmless: the first advances the cursor, the rest see zero
    ///               delta / same-period no-op.
    function sync(address[] calldata agents) external {
        uint256 nowPeriod = currentPeriod();
        uint256 rate = repPerReputation;

        for (uint256 i = 0; i < agents.length; i++) {
            address agent = agents[i];

            uint256 current = substrate.agentReputation(agent);

            // Baseline: first time we ever see this agent, record the cursor and
            // mint nothing. Reputation earned before this instant is pre-mirror.
            if (!everSynced[agent]) {
                everSynced[agent] = true;
                syncedReputation[agent] = current;
                lastSyncedPeriod[agent] = nowPeriod;
                emit AgentSynced(agent, substrate.getAgentOwner(agent), 0, 0, nowPeriod);
                continue;
            }

            uint256 cursor = syncedReputation[agent];
            lastSyncedPeriod[agent] = nowPeriod;

            // Monotonic source: current >= cursor always. Guard defensively.
            if (current <= cursor) {
                emit AgentSynced(agent, substrate.getAgentOwner(agent), 0, 0, nowPeriod);
                continue;
            }

            uint256 delta = current - cursor;
            syncedReputation[agent] = current;

            address owner = substrate.getAgentOwner(agent);
            if (owner == address(0)) {
                // Ownerless: cursor advanced (so the same reputation can never
                // later accrue to a future owner either — matches soulbound
                // "earned by the agent, not retroactively assignable"), but
                // nothing is minted.
                emit AgentSynced(agent, address(0), delta, 0, nowPeriod);
                continue;
            }

            uint256 repAccrued = (delta * rate) / RATE_ONE;
            if (repAccrued > 0) {
                pending[owner] += repAccrued;
            }
            emit AgentSynced(agent, owner, delta, repAccrued, nowPeriod);
        }
    }

    /// @notice Mint the owner's accrued RepToken and zero their pending balance.
    ///         Permissionless (anyone can trigger a claim FOR an owner; tokens
    ///         always mint to the owner, never the caller).
    function claim(address owner) external {
        if (owner == address(0)) revert ZeroAddress();
        uint256 amount = pending[owner];
        if (amount == 0) revert NothingToClaim();
        pending[owner] = 0;
        repToken.mint(owner, amount);
        emit Claimed(owner, amount);
    }

    /// @notice RATE KNOB setter — TIMELOCK ONLY.
    ///         This is the governance-blessed direction/quality exchange rate.
    ///         Changing it affects only FUTURE accrual (already-pending balances
    ///         were scaled at the rate in force when they were synced).
    function setRepPerReputation(uint256 newRate) external onlyTimelock {
        emit RateUpdated(repPerReputation, newRate);
        repPerReputation = newRate;
    }
}

/// @dev Read RepToken.timelockAddress() (public immutable on RepToken) so the
///     mirror binds to the same governor as the token it mints, without a
///     constructor arg that could diverge from RepToken's real timelock.
interface IRepTokenTimelock {
    function timelockAddress() external view returns (address);
}
