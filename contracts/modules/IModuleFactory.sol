// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The core contracts of a jurisdiction a module is wired to.
struct Jurisdiction {
    address payable registry;
    address timelock;
    address repToken;
    address economy;
    address dao;
}

/// @notice What attaching an installation needs: RepToken grants and Registry entries. Granting and
///         recording them is what makes a module part of the jurisdiction; until then it is inert.
struct Manifest {
    string name;
    Jurisdiction jurisdiction;
    address[] minters;
    address[] slashers;
    string[] registryKeys;
    string[] registryValues;
}

/// @title IModuleFactory
/// @notice A factory for one kind of jurisdiction module (Autonet, ContentCourt, ...). Anyone can
///         install a module for a jurisdiction: that deploys the module's contracts wired to the
///         jurisdiction, with no rights. The jurisdiction attaches it either at origination
///         (TrustlessFactory.configureAndFinalizeWithGrants) or later by proposal (ModuleAttacher).
interface IModuleFactory {
    event ModuleInstalled(uint256 indexed id, address indexed registry, address indexed installer);

    function moduleName() external view returns (string memory);
    function installs() external view returns (uint256);
    /// @notice The last installation `installer` made (0 = none).
    function lastInstallBy(address installer) external view returns (uint256);
    function jurisdictionOf(uint256 id) external view returns (Jurisdiction memory);
    function manifest(uint256 id) external view returns (Manifest memory);
}
