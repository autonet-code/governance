// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

// This interface defines the getters for DAO-governed parameters
// that Project contracts need to read from the main Economy contract.
interface IGovernedEconomy {
    function coolingOffPeriod() external view returns (uint);
    function arbitrationFeeBps() external view returns (uint);
    function platformFeeBps() external view returns (uint);
    function authorFeeBps() external view returns (uint);
    function backersVoteQuorumBps() external view returns (uint);
    function appealPeriod() external view returns (uint);
    function arbitrationTimeout() external view returns (uint);
    function governorAddress() external view returns (address);
    function repTokenAddress() external view returns (address);
    function projectThreshold() external view returns (uint);
    function maxImmediateBps() external view returns (uint);
    function registryAddress() external view returns (address);
}
// IGovernedEconomy.sol