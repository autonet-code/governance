// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./InfrastructureFactory.sol";
import "./DAOFactory.sol";
import "./RepTokenFactory.sol";
import "./WrappedRepTokenFactory.sol";
import "../Registry.sol";
import "../IAdminToken.sol";
import "../modules/ModuleProcessor.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title JurisdictionFactory
/// @notice Creates every DAO: a core of Governor, TimelockController, Registry and governance token
///         (soulbound or transferable RepToken, or a WrappedRepToken over an existing ERC20), plus
///         any modules (docs/modules.md), the Economy among them.
///
///         `deploy` creates a DAO with no modules in one transaction. With modules: `deployCore`,
///         then anyone prepares each module's installation for that core (IModuleSetup), then
///         `finalize` attaches them in order (so a module comes after the ones it depends on),
///         using the same checks as a later attach proposal (ModuleProcessor), and hands
///         everything to the timelock. Until then this factory is the token's admin and the
///         Registry's owner, which is what lets it attach modules without a proposal; it executes
///         a module's actions only against that DAO's own token and Registry. A pending core can
///         be finalized only by the account that deployed it.
contract JurisdictionFactory {
    enum TokenKind { Soulbound, Transferable, Wrapped }

    struct CoreParams {
        string name;
        string symbol;
        string description;
        TokenKind tokenKind;
        address underlying;        // Wrapped only: the ERC20 to wrap
        address[] initialMembers;  // RepToken only
        uint256[] initialAmounts;
        uint48 votingDelay;        // minutes
        uint32 votingPeriod;       // minutes
        uint256 proposalThreshold;
        uint8 quorumFraction;      // percent of supply
        uint256 executionDelay;    // seconds
    }

    struct ModuleRef {
        IModuleSetup setup;
        uint256 id;
    }

    struct Pending {
        address originator;
        Core core;
        CoreParams params;
    }

    InfrastructureFactory public immutable infrastructureFactory;
    DAOFactory public immutable daoFactory;
    RepTokenFactory public immutable repTokenFactory;
    WrappedRepTokenFactory public immutable wrappedRepTokenFactory;
    ModuleProcessor public immutable processor;

    mapping(address => Pending) private _pending; // by registry

    event CoreDeployed(address indexed originator, address registry, address timelock, address token, address indexed governor);
    event ModuleAttached(address indexed governor, string name, address setup, uint256 id);
    // Indexer compatibility: the event every DAO factory has emitted
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

    error NotPending();
    error NotOriginator();
    error WrongCore();
    error ForeignTarget(address target);
    error ActionFailed(uint256 index);
    error BadParams();

    constructor(
        InfrastructureFactory _infra,
        DAOFactory _dao,
        RepTokenFactory _rep,
        WrappedRepTokenFactory _wrapped,
        ModuleProcessor _processor
    ) {
        infrastructureFactory = _infra;
        daoFactory = _dao;
        repTokenFactory = _rep;
        wrappedRepTokenFactory = _wrapped;
        processor = _processor;
    }

    function deploy(CoreParams calldata p, string[] calldata keys, string[] calldata values) external returns (Core memory core) {
        core = deployCore(p);
        finalize(core, new ModuleRef[](0), keys, values);
    }

    function deployCore(CoreParams calldata p) public returns (Core memory core) {
        if (p.initialMembers.length != p.initialAmounts.length) revert BadParams();
        core.timelock = infrastructureFactory.deployTimelock(address(this), p.executionDelay);
        core.registry = payable(infrastructureFactory.deployRegistry(address(this), address(0)));
        if (p.tokenKind == TokenKind.Wrapped) {
            if (p.underlying == address(0)) revert BadParams();
            core.token = wrappedRepTokenFactory.deployWrappedRepToken(IERC20(p.underlying), p.name, p.symbol, false);
        } else {
            core.token = repTokenFactory.deployRepToken(p.name, p.symbol, core.registry, core.timelock,
                p.initialMembers, p.initialAmounts, p.tokenKind == TokenKind.Transferable);
        }
        uint256[] memory settings = new uint256[](4);
        (settings[0], settings[1], settings[2], settings[3]) = (p.votingDelay, p.votingPeriod, p.proposalThreshold, p.quorumFraction);
        core.governor = daoFactory.deployDAO(core.token, core.timelock, p.name, settings);
        Registry(core.registry).setJurisdictionAddress(core.token);

        Pending storage pend = _pending[core.registry];
        pend.originator = msg.sender;
        pend.core = core;
        pend.params = p;
        emit CoreDeployed(msg.sender, core.registry, core.timelock, core.token, core.governor);
    }

    /// @notice Records `keys`, attaches `modules` in order, then hands the core to its timelock.
    function finalize(Core memory core, ModuleRef[] memory modules, string[] calldata keys, string[] calldata values)
        public
    {
        Pending storage pend = _pending[core.registry];
        if (pend.originator == address(0)) revert NotPending();
        if (pend.originator != msg.sender) revert NotOriginator();
        if (!_same(pend.core, core)) revert WrongCore();
        Registry registry = Registry(core.registry);

        if (keys.length > 0) registry.batchEditRegistry(keys, values);
        for (uint256 i = 0; i < modules.length; i++) {
            (Core memory c, Prepared memory p) = processor.checkInstall(modules[i].setup, modules[i].id, core.registry);
            if (!_same(c, core)) revert WrongCore();
            for (uint256 k = 0; k < p.install.length; k++) {
                address target = p.install[k].target;
                if (target != core.token && target != core.registry && target != core.governor) revert ForeignTarget(target);
                (bool ok,) = target.call(p.install[k].data);
                if (!ok) revert ActionFailed(k);
            }
            registry.batchEditRegistry(p.registryKeys, p.registryValues);
            emit ModuleAttached(core.governor, modules[i].setup.moduleName(), address(modules[i].setup), modules[i].id);
        }

        IAdminToken(core.token).setAdmin(core.timelock);
        registry.transferOwnership(core.timelock);
        TimelockController timelock = TimelockController(payable(core.timelock));
        timelock.grantRole(timelock.PROPOSER_ROLE(), core.governor);
        timelock.grantRole(timelock.CANCELLER_ROLE(), core.governor);
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(0));
        timelock.revokeRole(timelock.DEFAULT_ADMIN_ROLE(), address(this));

        CoreParams storage p_ = pend.params;
        emit NewDaoCreated(core.governor, core.token, p_.initialMembers, p_.initialAmounts, p_.name, p_.symbol,
            p_.description, p_.executionDelay, core.registry, keys, values);
        delete _pending[core.registry];
    }

    function pendingOf(address registry) external view returns (address originator, Core memory core) {
        return (_pending[registry].originator, _pending[registry].core);
    }

    function _same(Core memory a, Core memory b) private pure returns (bool) {
        return a.registry == b.registry && a.timelock == b.timelock && a.token == b.token && a.governor == b.governor;
    }
}
