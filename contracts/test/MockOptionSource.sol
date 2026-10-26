// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../IOptionSource.sol";

interface IWinningOption {
    function winningOption(uint256 proposalId) external view returns (bool decided, uint256 index);
}

contract MockOptionSource is IOptionSource {
    mapping(uint256 => bytes32[]) private _options;
    uint256 public pending;
    uint256 public executedIndex = type(uint256).max;

    function setOptions(uint256 proposalId, bytes32[] calldata hashes) external {
        _options[proposalId] = hashes;
        pending = proposalId;
    }

    function optionCount(uint256 proposalId) external view returns (uint256) { return _options[proposalId].length; }

    function optionHash(uint256 proposalId, uint256 index) external view returns (bytes32) { return _options[proposalId][index]; }

    function settle() external {
        (bool decided, uint256 index) = IWinningOption(governor).winningOption(pending);
        require(decided, "undecided");
        executedIndex = index;
    }

    address public governor;
    function setGovernor(address g) external { governor = g; }
}
