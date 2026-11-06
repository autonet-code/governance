// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IJurisdictionData Interface
 * @dev Defines read-only functions required by other contracts to query epoch data from the Jurisdiction contract.
 */
interface IJurisdictionData {
    /**
     * @dev Returns the start timestamp of a specific reward epoch.
     * @param epochId The ID of the epoch to query.
     * @return The unix timestamp (as uint48) when the epoch started.
     */
    function getRewardEpochStart(uint256 epochId) external view returns (uint48);

    /**
     * @dev Returns when claims open for an epoch: its start, or the end of a delegate pool's sign-up.
     * @param epochId The ID of the epoch to query.
     * @return The unix timestamp (as uint48) when claims open.
     */
    function getRewardClaimsOpen(uint256 epochId) external view returns (uint48);
}
// IJurisdictionData.sol