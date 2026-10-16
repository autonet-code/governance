// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../modules/ModuleSetup.sol";

contract MockModule {}

// A module that depends on an attached economy, for testing ModuleProcessor's dependency checks now
// that no published module depends on another. data = abi.encode(address economy)
contract MockDependentSetup is ModuleSetup {
    mapping(uint256 => address) public economyOf;

    function moduleName() public pure override returns (string memory) {
        return "dependent";
    }

    function _prepare(uint256 id, Core calldata, bytes calldata data) internal override returns (address) {
        economyOf[id] = abi.decode(data, (address));
        return address(new MockModule());
    }

    function _describe(uint256 id, Core memory, Prepared memory p) internal view override {
        string[] memory names = new string[](1);
        names[0] = "";
        _entries(p, "jurisdiction.dependent", names, _one(p.module));
        _dependsOn(p, "economy", economyOf[id]);
    }
}
