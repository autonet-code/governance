// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Jurisdiction modules follow the shape of Aragon OSx plugins (PluginSetup, PluginRepo,
// PluginRepoRegistry, and the release and build metadata the app renders setup forms from),
// adapted to a core of OpenZeppelin Governor, TimelockController, Registry and governance token,
// where rights live on the token and the Registry instead of in a DAO permission manager.

/// @notice A jurisdiction's core contracts.
struct Core {
    address payable registry;
    address timelock;
    address token;
    address governor;
}

/// @notice A call the jurisdiction makes to attach or detach a module, such as a RepToken grant.
struct Action {
    address target;
    bytes data;
}

/// @notice Another module this installation is wired to, which must stay attached while it is.
struct Dependency {
    string name;
    address module;
}

/// @notice An installation as prepared: the module's main contract, its other contracts, the
///         actions that attach and detach it, its Registry entries (always including
///         `modules.<name>` = "<setup>:<id>") and its dependencies.
struct Prepared {
    address module;
    address[] helpers;
    Action[] install;
    Action[] uninstall;
    string[] registryKeys;
    string[] registryValues;
    Dependency[] dependencies;
}

/// @title IModuleSetup
/// @notice Prepares installations of one module (Aragon OSx: PluginSetup). Anyone can prepare an
///         installation for a jurisdiction: it deploys the module's contracts wired to that core,
///         with no rights. `data` is the ABI encoding of the inputs the version's build metadata
///         describes (`pluginSetup.prepareInstallation.inputs`), so an app installs any module
///         without module-specific code. The jurisdiction attaches the installation by executing
///         `install` and recording the entries, at origination (JurisdictionFactory) or by
///         proposal (ModuleProcessor), and detaches it the same way with `uninstall`.
interface IModuleSetup {
    event InstallationPrepared(uint256 indexed id, address indexed registry, address indexed preparer, address module);

    function moduleName() external view returns (string memory);
    function prepareInstallation(Core calldata core, bytes calldata data) external returns (uint256 id);
    function installationOf(uint256 id) external view returns (Core memory core, Prepared memory p);
    /// @notice The last installation `preparer` prepared (0 = none).
    function lastPreparedBy(address preparer) external view returns (uint256);
    function installations() external view returns (uint256);
}
