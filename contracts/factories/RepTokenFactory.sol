// contracts/factories/RepTokenFactory.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../RepToken.sol";

contract RepTokenFactory {
    address[] public deployedRepTokens;
    event Deployed(address repToken);

    function deployRepToken(
        string memory name,
        string memory symbol,
        address payable registryAddress,
        address timelockAddress,
        address[] memory initialMembers,
        uint256[] memory initialAmounts
    ) external returns (address) {
        require(initialMembers.length == initialAmounts.length, "RepTokenFactory: member and amount arrays must have the same length");

        RepToken repToken = new RepToken(name, symbol, registryAddress, timelockAddress, initialMembers, initialAmounts);
        
        // As the initial admin, transfer adminship to the main factory that called this function
        repToken.setAdmin(msg.sender);
        
        address repTokenAddr = address(repToken);
        deployedRepTokens.push(repTokenAddr);
        emit Deployed(repTokenAddr);
        return repTokenAddr;
    }
}
// RepTokenFactory.sol