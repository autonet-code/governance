// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// A contract whose proposals are single-choice elections. Options are registered while the
/// proposal is Pending and must not change once voting starts.
interface IOptionSource {
    function optionCount(uint256 proposalId) external view returns (uint256);
    function optionHash(uint256 proposalId, uint256 index) external view returns (bytes32);
}
