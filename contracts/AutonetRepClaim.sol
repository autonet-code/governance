// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal read surface of the autonet Substrate.sol this claim rail
///         depends on. Under the 2026-07-10 decision (fees-only emission +
///         REP-from-earnings), Substrate.sol is a PURE MONEY contract that no
///         longer mints reputation; instead it exposes two CUMULATIVE, MONOTONIC
///         per-recipient earnings ledgers, both denominated in ATN base units
///         (ATN * 1e6 — Substrate deliberately has NO decimals()):
///           - agentMintTotal(agent)  : tool-pool distributions (merkle-ratified
///                                       via recordTrainingForEpoch; only `+=`).
///           - serviceEarnings(agent) : net service revenue counter, bumped by
///                                       payForService; only `+=`.
///         REP is a pull claim on the SUM of these — "voice is always work-backed".
///         Pure spenders/buyers appear in neither ledger and claim NOTHING.
interface ISubstrateEarnings {
    function agentMintTotal(address agent) external view returns (uint256);
    function serviceEarnings(address agent) external view returns (uint256);
    function isLive(address agent) external view returns (bool);
}

/// @notice Minimal mint surface of RepToken this rail needs. RepToken.mint is
///         gated to `admin || minters[msg.sender]`; this contract must be granted
///         minter rights by the DAO timelock (RepToken.setMinter is
///         admin/timelock-gated). See the governance-action note in the contract
///         header and scripts/deploy-autonet-rep-claim.js.
interface IMintableRepToken {
    function mint(address to, uint256 amount) external;
    function mintDelegated(address to, uint256 amount) external;
}

/// @title AutonetRepClaim
/// @notice REP (reputation = the DAO governance token = review weight, ONE asset
///         living in RepToken) as PULL CLAIMS on autonet earnings. Ratified in
///         docs/tool_substrate.md "Decision (2026-07-10): fees-only emission +
///         REP-from-earnings".
///
///         The model in one line: **voice is always work-backed** — an agent may
///         only mint REP against ATN it PROVABLY EARNED on the substrate (tool-pool
///         distributions + net service revenue). You cannot lie about REP because
///         you cannot lie about ATN you were provably paid.
///
///         This rail deliberately echoes the trustless-economy claim pattern
///         (RepToken.claimReputationFromEconomy: watermarked, delta-based, pull)
///         but with a HARDCODED 1:1 rate — no parity key, no rate knob. Ratified
///         reasoning: REP is only ever used as a SHARE, so a constant rate cancels
///         out of every share computation; a governable rate would be a
///         voice-repricing lever with no named use case. If a need ever appears,
///         governance ships a forward-only change. NO admin, NO pause, NO rate.
///
///         Flow:
///           claim(agent) — permissionless trigger; reads the agent's cumulative
///                          earnings base (agentMintTotal + serviceEarnings),
///                          subtracts the stored per-agent watermark, mints the
///                          delta 1:1 (whole-token) as REP TO THE AGENT, advances
///                          the watermark. Zero delta reverts (NothingToClaim).
///
///         Anti-double-count: the watermark is the cursor over a MONOTONIC base.
///         Pending grows only by newly-earned ATN, never re-counting old; any
///         number of claims sees the already-advanced watermark.
///
/// @dev    DECIMAL SCALING (verified, load-bearing): the earnings base is in ATN
///         BASE UNITS (1 ATN = 1e6). RepToken.decimals() == 18 (RepToken.sol
///         returns a fixed 18). "1:1 in whole-token terms" therefore means 1 ATN
///         earned -> 1 whole REP minted, i.e. multiply the ATN-base delta by
///         10**(18-6) = 1e12. That constant is REP_PER_ATN_BASE below. A fractional
///         ATN earning (base units < 1e6) still scales exactly (e.g. 0.5 ATN =
///         500_000 base -> 0.5e18 REP); the scaling is exact, never truncating,
///         because 1e12 divides evenly into RepToken's 1e18.
///
///         MINTER WIRING — the governance action that swaps mirror -> claim:
///         RepToken.mint(to, amount) is gated to `admin || minters[msg.sender]`
///         (RepToken.sol). After jurisdiction finalize, `admin` is the DAO
///         TimelockController. This contract needs to be in the `minters` set,
///         which is set via RepToken.setMinter(claim, true) — itself
///         `admin || timelock`-gated. So the swap is TWO calls in ONE governance
///         proposal executed by the timelock:
///           1) RepToken.setMinter(<AutonetRepClaim addr>, true)   // grant new
///           2) RepToken.setMinter(<ReputationMirror addr>, false) // revoke old
///         ReputationMirror is RETIRED by this decision (nothing to mirror; REP
///         is a pure function of ratified earnings computed here) but its code is
///         kept in-tree, marked DEPRECATED. scripts/deploy-autonet-rep-claim.js
///         emits the exact calldata for both.
contract AutonetRepClaim {
    /// @notice The autonet Substrate contract this rail reads earnings from.
    ISubstrateEarnings public immutable substrate;

    /// @notice The RepToken this rail mints. This contract must be a minter on it.
    IMintableRepToken public immutable repToken;

    /// @dev ATN base unit is 1e6; RepToken is 18-decimal. 1 ATN earned == 1 whole
    ///      REP, so an ATN-base delta scales up by 10**(18-6) = 1e12. Exact:
    ///      1e12 divides 1e18 evenly, so no sub-ATN earning is ever truncated.
    uint256 public constant ATN_BASE = 1e6;
    uint256 public constant REP_DECIMALS = 1e18;
    uint256 public constant REP_PER_ATN_BASE = REP_DECIMALS / ATN_BASE; // == 1e12

    /// @dev agent => cumulative earnings base (ATN base units) already claimed.
    ///      The per-agent watermark over the monotonic (agentMintTotal +
    ///      serviceEarnings) base. Double-count is impossible: each claim mints
    ///      only (base - watermark) and advances the watermark to base.
    mapping(address => uint256) public claimedEarnings;

    /// @notice Emitted per successful claim. `earningsDelta` is in ATN base units;
    ///         `repMinted` is in 18-decimal REP (earningsDelta * 1e12).
    event RepClaimed(address indexed agent, uint256 earningsDelta, uint256 repMinted);

    error ZeroAddress();
    error LengthMismatch();
    error NothingToClaim();
    error NotAgent();

    /// @param _substrate       autonet Substrate.sol address (earnings source).
    /// @param _repToken        RepToken address (mint target). This contract must
    ///                         be granted minter rights on it by the timelock (see
    ///                         the header's MINTER WIRING note).
    /// @param genesisHolders   One-time genesis REP seed recipients (the youth
    ///                         defense that replaces the retired supply-pegged β).
    ///                         Minted at deploy, visible on-chain, and DILUTES
    ///                         automatically as real earnings mint new REP.
    /// @param genesisAmounts   REP amounts (18-decimal) for each genesis holder.
    ///                         Amounts are a deploy-time launch decision; this
    ///                         constructor only provides the mechanism.
    ///
    /// @dev    The genesis mint requires this contract to already be a minter on
    ///         RepToken at construction time. If genesisHolders is empty the
    ///         minter grant may follow deploy; if non-empty, grant minter rights
    ///         to the PRECOMPUTED claim address (or deploy as admin) BEFORE the
    ///         constructor runs, or pass an empty genesis array and seed via a
    ///         separate governance mint. scripts/deploy-autonet-rep-claim.js
    ///         documents both orderings.
    constructor(
        address _substrate,
        address _repToken,
        address[] memory genesisHolders,
        uint256[] memory genesisAmounts
    ) {
        if (_substrate == address(0) || _repToken == address(0)) revert ZeroAddress();
        if (genesisHolders.length != genesisAmounts.length) revert LengthMismatch();

        substrate = ISubstrateEarnings(_substrate);
        repToken = IMintableRepToken(_repToken);

        for (uint256 i = 0; i < genesisHolders.length; i++) {
            if (genesisHolders[i] == address(0)) revert ZeroAddress();
            // Zero amounts are permitted (a placeholder holder), but there is no
            // reason to; the mint below simply no-ops for a zero amount.
            if (genesisAmounts[i] > 0) {
                repToken.mint(genesisHolders[i], genesisAmounts[i]);
            }
        }
    }

    /// @notice The cumulative earnings base for an agent, in ATN base units:
    ///         tool-pool distributions + net service revenue. Both source ledgers
    ///         are monotonic, so this sum is monotonic.
    function earningsBase(address agent) public view returns (uint256) {
        return substrate.agentMintTotal(agent) + substrate.serviceEarnings(agent);
    }

    /// @notice The REP an agent could mint right now (18-decimal), = the unclaimed
    ///         ATN-base delta scaled by 1e12. Zero if nothing new was earned.
    function claimable(address agent) external view returns (uint256) {
        if (!substrate.isLive(agent)) return 0;
        uint256 base = earningsBase(agent);
        uint256 watermark = claimedEarnings[agent];
        if (base <= watermark) return 0;
        return (base - watermark) * REP_PER_ATN_BASE;
    }

    /// @notice Mint an agent's unclaimed REP 1:1 (whole-token) and advance its
    ///         watermark. Permissionless trigger — anyone may call claim FOR an
    ///         agent; REP always mints to the AGENT, never the caller (mirrors the
    ///         economy pull convention where tokens go to the subject).
    ///         Reverts NothingToClaim on a zero delta (matches the economy's
    ///         "no-op" pull convention as an explicit revert, per this repo's
    ///         ReputationMirror.claim style).
    ///         Only registered Substrate agents can claim: earnings paid to any
    ///         other address (a VentureVault, a payment router) would otherwise
    ///         become REP that nobody can use but that still counts toward the
    ///         supply and quorum.
    function claim(address agent) external {
        if (agent == address(0)) revert ZeroAddress();
        if (!substrate.isLive(agent)) revert NotAgent();

        uint256 base = earningsBase(agent);
        uint256 watermark = claimedEarnings[agent];
        if (base <= watermark) revert NothingToClaim();

        uint256 earningsDelta = base - watermark;      // ATN base units
        uint256 repMinted = earningsDelta * REP_PER_ATN_BASE; // 18-decimal REP

        claimedEarnings[agent] = base;
        // The agent votes its own REP (it signs Substrate anchors with it) unless it already chose a delegate
        repToken.mintDelegated(agent, repMinted);

        emit RepClaimed(agent, earningsDelta, repMinted);
    }
}
