// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

interface IEconomy {
    function updateEarnings(address user, uint amount, address tokenAddress) external;
    function updateSpendings(address user, uint amount, address tokenAddress) external;
    function registerBacker(address backer) external;
    function registerProjectRoles(address projectAddress, address author, address contractor, address arbiter) external;

    // NEW: Exposes the NATIVE_CURRENCY constant from Economy.sol via a getter.
    function NATIVE_CURRENCY() external view returns (address);
}
// IEconomy.sol