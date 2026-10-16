// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./IModuleSetup.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/// @notice The rights a module can be given on a jurisdiction RepToken.
interface IModuleRep {
    function setMinter(address account, bool allowed) external;
    function setSlasher(address account, bool allowed) external;
}

/// @title ModuleSetup
/// @notice Bookkeeping shared by module setups: installation ids (from 1), the core each was
///         prepared for, and the `modules.<name>` marker entry appended to every installation.
///         A setup implements `_prepare` (deploy, return the module address) and `_describe`
///         (the installation's actions, entries and dependencies).
abstract contract ModuleSetup is IModuleSetup {
    uint256 public installations;
    mapping(address => uint256) public lastPreparedBy;
    mapping(uint256 => Core) private _cores;
    mapping(uint256 => address) public moduleOf;

    error ZeroAddress();
    error UnknownInstallation();

    function moduleName() public view virtual returns (string memory);

    function _prepare(uint256 id, Core calldata core, bytes calldata data) internal virtual returns (address module);

    function _describe(uint256 id, Core memory core, Prepared memory p) internal view virtual;

    function prepareInstallation(Core calldata core, bytes calldata data) external returns (uint256 id) {
        if (core.registry == address(0) || core.timelock == address(0) || core.token == address(0)
            || core.governor == address(0)) {
            revert ZeroAddress();
        }
        id = ++installations;
        _cores[id] = core;
        lastPreparedBy[msg.sender] = id;
        address module = _prepare(id, core, data);
        moduleOf[id] = module;
        emit InstallationPrepared(id, core.registry, msg.sender, module);
    }

    function installationOf(uint256 id) external view returns (Core memory core, Prepared memory p) {
        core = _cores[id];
        if (core.registry == address(0)) revert UnknownInstallation();
        p.module = moduleOf[id];
        _describe(id, core, p);
        // Append the marker entry
        uint256 n = p.registryKeys.length;
        string[] memory keys = new string[](n + 1);
        string[] memory values = new string[](n + 1);
        for (uint256 i = 0; i < n; i++) {
            keys[i] = p.registryKeys[i];
            values[i] = p.registryValues[i];
        }
        keys[n] = string.concat("modules.", moduleName());
        values[n] = string.concat(Strings.toHexString(address(this)), ":", Strings.toString(id));
        p.registryKeys = keys;
        p.registryValues = values;
    }

    // ── Helpers for _describe ─────────────────────────────────────────────

    /// @dev RepToken grants: install grants each role, uninstall revokes it.
    function _repGrants(Prepared memory p, address token, address[] memory minters, address[] memory slashers)
        internal
        pure
    {
        uint256 n = minters.length + slashers.length;
        p.install = new Action[](n);
        p.uninstall = new Action[](n);
        uint256 k;
        for (uint256 i = 0; i < minters.length; i++) {
            p.install[k] = Action(token, abi.encodeCall(IModuleRep.setMinter, (minters[i], true)));
            p.uninstall[k++] = Action(token, abi.encodeCall(IModuleRep.setMinter, (minters[i], false)));
        }
        for (uint256 i = 0; i < slashers.length; i++) {
            p.install[k] = Action(token, abi.encodeCall(IModuleRep.setSlasher, (slashers[i], true)));
            p.uninstall[k++] = Action(token, abi.encodeCall(IModuleRep.setSlasher, (slashers[i], false)));
        }
    }

    function _one(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _entries(Prepared memory p, string memory prefix, string[] memory names, address[] memory addrs)
        internal
        pure
    {
        p.registryKeys = new string[](names.length);
        p.registryValues = new string[](names.length);
        for (uint256 i = 0; i < names.length; i++) {
            p.registryKeys[i] = string.concat(prefix, names[i]);
            p.registryValues[i] = Strings.toHexString(addrs[i]);
        }
    }

    function _dependsOn(Prepared memory p, string memory name, address module) internal pure {
        p.dependencies = new Dependency[](1);
        p.dependencies[0] = Dependency(name, module);
    }
}
