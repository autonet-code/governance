// contracts/factories/StandardFactoryNonTransferable.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./InfrastructureFactory.sol";
import "./DAOFactory.sol";
import "./RepTokenFactory.sol";
import "../Registry.sol";
import "../RepToken.sol";
import "../Dao.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title StandardFactoryNonTransferable
 * @notice Deploys standard DAOs with NON-TRANSFERABLE tokens (always)
 * @dev No transferability parameter - tokens are ALWAYS non-transferable
 */
contract StandardFactoryNonTransferable {
    InfrastructureFactory public immutable infrastructureFactory;
    DAOFactory public immutable daoFactory;
    RepTokenFactory public immutable repTokenFactory;

    address[] public deployedDAOs;
    address[] public deployedTokens;
    address[] public deployedTimelocks;
    address[] public deployedRegistries;

    event NewDaoCreated(
        address indexed dao,
        address token,
        address[] initialMembers,
        uint256[] initialAmounts,
        string name,
        string symbol,
        string description,
        uint256 executionDelay,
        address registry,
        string[] keys,
        string[] values
    );

    struct DaoParams {
        string name;
        string symbol;
        string description;
        uint8 decimals;
        uint256 executionDelay;
        address[] initialMembers;
        uint256[] initialAmounts;
        string[] keys;
        string[] values;
    }

    constructor(
        address _infrastructureFactory,
        address _daoFactory,
        address _repTokenFactory
    ) {
        infrastructureFactory = InfrastructureFactory(_infrastructureFactory);
        daoFactory = DAOFactory(_daoFactory);
        repTokenFactory = RepTokenFactory(_repTokenFactory);
    }

    function getNumberOfDAOs() public view returns (uint) {
        return deployedDAOs.length;
    }

    /**
     * @notice Deploys a DAO with NON-TRANSFERABLE tokens
     * @param params DAO configuration parameters
     * @dev Governance params appended to end of initialAmounts array
     */
    function deployDAOwithToken(DaoParams memory params) public payable {
        require(
            params.initialAmounts.length >= params.initialMembers.length + 4,
            "StandardFactory: Insufficient settings in initialAmounts"
        );
        require(
            params.initialMembers.length > 0,
            "StandardFactory: At least one initial member required"
        );

        // Extract governance params from end of initialAmounts array
        uint48 votingDelay = uint48(params.initialAmounts[params.initialAmounts.length - 4]);
        uint32 votingPeriod = uint32(params.initialAmounts[params.initialAmounts.length - 3]);
        uint256 proposalThreshold = params.initialAmounts[params.initialAmounts.length - 2];
        uint8 quorumFraction = uint8(params.initialAmounts[params.initialAmounts.length - 1]);

        // Extract token amounts (without governance params)
        uint256 membersCount = params.initialMembers.length;
        uint256[] memory tokenAmounts = new uint256[](membersCount);
        for (uint i = 0; i < membersCount; i++) {
            tokenAmounts[i] = params.initialAmounts[i];
        }

        // 1. Deploy timelock (with this factory as temporary admin)
        address timelockAddr = infrastructureFactory.deployTimelock(
            address(this),
            params.executionDelay
        );

        // 2. Deploy registry (with this factory as temporary owner)
        address registryAddr = infrastructureFactory.deployRegistry(
            address(this),
            address(this)
        );

        // 3. Deploy NON-TRANSFERABLE RepToken
        address tokenAddr = repTokenFactory.deployRepToken(
            params.name,
            params.symbol,
            payable(registryAddr),
            timelockAddr, // Governs reward epochs and minters
            params.initialMembers,
            tokenAmounts,
            false  // ALWAYS NON-TRANSFERABLE
        );

        // 4. Deploy DAO
        uint[] memory daoSettings = new uint[](4);
        daoSettings[0] = votingDelay;
        daoSettings[1] = votingPeriod;
        daoSettings[2] = proposalThreshold;
        daoSettings[3] = quorumFraction;

        address daoAddr = daoFactory.deployDAO(
            tokenAddr,
            timelockAddr,
            params.name,
            daoSettings
        );

        // 5. Finalize setup and transfer ownership
        _finalizeDeployment(
            daoAddr,
            tokenAddr,
            timelockAddr,
            payable(registryAddr),
            params.keys,
            params.values
        );

        // 6. Emit event for indexer
        emit NewDaoCreated(
            daoAddr,
            tokenAddr,
            params.initialMembers,
            params.initialAmounts,
            params.name,
            params.symbol,
            params.description,
            params.executionDelay,
            registryAddr,
            params.keys,
            params.values
        );
    }

    /**
     * @notice Individual parameters version for backwards compatibility
     */
    function deployDAOwithToken(
        string memory name,
        string memory symbol,
        string memory description,
        uint8 decimals,
        uint256 executionDelay,
        address[] memory initialMembers,
        uint256[] memory initialAmounts,
        string[] memory keys,
        string[] memory values
    ) public payable {
        DaoParams memory params = DaoParams({
            name: name,
            symbol: symbol,
            description: description,
            decimals: decimals,
            executionDelay: executionDelay,
            initialMembers: initialMembers,
            initialAmounts: initialAmounts,
            keys: keys,
            values: values
        });
        deployDAOwithToken(params);
    }

    function _finalizeDeployment(
        address dao,
        address token,
        address timelock,
        address payable registry,
        string[] memory keys,
        string[] memory values
    ) internal {
        // Store deployed addresses
        deployedDAOs.push(dao);
        deployedTokens.push(token);
        deployedTimelocks.push(timelock);
        deployedRegistries.push(registry);

        // Set up contracts
        RepToken repToken = RepToken(token);
        Registry registryContract = Registry(registry);
        TimelockController timelockController = TimelockController(payable(timelock));

        // Set registry's jurisdiction address
        registryContract.setJurisdictionAddress(token);

        // Transfer token admin to timelock
        repToken.setAdmin(timelock);

        // Transfer registry ownership to timelock
        registryContract.transferOwnership(timelock);

        // Grant roles to DAO
        timelockController.grantRole(timelockController.PROPOSER_ROLE(), dao);
        timelockController.grantRole(timelockController.EXECUTOR_ROLE(), address(0)); // Anyone can execute

        // Revoke factory's admin role
        timelockController.revokeRole(timelockController.DEFAULT_ADMIN_ROLE(), address(this));

        // Set initial registry values if provided
        if (keys.length > 0) {
            require(keys.length == values.length, "StandardFactory: Keys and values length mismatch");
            registryContract.batchEditRegistry(keys, values);
        }
    }
}
