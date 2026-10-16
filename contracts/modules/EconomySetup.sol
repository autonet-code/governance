// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./ModuleSetup.sol";
import "../Economy.sol";
import "../EconomyRepClaim.sol";

/// @title EconomySetup
/// @notice The `economy` module: an Economy (projects, escrow, disputes and appeals) configured and
///         handed to the jurisdiction's timelock, and its EconomyRepClaim. Attaching it makes the
///         claim a RepToken minter and records jurisdiction.economy and jurisdiction.economy.rep_claim.
///         The other modules don't depend on it.
contract EconomySetup is ModuleSetup {
    struct Params {
        uint256 arbitrationFeeBps;
        uint256 platformFeeBps;
        uint256 authorFeeBps;
        uint256 coolingOffPeriod;  // seconds
        uint256 backersQuorumBps;
        uint256 projectThreshold;  // REP needed to create a project
        uint256 appealPeriod;      // seconds
    }

    address public immutable nativeProjectImpl;
    address public immutable erc20ProjectImpl;
    // The cooling-off no Economy from this setup can go below: 1 day in production, shorter on test networks
    uint256 public immutable minCoolingOffPeriod;
    mapping(uint256 => address) public claimOf;

    constructor(address _nativeProjectImpl, address _erc20ProjectImpl, uint256 _minCoolingOffPeriod) {
        nativeProjectImpl = _nativeProjectImpl;
        erc20ProjectImpl = _erc20ProjectImpl;
        minCoolingOffPeriod = _minCoolingOffPeriod;
    }

    function moduleName() public pure override returns (string memory) {
        return "economy";
    }

    function _prepare(uint256 id, Core calldata core, bytes calldata data) internal override returns (address) {
        Params memory p = abi.decode(data, (Params));
        Economy economy = new Economy(p.arbitrationFeeBps);
        economy.setMinCoolingOffPeriod(minCoolingOffPeriod);
        economy.setImplementations(nativeProjectImpl, erc20ProjectImpl);
        economy.setPlatformFee(p.platformFeeBps);
        economy.setAuthorFee(p.authorFeeBps);
        economy.setCoolingOffPeriod(p.coolingOffPeriod);
        economy.setBackersVoteQuorum(p.backersQuorumBps);
        economy.setProjectThreshold(p.projectThreshold);
        economy.setAppealPeriod(p.appealPeriod);
        // From here on only the timelock governs it
        economy.setDaoAddresses(core.timelock, core.registry, core.governor, core.token);
        claimOf[id] = address(new EconomyRepClaim(address(economy), core.token, core.registry));
        return address(economy);
    }

    function _describe(uint256 id, Core memory core, Prepared memory p) internal view override {
        address claim = claimOf[id];
        p.helpers = _one(claim);
        _repGrants(p, core.token, _one(claim), new address[](0));
        string[] memory names = new string[](2);
        address[] memory addrs = new address[](2);
        (names[0], addrs[0]) = ("", p.module);
        (names[1], addrs[1]) = (".rep_claim", claim);
        _entries(p, "jurisdiction.economy", names, addrs);
    }
}
