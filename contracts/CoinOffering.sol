// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Registry} from "./Registry.sol";

/**
 * @title CoinOffering ("CO")
 * @notice Continuous, launch-independent offering for the network governance
 *         token (ATNB, a transferable RepToken / ERC20Votes).
 *
 * THE BOATS MODEL
 * ---------------
 * The DAO mints ATNB directly to this contract via Timelock proposals. The CO
 * sells that inventory to the public for registry-accepted payment tokens
 * (USDC, etc.) at the registry-settled parity. It is a ROUTER, not a custodian:
 *
 *   - inbound payment tokens are pulled straight into the DAO treasury
 *     (Registry) in the same call — the CO never holds cash;
 *   - ATNB is delivered to the buyer from CO inventory, granting governance
 *     power immediately (ATNB is the governance token).
 *
 * AUTO-DELEGATION (handled by the token, not the CO)
 * --------------------------------------------------
 * Buyers' voting power is auto-delegated to the execution team by RepToken's
 * `defaultDelegate` feature: when an account receives ATNB while holding no
 * delegate of its own, the token delegates it to the configured default on
 * first receipt. The CO therefore does NOT touch delegation — no buyer
 * signature, no `delegateBySig`, no mempool front-run/DoS surface. Buyers can
 * later visit werule.io to reclaim and self-delegate; once they do, the token
 * never auto-resets them. The execution delegate is configured on the token
 * (RepToken.setDefaultDelegate), via governance, not here.
 *
 * PARITY (single suite-wide convention)
 * -------------------------------------
 * Price is NOT set here. The CO reads the registry key
 *   "jurisdiction.parity.<lowercaseTokenHex>"
 * the SAME key and convention RepToken uses for reputation conversion: an
 * 18-decimal fixed-point multiplier where 1e18 == 1:1. The registry value
 * bakes in any decimal adjustment between the payment token and ATNB (both
 * sides use the identical formula, so the two contracts can never disagree):
 *
 *   atnbOut = paymentAmount * parity / 1e18
 *
 * e.g. for 6-decimal USDC priced 1 USDC -> 1 ATNB (18 dec), governance sets
 * parity = 1e18 * 1e12 = 1e30, so 1e6 (1 USDC) * 1e30 / 1e18 = 1e18 (1 ATNB).
 *
 * DESTRUCTIVE POWERS
 * ------------------
 * Admin is expected to be the Timelock. Inventory recovery and admin changes
 * are admin-gated so they lean on the timelock delay. Buying itself is
 * permissionless and only pausable.
 */
contract CoinOffering is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // =========================================================================
    // CONSTANTS, IMMUTABLES & STATE
    // =========================================================================

    /// @notice Parity fixed-point scale. parity == PARITY_ONE means 1:1.
    uint256 internal constant PARITY_ONE = 1e18;

    /// @notice The ATNB governance token being sold (a transferable RepToken / ERC20Votes).
    address public immutable atnbToken;

    /// @notice The DAO treasury. Inbound payment tokens are routed here directly.
    address payable public immutable registryAddress;

    /// @notice Admin (expected: the Timelock). Holds configuration & recovery powers.
    address public admin;

    /// @notice Total ATNB base units sold across the lifetime of the offering.
    uint256 public totalSold;

    /// @notice Total payment routed to the treasury, per payment token.
    mapping(address => uint256) public totalRaised;

    // =========================================================================
    // EVENTS
    // =========================================================================

    event TokensPurchased(
        address indexed buyer,
        address indexed paymentToken,
        uint256 paymentAmount,
        uint256 atnbOut,
        uint256 parity
    );
    event AdminTransferred(address indexed previous, address indexed current);
    event InventoryRecovered(address indexed to, uint256 amount);

    // =========================================================================
    // ERRORS
    // =========================================================================

    error ZeroAddress();
    error InvalidAmount();
    error TokenNotRegistered(address token);
    error InsufficientInventory(uint256 requested, uint256 available);
    error NotAdmin();
    error DustAmount(); // payment too small to yield any ATNB at current parity

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

    constructor(
        address _atnbToken,
        address payable _registryAddress,
        address _admin
    ) {
        if (
            _atnbToken == address(0) ||
            _registryAddress == address(0) ||
            _admin == address(0)
        ) revert ZeroAddress();

        atnbToken = _atnbToken;
        registryAddress = _registryAddress;
        admin = _admin;
    }

    // =========================================================================
    // BUY
    // =========================================================================

    /**
     * @notice Buy ATNB with a registry-accepted payment token at registry parity.
     *         Payment is routed straight to the treasury; ATNB is delivered from
     *         CO inventory. The buyer's votes are auto-delegated to the execution
     *         team by the token itself (RepToken.defaultDelegate) on receipt —
     *         the CO does not handle delegation. Buyers can self-delegate later
     *         at werule.io.
     * @param paymentToken The ERC20 used to pay (must have a registry parity).
     * @param paymentAmount Amount of paymentToken to spend (base units).
     * @return atnbOut Amount of ATNB delivered (base units).
     */
    function buy(address paymentToken, uint256 paymentAmount)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 atnbOut)
    {
        if (paymentAmount == 0) revert InvalidAmount();

        uint256 parity = _readParity(paymentToken);
        if (parity == 0) revert TokenNotRegistered(paymentToken);

        atnbOut = (paymentAmount * parity) / PARITY_ONE;
        if (atnbOut == 0) revert DustAmount();

        uint256 available = IERC20(atnbToken).balanceOf(address(this));
        if (atnbOut > available) revert InsufficientInventory(atnbOut, available);

        // Effects
        totalSold += atnbOut;
        totalRaised[paymentToken] += paymentAmount;

        // Interactions ---------------------------------------------------------

        // 1. Route payment straight to the DAO treasury (CO never custodies cash).
        //    SafeERC20 handles non-standard (no-bool) tokens. Note: a
        //    fee-on-transfer payment token would short the treasury vs the
        //    credited paymentAmount — payment tokens are governance-whitelisted
        //    via the parity key, so the standard-ERC20 (no fee-on-transfer)
        //    invariant is enforced socially at registration time.
        IERC20(paymentToken).safeTransferFrom(msg.sender, registryAddress, paymentAmount);

        // 2. Deliver ATNB from inventory to the buyer (grants governance; the
        //    token auto-delegates to the default delegate on this receipt).
        IERC20(atnbToken).safeTransfer(msg.sender, atnbOut);

        emit TokensPurchased(msg.sender, paymentToken, paymentAmount, atnbOut, parity);
    }

    // =========================================================================
    // PARITY / QUOTES
    // =========================================================================

    /**
     * @notice Read the registry-settled parity for a payment token (18-dec
     *         fixed-point multiplier; 1e18 == 1:1), or 0 if not registered.
     */
    function getParity(address paymentToken) external view returns (uint256) {
        return _readParity(paymentToken);
    }

    /**
     * @notice Quote ATNB output for a given payment, without buying.
     */
    function quote(address paymentToken, uint256 paymentAmount)
        external
        view
        returns (uint256 atnbOut)
    {
        uint256 parity = _readParity(paymentToken);
        if (parity == 0 || paymentAmount == 0) return 0;
        atnbOut = (paymentAmount * parity) / PARITY_ONE;
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

    /// @notice Current ATNB inventory held by the offering.
    function inventory() external view returns (uint256) {
        return IERC20(atnbToken).balanceOf(address(this));
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

    /**
     * @notice Recover unsold ATNB inventory (e.g. to return it to the treasury).
     * @dev Admin-gated so it leans on the timelock delay.
     */
    function recoverInventory(address to, uint256 amount) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        IERC20(atnbToken).safeTransfer(to, amount);
        emit InventoryRecovered(to, amount);
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
// CoinOffering.sol
