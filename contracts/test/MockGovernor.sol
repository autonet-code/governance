// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import "../IGovernor.sol";

// A mock Governor for testing the appeal mechanism. Every proposal shares one settable state.
contract MockGovernor is IGovernor {
    ProposalState public proposalState;
    uint256 public deadline;
    uint256 public eta;

    // Test-only function to set the state of a proposal
    function setProposalState(ProposalState _newState) external {
        proposalState = _newState;
    }

    function setTimes(uint256 _deadline, uint256 _eta) external {
        deadline = _deadline;
        eta = _eta;
    }

    function state(uint256 proposalId) external view override returns (ProposalState) {
        proposalId; // silence warning
        return proposalState;
    }

    function hashProposal(address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash)
        external pure override returns (uint256)
    {
        return uint256(keccak256(abi.encode(targets, values, calldatas, descriptionHash)));
    }

    function proposalDeadline(uint256) external view override returns (uint256) {
        return deadline;
    }

    function proposalEta(uint256) external view override returns (uint256) {
        return eta;
    }
}
// MockGovernor.sol
