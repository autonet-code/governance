// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// Test only. Jurisdictions have one kind of token, the non-transferable RepToken, but Etherlink still
/// has DAOs on transferable tokens (homebase-app shows them and the indexer follows them), so the
/// indexer e2e uses this in their place.
contract TransferableToken is ERC20, ERC20Permit, ERC20Votes {
    constructor(string memory name, string memory symbol, address[] memory members, uint256[] memory amounts)
        ERC20(name, symbol)
        ERC20Permit(name)
    {
        for (uint256 i = 0; i < members.length; i++) _mint(members[i], amounts[i]);
    }

    function isTransferable() external pure returns (bool) {
        return true;
    }

    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }
}
