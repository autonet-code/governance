// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./IModuleFactory.sol";

interface IAttachRegistry {
    function owner() external view returns (address);
    function jurisdictionAddress() external view returns (address);
    function batchEditRegistry(string[] memory keys, string[] memory values) external;
}

interface IAttachRep {
    function registryAddress() external view returns (address);
    function timelockAddress() external view returns (address);
    function economyAddress() external view returns (address);
    function setMinter(address account, bool allowed) external;
    function setSlasher(address account, bool allowed) external;
}

/// @title ModuleAttacher
/// @notice Builds the proposal actions that attach a module installation to a live jurisdiction, or
///         detach it, from the installation's manifest. It first checks that the installation is
///         wired to a real jurisdiction: the Registry, Timelock, RepToken and Economy it names must
///         point at each other, so a proposal built here can't attach a module wired elsewhere.
///         Holds no state and no rights; the timelock executes the actions.
contract ModuleAttacher {
    error NotAJurisdiction();

    function check(Jurisdiction memory j) public view {
        IAttachRep rep = IAttachRep(j.repToken);
        if (IAttachRegistry(j.registry).owner() != j.timelock
            || IAttachRegistry(j.registry).jurisdictionAddress() != j.repToken
            || rep.registryAddress() != j.registry
            || rep.timelockAddress() != j.timelock
            || rep.economyAddress() != j.economy) {
            revert NotAJurisdiction();
        }
    }

    /// @notice Grants the installation's minters and slashers and records its Registry entries.
    function attachCalls(IModuleFactory factory, uint256 id)
        external
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory calldatas)
    {
        return _calls(factory.manifest(id), true);
    }

    /// @notice Revokes the installation's grants and clears its Registry entries.
    function detachCalls(IModuleFactory factory, uint256 id)
        external
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory calldatas)
    {
        return _calls(factory.manifest(id), false);
    }

    function _calls(Manifest memory m, bool attach)
        private
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory calldatas)
    {
        check(m.jurisdiction);
        uint256 n = m.minters.length + m.slashers.length + 1;
        targets = new address[](n);
        values = new uint256[](n);
        calldatas = new bytes[](n);
        uint256 k;
        for (uint256 i = 0; i < m.minters.length; i++) {
            targets[k] = m.jurisdiction.repToken;
            calldatas[k++] = abi.encodeCall(IAttachRep.setMinter, (m.minters[i], attach));
        }
        for (uint256 i = 0; i < m.slashers.length; i++) {
            targets[k] = m.jurisdiction.repToken;
            calldatas[k++] = abi.encodeCall(IAttachRep.setSlasher, (m.slashers[i], attach));
        }
        if (!attach) m.registryValues = new string[](m.registryKeys.length);
        targets[k] = m.jurisdiction.registry;
        calldatas[k] = abi.encodeCall(IAttachRegistry.batchEditRegistry, (m.registryKeys, m.registryValues));
    }
}
