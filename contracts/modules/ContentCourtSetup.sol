// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./ModuleSetup.sol";
import "../ContentCourt.sol";

/// @title ContentCourtSetup
/// @notice The `content_court` module: one ContentCourt per installation, wired to the jurisdiction's
///         RepToken, governor and timelock, with the Registry as the treasury for forfeited deposits.
///         Attaching it grants the court slasher rights and records jurisdiction.content_court.court.
contract ContentCourtSetup is ModuleSetup {
    function moduleName() public pure override returns (string memory) {
        return "content_court";
    }

    /// @param data abi.encode(ContentCourt.Params)
    function _prepare(uint256, Core calldata core, bytes calldata data) internal override returns (address) {
        ContentCourt.Params memory p = abi.decode(data, (ContentCourt.Params));
        return address(new ContentCourt(core.token, core.governor, core.timelock, core.registry, p));
    }

    function _describe(uint256, Core memory core, Prepared memory p) internal pure override {
        _repGrants(p, core.token, new address[](0), _one(p.module));
        string[] memory names = new string[](1);
        names[0] = "court";
        _entries(p, "jurisdiction.content_court.", names, _one(p.module));
    }
}
