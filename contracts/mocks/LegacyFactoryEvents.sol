// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test only. Emits the events the retired StandardFactory contracts emitted (wrapper, wrapper_t:
/// NewDaoCreated; wrapper_w: DaoWrappedDeploymentInfo), for a core deployed elsewhere. Production
/// networks still have DAOs from those factories and the indexer still follows them; their sources
/// no longer compile against today's core contracts, so the indexer e2e announces cores through this.
contract LegacyFactoryEvents {
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

    function announce(
        address dao,
        address token,
        address[] calldata initialMembers,
        uint256[] calldata initialAmounts,
        string calldata name,
        string calldata symbol,
        string calldata description,
        uint256 executionDelay,
        address registry
    ) external {
        emit NewDaoCreated(dao, token, initialMembers, initialAmounts, name, symbol, description, executionDelay,
            registry, new string[](0), new string[](0));
    }

    struct Wrapped {
        address dao;
        address token;
        address underlying;
        address registry;
        string name;
        string symbol;
        string description;
        uint8 quorumFraction;
        uint256 executionDelay;
        uint48 votingDelay;
        uint32 votingPeriod;
        uint256 proposalThreshold;
    }

    function announceWrapped(Wrapped calldata w) external {
        emit DaoWrappedDeploymentInfo(w.dao, w.token, w.underlying, w.registry, w.name, w.symbol, w.description,
            w.quorumFraction, w.executionDelay, w.votingDelay, w.votingPeriod, w.proposalThreshold);
    }
}
