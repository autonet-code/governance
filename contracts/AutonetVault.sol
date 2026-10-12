// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Registry} from "./Registry.sol";

/**
 * @notice Minimal mint surface the vault needs on the Autonet network's
 *         Substrate contract. The Substrate contract (in the autonet repo,
 *         `contracts/core/Substrate.sol`) will IMPLEMENT this — the vault only
 *         CONSUMES it.
 *
 * Kept deliberately tiny (one function) so the autonet side has a small,
 * unambiguous surface to add. `mintFromVault` mints `amount` base units of the
 * network ATN token (which is 1e6-scaled — see DECIMALS note below) to `to`.
 * Substrate today has NO admin mint (only `recordTrainingForEpoch`); adding
 * `mintFromVault`, gated to the vault address, is the autonet-side change this
 * interface pins.
 */
interface IAutonetATN {
    function mintFromVault(address to, uint256 amount) external;
}

/**
 * @title AutonetVault
 * @notice A CoinOffering-shaped satellite that lets a JURISDICTION DAO sell ATN
 *         (the Autonet network's substrate token) for registry-whitelisted
 *         ERC20s. It is a ROUTER, not a custodian:
 *
 *           - inbound payment tokens are pulled straight into the DAO treasury
 *             (Registry) in the same call — the vault never holds cash;
 *           - ATN is minted to the buyer on the EXTERNAL Substrate contract via
 *             `IAutonetATN.mintFromVault`. The vault holds no ATN inventory.
 *
 * DIFFERENCES FROM CoinOffering ("CO")
 * ------------------------------------
 *   - NO SALE CAP. The offering is uncapped; supply policy lives on the
 *     Autonet network (Substrate emission), not here.
 *   - BUY ONLY. No redeem path.
 *   - EXTERNAL minted token. CO mints an in-suite RepToken/ERC20Votes governance
 *     token (`IMintableATNB.mint`); this vault mints the Autonet NETWORK token on
 *     a foreign contract (`IAutonetATN.mintFromVault`), whose address is
 *     immutable (constructor arg). No auto-delegation, no governance-power
 *     concerns — ATN is a network credit, not this DAO's governance token.
 *
 * PARITY (one meaning across the jurisdiction)
 * ---------------------------------------------
 * Price is NOT set here. The vault reads the registry key
 *   "jurisdiction.parity.<lowercaseTokenHex>"
 * the same key RepToken and CoinOffering read: an 18-decimal fixed-point
 * multiplier from payment-token base units to 18-decimal jurisdiction units
 * (REP base units). Absent / "0" means the token is NOT whitelisted.
 *
 * ATN prices like REP: 1 ATN (1e6 base units, Substrate has no decimals())
 * equals 1 REP (1e18), the same 1:1 AutonetRepClaim uses. So the vault converts
 * jurisdiction units to ATN base units by dividing by REP_PER_ATN_BASE (1e12):
 *
 *   atnOut = paymentAmount * parity / 1e18 / 1e12
 *
 * One parity therefore means the same thing everywhere: a USDC parity of 1e30
 * makes 1 USDC worth 1 REP when earned in a project, 1 ATNB in the coin
 * offering and 1 ATN from this vault.
 *
 *   1 USDC (6 dec) -> 1 ATN:  parity = 1e30   (1e6 * 1e30 / 1e30 = 1e6 = 1 ATN)
 *   1 USDC (6 dec) -> 2 ATN:  parity = 2e30
 *   1 DAI (18 dec) -> 1 ATN:  parity = 1e18   (1e18 * 1e18 / 1e30 = 1e6 = 1 ATN)
 *
 * A payment that yields < 1 ATN base unit reverts with DustAmount (never a
 * silent 0).
 *
 * GOVERNANCE
 * ----------
 * There is NOTHING to govern on the vault itself beyond CO's minimum: parity /
 * whitelist are edited on the Registry (through the DAO timelock), which the
 * vault only READS. `admin` (expected: the Timelock) holds only the
 * pause/unpause and admin-transfer powers CO has — no rate/cap knobs, because
 * there is no cap and the rate is the registry parity.
 */
contract AutonetVault is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // =========================================================================
    // CONSTANTS, IMMUTABLES & STATE
    // =========================================================================

    /// @notice Parity fixed-point scale. parity == PARITY_ONE means 1:1.
    uint256 internal constant PARITY_ONE = 1e18;
    /// @notice REP base units per ATN base unit (1 ATN = 1e6, 1 REP = 1e18).
    uint256 public constant REP_PER_ATN_BASE = 1e12;

    /// @notice The EXTERNAL Autonet network ATN token (Substrate). Minted via
    ///         IAutonetATN.mintFromVault. 6-decimal (1e6-scaled) — see header.
    address public immutable atnToken;

    /// @notice The DAO treasury. Inbound payment tokens are routed here directly.
    address payable public immutable registryAddress;

    /// @notice Admin (expected: the Timelock). Holds pause + admin-transfer only.
    address public admin;

    /// @notice Total ATN base units minted to buyers so far (uncapped).
    uint256 public totalMinted;

    /// @notice Total payment routed to the treasury, per payment token.
    mapping(address => uint256) public totalRaised;

    // =========================================================================
    // EVENTS
    // =========================================================================

    event AtnPurchased(
        address indexed buyer,
        address indexed paymentToken,
        uint256 paymentAmount,
        uint256 atnOut,
        uint256 parity
    );
    event AdminTransferred(address indexed previous, address indexed current);

    // =========================================================================
    // ERRORS
    // =========================================================================

    error ZeroAddress();
    error InvalidAmount();
    error TokenNotRegistered(address token);
    error NotAdmin();
    error DustAmount(); // payment too small to yield any ATN base unit at parity

    // =========================================================================
    // MODIFIERS
    // =========================================================================

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * @param _atnToken   The Autonet network Substrate contract (implements
     *                    IAutonetATN.mintFromVault). Immutable.
     * @param _registryAddress The DAO Registry (treasury + parity source).
     * @param _admin      Config/pause admin (expected: the DAO Timelock).
     */
    constructor(
        address _atnToken,
        address payable _registryAddress,
        address _admin
    ) {
        if (
            _atnToken == address(0) ||
            _registryAddress == address(0) ||
            _admin == address(0)
        ) revert ZeroAddress();

        atnToken = _atnToken;
        registryAddress = _registryAddress;
        admin = _admin;
    }

    // =========================================================================
    // BUY
    // =========================================================================

    /**
     * @notice Buy ATN with a registry-whitelisted payment token at registry
     *         parity. Payment is routed straight to the treasury; ATN is minted
     *         to the buyer on the external Substrate contract. Uncapped.
     * @param paymentToken The ERC20 used to pay (must have a nonzero registry parity).
     * @param paymentAmount Amount of paymentToken to spend (base units).
     * @return atnOut Amount of ATN minted (base units, 1e6-scaled).
     */
    function buy(address paymentToken, uint256 paymentAmount)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 atnOut)
    {
        if (paymentAmount == 0) revert InvalidAmount();

        uint256 parity = _readParity(paymentToken);
        if (parity == 0) revert TokenNotRegistered(paymentToken);

        atnOut = (paymentAmount * parity) / (PARITY_ONE * REP_PER_ATN_BASE);
        if (atnOut == 0) revert DustAmount();

        // Effects
        totalMinted += atnOut;
        totalRaised[paymentToken] += paymentAmount;

        // Interactions ---------------------------------------------------------

        // 1. Route payment straight to the DAO treasury (vault never custodies
        //    cash). SafeERC20 handles non-standard (no-bool) tokens. NOTE: a
        //    fee-on-transfer payment token would short the treasury vs the
        //    credited paymentAmount — payment tokens are governance-whitelisted
        //    via the parity key, so the standard-ERC20 (no fee-on-transfer)
        //    invariant is enforced socially at registration time (same caveat
        //    as CoinOffering).
        IERC20(paymentToken).safeTransferFrom(msg.sender, registryAddress, paymentAmount);

        // 2. Mint ATN to the buyer on the external Substrate contract. The vault
        //    holds no ATN inventory; Substrate is the sole supply authority and
        //    gates mintFromVault to this vault address.
        IAutonetATN(atnToken).mintFromVault(msg.sender, atnOut);

        emit AtnPurchased(msg.sender, paymentToken, paymentAmount, atnOut, parity);
    }

    // =========================================================================
    // PARITY / QUOTES
    // =========================================================================

    /**
     * @notice Read the registry-settled parity for a payment token (18-dec
     *         fixed-point multiplier into REP base units), or 0 if not whitelisted.
     */
    function getParity(address paymentToken) external view returns (uint256) {
        return _readParity(paymentToken);
    }

    /**
     * @notice Quote ATN output (base units, 1e6-scaled) for a given payment,
     *         without buying. Returns 0 for an unwhitelisted token or 0 input.
     */
    function quote(address paymentToken, uint256 paymentAmount)
        external
        view
        returns (uint256 atnOut)
    {
        uint256 parity = _readParity(paymentToken);
        if (parity == 0 || paymentAmount == 0) return 0;
        atnOut = (paymentAmount * parity) / (PARITY_ONE * REP_PER_ATN_BASE);
    }

    function _readParity(address paymentToken) internal view returns (uint256) {
        string memory key = string.concat(
            "jurisdiction.parity.",
            Strings.toHexString(uint160(paymentToken))
        );
        string memory parityStr = Registry(registryAddress).getRegistryValue(key);
        if (bytes(parityStr).length == 0) return 0;
        return Strings.parseUint(parityStr);
    }

    // =========================================================================
    // ADMIN (timelock-gated in production)
    // =========================================================================

    /**
     * @notice Transfer admin (e.g. hand control to the Timelock).
     */
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    /// @notice Pause buying.
    function pause() external onlyAdmin {
        _pause();
    }

    /// @notice Resume buying.
    function unpause() external onlyAdmin {
        _unpause();
    }
}
// AutonetVault.sol
