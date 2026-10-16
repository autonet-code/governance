// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IGovernor Interface
 * @dev Defines the functions and enums required to interact with a standard
 * OpenZeppelin Governor contract, specifically to check the state of a proposal.
 */
interface IGovernor {
    /**
     * @dev Enum representing the state of a governance proposal.
     */
    enum ProposalState {
        Pending,
        Active,
        Canceled,
        Defeated,
        Succeeded,
        Queued,
        Expired,
        Executed
    }

    /**
     * @dev Returns the state of a given proposal.
     * @param proposalId The ID of the proposal to check.
     * @return The state of the proposal as a ProposalState enum member.
     */
    function state(uint256 proposalId) external view returns (ProposalState);

    function hashProposal(address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash)
        external pure returns (uint256);
    function proposalDeadline(uint256 proposalId) external view returns (uint256);
    function proposalEta(uint256 proposalId) external view returns (uint256);
}
// IGovernor.sol