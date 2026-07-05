// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Test double for the two autonet Substrate.sol views the
///         ReputationMirror reads: agentReputation (soulbound, monotonic) and
///         getAgentOwner (owner-binding). Test-only setters let a suite drive
///         reputation up (monotonic — enforced) and set/unset owners.
contract MockSubstrate {
    mapping(address => uint256) private _reputation;
    mapping(address => address) private _owner;

    /// @notice Set (increase) an agent's reputation. Enforces monotonicity to
    ///         mirror the real Substrate.sol, where agentMintTotal only ever
    ///         increases (recordTrainingForEpoch: `agentMintTotal += amount`).
    function setReputation(address agent, uint256 value) external {
        require(value >= _reputation[agent], "MockSubstrate: reputation is monotonic");
        _reputation[agent] = value;
    }

    /// @notice Bind (or unbind, with address(0)) an agent's owner wallet.
    function setOwner(address agent, address owner) external {
        _owner[agent] = owner;
    }

    function agentReputation(address agent) external view returns (uint256) {
        return _reputation[agent];
    }

    function getAgentOwner(address agent) external view returns (address) {
        return _owner[agent];
    }
}
