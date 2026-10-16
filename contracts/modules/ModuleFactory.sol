// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./IModuleFactory.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/// @title ModuleFactory
/// @notice Bookkeeping shared by module factories: installation ids (from 1), the jurisdiction of
///         each, and the `modules.<name>` Registry entry every manifest carries. Its value is
///         "<factory>:<id>", so a jurisdiction's attached modules can be read from its Registry.
abstract contract ModuleFactory is IModuleFactory {
    uint256 public installs;
    mapping(address => uint256) public lastInstallBy;
    mapping(uint256 => Jurisdiction) private _jurisdictions;

    error ZeroAddress();
    error UnknownInstall();

    function moduleName() public view virtual returns (string memory);

    function jurisdictionOf(uint256 id) public view returns (Jurisdiction memory j) {
        j = _jurisdictions[id];
        if (j.registry == address(0)) revert UnknownInstall();
    }

    function _register(Jurisdiction calldata j) internal returns (uint256 id) {
        if (j.registry == address(0) || j.timelock == address(0) || j.repToken == address(0)
            || j.economy == address(0) || j.dao == address(0)) {
            revert ZeroAddress();
        }
        id = ++installs;
        _jurisdictions[id] = j;
        lastInstallBy[msg.sender] = id;
        emit ModuleInstalled(id, j.registry, msg.sender);
    }

    /// @dev A manifest with `n` module-specific entries; the marker entry goes at index n.
    function _manifest(uint256 id, uint256 n, uint256 minters, uint256 slashers)
        internal
        view
        returns (Manifest memory m)
    {
        m.name = moduleName();
        m.jurisdiction = jurisdictionOf(id);
        m.minters = new address[](minters);
        m.slashers = new address[](slashers);
        m.registryKeys = new string[](n + 1);
        m.registryValues = new string[](n + 1);
        m.registryKeys[n] = string.concat("modules.", m.name);
        m.registryValues[n] = string.concat(Strings.toHexString(address(this)), ":", Strings.toString(id));
    }
}
