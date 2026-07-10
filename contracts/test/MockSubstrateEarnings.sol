// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Test double for the two autonet Substrate.sol earnings views the
///         AutonetRepClaim rail reads under the 2026-07-10 decision:
///         agentMintTotal (tool-pool distributions) and serviceEarnings (net
///         service revenue). Both are cumulative, monotonic, ATN base units
///         (ATN * 1e6). Test-only setters enforce monotonicity to mirror the real
///         Substrate.sol, where both counters only ever `+=`.
contract MockSubstrateEarnings {
    mapping(address => uint256) private _agentMintTotal;
    mapping(address => uint256) private _serviceEarnings;

    function setAgentMintTotal(address agent, uint256 value) external {
        require(value >= _agentMintTotal[agent], "MockSubstrateEarnings: mint total is monotonic");
        _agentMintTotal[agent] = value;
    }

    function setServiceEarnings(address agent, uint256 value) external {
        require(value >= _serviceEarnings[agent], "MockSubstrateEarnings: service earnings is monotonic");
        _serviceEarnings[agent] = value;
    }

    function agentMintTotal(address agent) external view returns (uint256) {
        return _agentMintTotal[agent];
    }

    function serviceEarnings(address agent) external view returns (uint256) {
        return _serviceEarnings[agent];
    }
}
