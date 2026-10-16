// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./ModuleFactory.sol";
import "../ContentCourt.sol";

/// @title ContentCourtFactory
/// @notice The ContentCourt module: one court per installation, with the jurisdiction's Registry as
///         the treasury for forfeited deposits. Attaching grants the court slasher rights on the
///         RepToken and records jurisdiction.content_court.court.
contract ContentCourtFactory is ModuleFactory {
    mapping(uint256 => address) public courtOf;

    function moduleName() public pure override returns (string memory) {
        return "content_court";
    }

    function install(Jurisdiction calldata j, ContentCourt.Params calldata p) external returns (uint256 id) {
        id = _register(j);
        courtOf[id] = address(new ContentCourt(j.repToken, j.economy, j.timelock, j.registry, p));
    }

    function manifest(uint256 id) external view returns (Manifest memory m) {
        m = _manifest(id, 1, 0, 1);
        m.slashers[0] = courtOf[id];
        m.registryKeys[0] = "jurisdiction.content_court.court";
        m.registryValues[0] = Strings.toHexString(courtOf[id]);
    }
}
