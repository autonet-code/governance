// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./ModuleSetup.sol";
import "../ContentCourt.sol";

/// @title ContentCourtSetup
/// @notice The `content_court` module: one ContentCourt per installation, wired to the jurisdiction's
///         RepToken and timelock, with the Registry as the treasury for forfeited deposits. Depends on
///         the `economy` module for its appeal window. Attaching it grants the court slasher rights
///         and records jurisdiction.content_court.court.
contract ContentCourtSetup is ModuleSetup {
    mapping(uint256 => address) public economyOf;

    function moduleName() public pure override returns (string memory) {
        return "content_court";
    }

    /// @param data abi.encode(address economy, ContentCourt.Params)
    function _prepare(uint256 id, Core calldata core, bytes calldata data) internal override returns (address) {
        (address economy, ContentCourt.Params memory p) = abi.decode(data, (address, ContentCourt.Params));
        if (economy == address(0)) revert ZeroAddress();
        economyOf[id] = economy;
        return address(new ContentCourt(core.token, economy, core.timelock, core.registry, p));
    }

    function _describe(uint256 id, Core memory core, Prepared memory p) internal view override {
        _repGrants(p, core.token, new address[](0), _one(p.module));
        string[] memory names = new string[](1);
        names[0] = "court";
        _entries(p, "jurisdiction.content_court.", names, _one(p.module));
        _dependsOn(p, "economy", economyOf[id]);
    }
}
