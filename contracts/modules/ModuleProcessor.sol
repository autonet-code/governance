// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./IModuleSetup.sol";
import "./ModuleCatalog.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

interface IProcRegistry {
    function owner() external view returns (address);
    function jurisdictionAddress() external view returns (address);
    function getRegistryValue(string memory key) external view returns (string memory);
    function getAllKeys() external view returns (string[] memory);
    function batchEditRegistry(string[] memory keys, string[] memory values) external;
}

interface IProcGovernor {
    function token() external view returns (address);
    function timelock() external view returns (address);
}

/// @title ModuleProcessor
/// @notice Checks module installations and builds the proposal actions that attach or detach them
///         (Aragon OSx: PluginSetupProcessor, except that the jurisdiction's timelock executes the
///         actions itself, so the proposal shows voters every grant). Holds no state and no rights.
///
///         An installation can be attached only if its setup is published in the catalog, it was
///         prepared for this core, no installation of the same module is attached, and every
///         module it depends on is attached at the address it was wired to. It can be detached
///         only while no attached module depends on it.
contract ModuleProcessor {
    using Strings for string;

    ModuleCatalog public immutable catalog;

    error NotPublished();
    error WrongCore();
    error NotAJurisdiction();
    error AlreadyAttached();
    error NotAttached();
    error MissingDependency(string name);
    error HasDependents(string name);

    constructor(ModuleCatalog _catalog) {
        catalog = _catalog;
    }

    /// @notice A live jurisdiction: Registry, Timelock, token and Governor point at each other.
    function checkCore(Core memory c) public view {
        IProcRegistry r = IProcRegistry(c.registry);
        if (r.owner() != c.timelock || r.jurisdictionAddress() != c.token
            || IProcGovernor(c.governor).token() != c.token || IProcGovernor(c.governor).timelock() != c.timelock) {
            revert NotAJurisdiction();
        }
    }

    /// @notice Checks an installation against `registry`'s current entries and returns it.
    function checkInstall(IModuleSetup setup, uint256 id, address registry) public view returns (Core memory c, Prepared memory p) {
        if (!catalog.isPublished(address(setup))) revert NotPublished();
        (c, p) = setup.installationOf(id);
        if (c.registry != registry) revert WrongCore();
        if (bytes(IProcRegistry(registry).getRegistryValue(_marker(setup))).length != 0) revert AlreadyAttached();
        for (uint256 i = 0; i < p.dependencies.length; i++) {
            Dependency memory d = p.dependencies[i];
            (bool ok, address module) = attachedModule(registry, d.name);
            if (!ok || module != d.module) revert MissingDependency(d.name);
        }
    }

    /// @notice The main contract of the attached installation of module `name`, if any.
    function attachedModule(address registry, string memory name) public view returns (bool, address) {
        (bool ok, IModuleSetup setup, uint256 id) = _parse(IProcRegistry(registry).getRegistryValue(string.concat("modules.", name)));
        if (!ok) return (false, address(0));
        (Core memory c, Prepared memory p) = setup.installationOf(id);
        if (c.registry != registry) return (false, address(0));
        return (true, p.module);
    }

    function installCalls(IModuleSetup setup, uint256 id)
        external
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory calldatas)
    {
        (Core memory c,) = setup.installationOf(id);
        checkCore(c);
        (, Prepared memory p) = checkInstall(setup, id, c.registry);
        return _calls(c, p.install, p.registryKeys, p.registryValues);
    }

    /// @notice Revokes the installation's rights and clears its Registry entries.
    function uninstallCalls(IModuleSetup setup, uint256 id)
        external
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory calldatas)
    {
        (Core memory c, Prepared memory p) = setup.installationOf(id);
        checkCore(c);
        IProcRegistry r = IProcRegistry(c.registry);
        string memory expected = string.concat(Strings.toHexString(address(setup)), ":", Strings.toString(id));
        if (!r.getRegistryValue(_marker(setup)).equal(expected)) revert NotAttached();
        string memory name = setup.moduleName();
        _checkNoDependents(r, name, p.module);
        return _calls(c, p.uninstall, p.registryKeys, new string[](p.registryKeys.length));
    }

    function _checkNoDependents(IProcRegistry r, string memory name, address module) private view {
        string[] memory keys = r.getAllKeys();
        for (uint256 i = 0; i < keys.length; i++) {
            if (!_startsWith(keys[i], "modules.")) continue;
            (bool ok, IModuleSetup s, uint256 id) = _parse(r.getRegistryValue(keys[i]));
            if (!ok) continue;
            (, Prepared memory p) = s.installationOf(id);
            for (uint256 j = 0; j < p.dependencies.length; j++) {
                if (p.dependencies[j].name.equal(name) && p.dependencies[j].module == module) {
                    revert HasDependents(s.moduleName());
                }
            }
        }
    }

    function _calls(Core memory c, Action[] memory actions, string[] memory keys, string[] memory vals)
        private
        pure
        returns (address[] memory targets, uint256[] memory values, bytes[] memory calldatas)
    {
        uint256 n = actions.length + 1;
        targets = new address[](n);
        values = new uint256[](n);
        calldatas = new bytes[](n);
        for (uint256 i = 0; i < actions.length; i++) {
            targets[i] = actions[i].target;
            calldatas[i] = actions[i].data;
        }
        targets[n - 1] = c.registry;
        calldatas[n - 1] = abi.encodeCall(IProcRegistry.batchEditRegistry, (keys, vals));
    }

    function _marker(IModuleSetup setup) private view returns (string memory) {
        return string.concat("modules.", setup.moduleName());
    }

    /// @dev "<setup>:<id>"
    function _parse(string memory v) private pure returns (bool, IModuleSetup, uint256) {
        bytes memory b = bytes(v);
        if (b.length < 44 || b[42] != ":") return (false, IModuleSetup(address(0)), 0);
        (bool okA, address a) = Strings.tryParseAddress(v, 0, 42);
        (bool okI, uint256 id) = Strings.tryParseUint(v, 43, b.length);
        return (okA && okI, IModuleSetup(a), id);
    }

    function _startsWith(string memory s, string memory prefix) private pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory p = bytes(prefix);
        if (a.length < p.length) return false;
        for (uint256 i = 0; i < p.length; i++) {
            if (a[i] != p[i]) return false;
        }
        return true;
    }
}
