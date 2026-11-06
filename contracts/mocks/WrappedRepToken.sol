// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {ERC20Wrapper} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Wrapper.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {IAdminToken} from "../IAdminToken.sol";

/**
 * Test only: jurisdictions have one kind of token, the non-transferable RepToken. Etherlink still has
 * DAOs on this token (homebase-app shows them and the indexer follows them), so the indexer e2e uses it.
 *
 * @title WrappedRepToken
 * @notice Governance token that wraps an underlying ERC20 token
 * @dev Combines ERC20Wrapper for wrapping with ERC20Votes for governance
 */
contract WrappedRepToken is ERC20, ERC20Permit, ERC20Votes, ERC20Wrapper, IAdminToken {
    address public admin;
    bool public immutable isTransferable;

    /**
     * @param underlyingToken The ERC20 token to wrap
     * @param name Token name (typically matches DAO name)
     * @param symbol Token symbol
     * @param _isTransferable Whether the wrapped token can be transferred
     */
    constructor(
        IERC20 underlyingToken,
        string memory name,
        string memory symbol,
        bool _isTransferable
    )
        ERC20(name, symbol)
        ERC20Permit(name)
        ERC20Wrapper(underlyingToken)
    {
        admin = msg.sender;
        isTransferable = _isTransferable;
    }

    /**
     * @notice Returns the clock mode for ERC6372 (timestamp-based)
     */
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    /**
     * @notice Returns the current timepoint (block.timestamp)
     */
    function clock() public view virtual override returns (uint48) {
        return uint48(block.timestamp);
    }

    /**
     * @notice Returns the number of decimals for the token
     * @dev Inherits from underlying token via ERC20Wrapper
     */
    function decimals() public view override(ERC20, ERC20Wrapper) returns (uint8) {
        return super.decimals();
    }

    /**
     * @notice Internal function to update balances and voting power
     * @dev Overrides both ERC20 and ERC20Votes _update
     */
    function _update(address from, address to, uint256 amount)
        internal
        override(ERC20, ERC20Votes)
    {
        super._update(from, to, amount);
    }

    /**
     * @notice Returns the nonce for an address (used for permits)
     * @dev Overrides both ERC20Permit and Nonces
     */
    function nonces(address owner)
        public
        view
        virtual
        override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(owner);
    }

    /**
     * @notice Sets the admin address (can only be called by current admin)
     * @param newAdmin The new admin address
     */
    function setAdmin(address newAdmin) public override {
        require(msg.sender == admin, "WrappedRepToken: Caller is not the admin");
        require(newAdmin != address(0), "WrappedRepToken: New admin cannot be zero address");
        admin = newAdmin;
    }

    /**
     * @notice Transfers tokens (blocked if non-transferable)
     */
    function transfer(address to, uint256 value) public override returns (bool) {
        if (!isTransferable) {
            revert("WrappedRepToken: Token is non-transferable");
        }
        return super.transfer(to, value);
    }

    /**
     * @notice Transfers tokens from an address (blocked if non-transferable)
     */
    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (!isTransferable) {
            revert("WrappedRepToken: Token is non-transferable");
        }
        return super.transferFrom(from, to, value);
    }
}
