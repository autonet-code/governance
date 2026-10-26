// contracts/factories/DAOFactory.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../Dao.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

contract DAOFactory {
    address[] public deployedDAOs;
    event Deployed(address dao); // Event to capture the new DAO address

    function deployDAO(
        address tokenAddress,
        address timelockAddress,
        string memory name,
        uint[] memory daoSettings
    ) external returns (address) {
        require(daoSettings.length >= 4, "DAO settings requires 4 elements");
        uint48 minsDelay = uint48(daoSettings[0]);
        uint32 minsVoting = uint32(daoSettings[1]);
        uint256 pThreshold = daoSettings[2];
        uint8 qvrm = uint8(daoSettings[3]);
        
        HomebaseDAO dao = new HomebaseDAO(
            IVotes(tokenAddress),
            TimelockController(payable(timelockAddress)),
            name,
            minsDelay,
            minsVoting,
            pThreshold,
            qvrm,
            msg.sender
        );
        address daoAddress = address(dao);
        deployedDAOs.push(daoAddress);
        emit Deployed(daoAddress); // Emit the event
        return daoAddress;
    }
}
// contracts/factories/DAOFactory.sol