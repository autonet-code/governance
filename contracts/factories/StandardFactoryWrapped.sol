// contracts/factories/StandardFactoryWrapped.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./InfrastructureFactory.sol";
import "./DAOFactory.sol";
import "./WrappedRepTokenFactory.sol";
import "../Registry.sol";
import "../WrappedRepToken.sol";
import "../Dao.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title StandardFactoryWrapped
 * @notice Deploys DAOs with wrapped ERC20 governance tokens
 * @dev Similar to StandardFactory but wraps an existing ERC20 token
 */
contract StandardFactoryWrapped {
    InfrastructureFactory public immutable infrastructureFactory;
    DAOFactory public immutable daoFactory;
    WrappedRepTokenFactory public immutable wrappedRepTokenFactory;

    address[] public deployedDAOs;
    address[] public deployedTokens;
    address[] public deployedTimelocks;
    address[] public deployedRegistries;

    /**
     * @notice Event emitted when a wrapped token DAO is created
     * @dev Indexer uses this to detect new wrapped DAOs
     */
    event DaoWrappedDeploymentInfo(
        address indexed daoAddress,
        address indexed wrappedTokenAddress,
        address indexed underlyingTokenAddress,
        address registryAddress,
        string daoName,
        string wrappedTokenSymbol,
        string description,
        uint8 quorumFraction,
        uint256 executionDelay,
        uint48 votingDelay,
        uint32 votingPeriod,
        uint256 proposalThreshold
    );

    /**
     * @notice Parameters for deploying a wrapped token DAO
     */
    struct DaoParamsWrapped {
        string name;
        string symbol;
        string description;
        uint256 executionDelay;
        address underlyingTokenAddress;
        uint256[] governanceSettings; // [votingDelay, votingPeriod, proposalThreshold, quorumFraction]
        string[] keys;
        string[] values;
        string transferrableStr;
    }

    constructor(
        address _infrastructureFactory,
        address _daoFactory,
        address _wrappedRepTokenFactory
    ) {
        infrastructureFactory = InfrastructureFactory(_infrastructureFactory);
        daoFactory = DAOFactory(_daoFactory);
        wrappedRepTokenFactory = WrappedRepTokenFactory(_wrappedRepTokenFactory);
    }

    function getNumberOfDAOs() public view returns (uint) {
        return deployedDAOs.length;
    }

    /**
     * @notice Deploys a complete wrapped token DAO in a single transaction
     * @param params DAO configuration parameters
     */
    function deployDAOwithWrappedToken(DaoParamsWrapped memory params) public payable {
        require(
            params.governanceSettings.length == 4,
            "StandardFactoryWrapped: governanceSettings must have 4 elements"
        );
        require(
            params.underlyingTokenAddress != address(0),
            "StandardFactoryWrapped: Underlying token cannot be zero address"
        );

        // Extract governance params
        uint48 votingDelay = uint48(params.governanceSettings[0]);
        uint32 votingPeriod = uint32(params.governanceSettings[1]);
        uint256 proposalThreshold = params.governanceSettings[2];
        uint8 quorumFraction = uint8(params.governanceSettings[3]);

        // Convert string "true"/"false" to boolean
        bool transferrable = keccak256(bytes(params.transferrableStr)) == keccak256(bytes("true"));

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

        // 3. Deploy WrappedRepToken (governance token)
        address tokenAddr = wrappedRepTokenFactory.deployWrappedRepToken(
            IERC20(params.underlyingTokenAddress),
            params.name,
            params.symbol,
            transferrable
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
        // Convert votingDelay and votingPeriod from minutes to seconds for indexer consistency
        emit DaoWrappedDeploymentInfo(
            daoAddr,
            tokenAddr,
            params.underlyingTokenAddress,
            registryAddr,
            params.name,
            params.symbol,
            params.description,
            quorumFraction,
            params.executionDelay,
            uint48(votingDelay * 60),
            uint32(votingPeriod * 60),
            proposalThreshold
        );
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
        WrappedRepToken wrappedRepToken = WrappedRepToken(token);
        Registry registryContract = Registry(registry);
        TimelockController timelockController = TimelockController(payable(timelock));

        // Transfer token admin to timelock
        wrappedRepToken.setAdmin(timelock);

        // Transfer registry ownership to timelock
        registryContract.transferOwnership(timelock);

        // Grant roles to DAO
        timelockController.grantRole(timelockController.PROPOSER_ROLE(), dao);
        timelockController.grantRole(timelockController.CANCELLER_ROLE(), dao);
        timelockController.grantRole(timelockController.EXECUTOR_ROLE(), address(0)); // Anyone can execute

        // Revoke factory's admin role
        timelockController.revokeRole(timelockController.DEFAULT_ADMIN_ROLE(), address(this));

        // Set initial registry values if provided
        if (keys.length > 0) {
            require(keys.length == values.length, "StandardFactoryWrapped: Keys and values length mismatch");
            registryContract.batchEditRegistry(keys, values);
        }
    }
}
