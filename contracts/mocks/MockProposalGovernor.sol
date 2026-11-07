// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

/// @notice Test only: a governor whose proposals' state, deadline and eta are set directly
contract MockProposalGovernor {
    struct P { uint8 state; uint256 deadline; uint256 eta; }
    mapping(uint256 => P) public proposals;

    function setProposal(uint256 id, uint8 state_, uint256 deadline, uint256 eta) external {
        proposals[id] = P(state_, deadline, eta);
    }

    function hashProposal(address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash)
        public pure returns (uint256)
    {
        return uint256(keccak256(abi.encode(targets, values, calldatas, descriptionHash)));
    }

    function state(uint256 id) external view returns (uint8) {
        require(proposals[id].deadline != 0, "Unknown proposal");
        return proposals[id].state;
    }

    function proposalDeadline(uint256 id) external view returns (uint256) { return proposals[id].deadline; }
    function proposalEta(uint256 id) external view returns (uint256) { return proposals[id].eta; }
}
