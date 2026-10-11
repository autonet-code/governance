// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./InfrastructureFactory.sol";
import "./DAOFactory.sol";
import "./EconomyFactory.sol";
import "./RepTokenFactory.sol";
import "../Economy.sol";
import "../Dao.sol";
import "../Registry.sol";
import "../RepToken.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

contract TrustlessFactory {
    struct TokenParams {
        string name;
        string symbol;
        address[] initialMembers;
        uint256[] initialAmounts;
    }

    struct GovParams {
        string name;
        uint48 timelockDelay;
        uint32 votingPeriod;
        uint256 proposalThreshold;
        uint8 quorumFraction;
    }

    // NEW STRUCT for cleaner parameter passing
    struct AddressParams {
        address[2] implAddresses;     // [native, erc20]
        address[5] contractAddresses; // [economy, registry, timelock, repToken, dao]
    }

    // RENAMED STRUCT for clarity
    struct EconomyParams {
        uint arbitrationFeeBps;
        uint initialPlatformFeeBps;
        uint initialAuthorFeeBps;
        uint initialCoolingOffPeriod;
        uint initialBackersQuorumBps;
        uint initialProjectThreshold;
        uint initialAppealPeriod;
    }


    InfrastructureFactory public immutable infrastructureFactory;
    DAOFactory public immutable daoFactory;
    EconomyFactory public immutable economyFactory;
    RepTokenFactory public immutable repTokenFactory;

    // A suite is deployed over three transactions. Each in-progress deployment is bound to the
    // caller that started it, so nobody else can finalize it with their own governor.
    struct DeploymentData {
        address economy;
        address registry;
        address timelock;
        address repToken;
        address dao;
        TokenParams tokenParams;
        GovParams govParams;
        uint256 timelockDelay;
    }
    mapping(address => DeploymentData) private pendingDeployments;

    event InfrastructureDeployed(address economy, address registry, address timelock);
    event DAOTokenDeployed(address repToken, address dao);
    event SuiteConfigured(
        address deployer,
        address indexed economy,
        address registry,
        address timelock,
        address indexed repToken,
        address indexed dao
    );
    // Event for indexer compatibility
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

    constructor(address _infraFactory, address _daoFactory, address _economyFactory, address _repTokenFactory) {
        infrastructureFactory = InfrastructureFactory(_infraFactory);
        daoFactory = DAOFactory(_daoFactory);
        economyFactory = EconomyFactory(_economyFactory);
        repTokenFactory = RepTokenFactory(_repTokenFactory);
    }

    function deployInfrastructure(uint48 timelockDelayInMinutes, uint arbitrationFeeBps) external {
        address economyAddr = economyFactory.deployEconomy(arbitrationFeeBps);
        address timelockAddr = infrastructureFactory.deployTimelock(address(this), timelockDelayInMinutes * 1 minutes);
        address registryAddr = infrastructureFactory.deployRegistry(address(this), address(0));

        delete pendingDeployments[msg.sender];
        DeploymentData storage d = pendingDeployments[msg.sender];
        d.economy = economyAddr;
        d.registry = registryAddr;
        d.timelock = timelockAddr;
        d.timelockDelay = timelockDelayInMinutes * 1 minutes;

        emit InfrastructureDeployed(economyAddr, registryAddr, timelockAddr);
    }

    function deployDAOToken(
        address registryAddr,
        address timelockAddr,
        TokenParams calldata _tokenParams,
        GovParams calldata _govParams
    ) external {
        DeploymentData storage d = pendingDeployments[msg.sender];
        require(d.registry != address(0) && d.repToken == address(0), "No infrastructure pending for caller");
        require(registryAddr == d.registry && timelockAddr == d.timelock, "Not the caller's infrastructure");
        d.tokenParams = _tokenParams;
        d.govParams = _govParams;

        address repTokenAddr = repTokenFactory.deployRepToken(
            _tokenParams.name, _tokenParams.symbol, payable(registryAddr), timelockAddr,
            _tokenParams.initialMembers, _tokenParams.initialAmounts,
            false // Economy DAO tokens are always non-transferrable
        );

        uint[] memory daoSettings = new uint[](4);
        daoSettings[0] = _govParams.timelockDelay;
        daoSettings[1] = _govParams.votingPeriod;
        daoSettings[2] = _govParams.proposalThreshold;
        daoSettings[3] = _govParams.quorumFraction;
        address daoAddr = daoFactory.deployDAO(repTokenAddr, timelockAddr, _govParams.name, daoSettings);
        d.repToken = repTokenAddr;
        d.dao = daoAddr;
        emit DAOTokenDeployed(repTokenAddr, daoAddr);
    }

    // REFACTORED FUNCTION SIGNATURE
    function configureAndFinalize(
        AddressParams calldata _addressParams,
        EconomyParams calldata _economyParams,
        string[] calldata _registryKeys,
        string[] calldata _registryValues
    ) external {
        require(_registryKeys.length == _registryValues.length, "Registry keys/values length mismatch");

        address economyAddr = _addressParams.contractAddresses[0];
        address registryAddr = _addressParams.contractAddresses[1];
        address timelockAddr = _addressParams.contractAddresses[2];
        address repTokenAddr = _addressParams.contractAddresses[3];
        address daoAddr = _addressParams.contractAddresses[4];

        _checkPending(_addressParams.contractAddresses);

        Economy economy = Economy(payable(economyAddr));
        Registry registry = Registry(payable(registryAddr));
        RepToken repToken = RepToken(repTokenAddr);
        TimelockController timelock = TimelockController(payable(timelockAddr));

        economy.setImplementations(_addressParams.implAddresses[0], _addressParams.implAddresses[1]);
        economy.setPlatformFee(_economyParams.initialPlatformFeeBps);
        economy.setAuthorFee(_economyParams.initialAuthorFeeBps);
        economy.setCoolingOffPeriod(_economyParams.initialCoolingOffPeriod);
        economy.setBackersVoteQuorum(_economyParams.initialBackersQuorumBps);
        economy.setProjectThreshold(_economyParams.initialProjectThreshold);
        economy.setAppealPeriod(_economyParams.initialAppealPeriod);

        repToken.setEconomyAddress(economyAddr);
        registry.setJurisdictionAddress(repTokenAddr);

        // Initialize registry with provided key-value pairs
        if (_registryKeys.length > 0) {
            registry.batchEditRegistry(_registryKeys, _registryValues);
        }

        economy.setDaoAddresses(timelockAddr, registryAddr, daoAddr, repTokenAddr);
        repToken.setAdmin(timelockAddr);
        registry.transferOwnership(timelockAddr);

        bytes32 proposerRole = timelock.PROPOSER_ROLE();
        bytes32 executorRole = timelock.EXECUTOR_ROLE();
        bytes32 adminRole = timelock.DEFAULT_ADMIN_ROLE();
        timelock.grantRole(proposerRole, daoAddr);
        timelock.grantRole(executorRole, address(0));
        timelock.revokeRole(adminRole, address(this));

        emit SuiteConfigured(msg.sender, economyAddr, registryAddr, timelockAddr, repTokenAddr, daoAddr);

        _emitNewDaoCreated(daoAddr, repTokenAddr, registryAddr, _registryKeys, _registryValues);
        delete pendingDeployments[msg.sender];
    }

    function _checkPending(address[5] calldata addrs) private view {
        DeploymentData storage d = pendingDeployments[msg.sender];
        require(d.dao != address(0), "No deployment pending for caller");
        require(
            addrs[0] == d.economy && addrs[1] == d.registry && addrs[2] == d.timelock &&
            addrs[3] == d.repToken && addrs[4] == d.dao,
            "Addresses do not match caller's deployment"
        );
    }

    // Emitted for indexer compatibility
    function _emitNewDaoCreated(
        address daoAddr,
        address repTokenAddr,
        address registryAddr,
        string[] calldata _registryKeys,
        string[] calldata _registryValues
    ) private {
        DeploymentData storage d = pendingDeployments[msg.sender];
        emit NewDaoCreated(
            daoAddr,
            repTokenAddr,
            d.tokenParams.initialMembers,
            d.tokenParams.initialAmounts,
            d.tokenParams.name,
            d.tokenParams.symbol,
            "Economy DAO", // Description for economy DAOs
            d.timelockDelay,
            registryAddr,
            _registryKeys,
            _registryValues
        );
    }
}
// TrustlessFactory.solasdas