// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal read surface of the autonet Substrate.sol this claim rail
///         depends on. Under the 2026-07-10 decision (fees-only emission +
///         REP-from-earnings), Substrate.sol is a PURE MONEY contract that no
///         longer mints reputation; instead it exposes a CUMULATIVE, MONOTONIC
///         per-claimant earnings ledger in ATN base units (ATN * 1e6, Substrate
///         deliberately has NO decimals()):
///           - agentMintTotal(claimant) : tool-pool distributions to household
///                                       owner wallets (merkle-ratified via
///                                       claimFor; only `+=`).
///         REP is a pull claim on it ("voice is always work-backed"). Service
///         revenue (serviceEarnings) earns no REP: at the fee rate it would buy
///         REP by washing payments (autonet decision 2026-10-27), while tool-pool
///         mints are capped by fees actually burned.
interface ISubstrateEarnings {
    function agentMintTotal(address agent) external view returns (uint256);
    function isRegistered(address agent) external view returns (bool);
    function getAgentOwner(address agent) external view returns (address);
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
///         only mint REP against ATN it PROVABLY EARNED from the tool pool. You
///         cannot lie about REP because you cannot lie about ATN a ratified close
///         paid you.
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
///           claim(x)     — permissionless trigger; reads x's cumulative earnings
///                          base, subtracts x's stored watermark, mints the delta
///                          1:1 (whole-token) as REP to recipientOf(x), advances
///                          the watermark. Zero delta reverts (NothingToClaim).
///
///         Who receives (Decision 2026-10-27, "the owner wallet claims, the daemon
///         operates"): REP goes to households, never to agent keys. Earnings of a
///         registered agent (a tool-pool leaf naming it) mint to its owner wallet,
///         revoked or not: revocation means the key is lost or misbehaving, so it
///         gets no governance weight, while the work it did still counts for its
///         household. Any other address is a household owner wallet and claims its
///         own tool-pool earnings, which only a ratified close can name.
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

    /// @dev earner => cumulative earnings base (ATN base units) already claimed.
    ///      The per-earner watermark over its monotonic earnings base. Double-count is impossible: each claim mints
    ///      only (base - watermark) and advances the watermark to base.
    mapping(address => uint256) public claimedEarnings;

    /// @notice Emitted per successful claim. `earningsDelta` is in ATN base units;
    ///         `repMinted` is in 18-decimal REP (earningsDelta * 1e12).
    event RepClaimed(address indexed earner, address indexed to, uint256 earningsDelta, uint256 repMinted);

    error ZeroAddress();
    error LengthMismatch();
    error NothingToClaim();

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

    /// @notice The cumulative earnings base of `earner`, in ATN base units: its
    ///         tool-pool distributions, a monotonic ledger. A watermark set while
    ///         service revenue still counted can sit above it; nothing is claimable
    ///         until the base passes it.
    function earningsBase(address earner) public view returns (uint256) {
        return substrate.agentMintTotal(earner);
    }

    /// @notice Where `earner`'s REP mints: a registered agent's owner wallet, else
    ///         the earner itself (a household owner wallet).
    function recipientOf(address earner) public view returns (address) {
        if (!substrate.isRegistered(earner)) return earner;
        address owner = substrate.getAgentOwner(earner);
        return owner == address(0) ? earner : owner;
    }

    /// @notice The REP `earner`'s earnings could mint right now (18-decimal), = the
    ///         unclaimed ATN-base delta scaled by 1e12. Zero if nothing new was earned.
    function claimable(address earner) external view returns (uint256) {
        uint256 base = earningsBase(earner);
        uint256 watermark = claimedEarnings[earner];
        if (base <= watermark) return 0;
        return (base - watermark) * REP_PER_ATN_BASE;
    }

    /// @notice Mint `earner`'s unclaimed REP 1:1 (whole-token) to recipientOf(earner)
    ///         and advance its watermark. Permissionless trigger: anyone may call
    ///         claim for any earner; REP never mints to the caller.
    ///         Reverts NothingToClaim on a zero delta.
    function claim(address earner) external {
        if (earner == address(0)) revert ZeroAddress();

        uint256 base = earningsBase(earner);
        uint256 watermark = claimedEarnings[earner];
        if (base <= watermark) revert NothingToClaim();

        uint256 earningsDelta = base - watermark;      // ATN base units
        uint256 repMinted = earningsDelta * REP_PER_ATN_BASE; // 18-decimal REP
        address to = recipientOf(earner);

        claimedEarnings[earner] = base;
        // The household votes its own REP unless it already chose a delegate (typically its
        // daemon's operator key, which is drawn for and votes in anchor elections)
        repToken.mintDelegated(to, repMinted);

        emit RepClaimed(earner, to, earningsDelta, repMinted);
    }
}
