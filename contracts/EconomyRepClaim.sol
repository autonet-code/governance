// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./Registry.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

interface IEconomyProfile {
    struct UserProfile {
        address[] earnedTokens;
        uint[] earnedAmounts;
        address[] spentTokens;
        uint[] spentAmounts;
        address[] projectsAsAuthor;
        address[] projectsAsContractor;
        address[] projectsAsArbiter;
    }
    function getUser(address userAddress) external view returns (UserProfile memory);
}

interface IClaimRep {
    function mint(address to, uint256 amount) external;
}

/// @title EconomyRepClaim
/// @notice Mints REP for what a member earned and spent in one Economy, valued at the jurisdiction's
///         parities (`jurisdiction.parity.<token>` in the Registry: reputation = amount * parity / 1e18,
///         see docs/registry-settings.md), times the module-wide `jurisdiction.economy.rep_rate_bps`
///         (absent: 10000, the full amount; read at claim time like the parity). A RepToken minter, granted when the Economy module is
///         attached and revoked when it is detached. Claims are tracked here, per Economy, so each
///         earning and spending counts once.
contract EconomyRepClaim {
    uint256 internal constant PARITY_ONE = 1e18;
    uint256 internal constant BPS = 10000;
    string internal constant REP_RATE_KEY = "jurisdiction.economy.rep_rate_bps";

    IEconomyProfile public immutable economy;
    IClaimRep public immutable repToken;
    Registry public immutable registry;

    mapping(address => mapping(address => uint256)) public claimedEarnings;
    mapping(address => mapping(address => uint256)) public claimedSpendings;

    event ReputationClaimedFromEconomy(address indexed user, uint256 amount);

    constructor(address _economy, address _repToken, address payable _registry) {
        economy = IEconomyProfile(_economy);
        repToken = IClaimRep(_repToken);
        registry = Registry(_registry);
    }

    function claim() external returns (uint256 amount) {
        IEconomyProfile.UserProfile memory profile = economy.getUser(msg.sender);
        for (uint256 i = 0; i < profile.earnedTokens.length; i++) {
            amount += _take(claimedEarnings[msg.sender], profile.earnedTokens[i], profile.earnedAmounts[i]);
        }
        for (uint256 i = 0; i < profile.spentTokens.length; i++) {
            amount += _take(claimedSpendings[msg.sender], profile.spentTokens[i], profile.spentAmounts[i]);
        }
        amount = _atRate(amount);
        if (amount > 0) {
            repToken.mint(msg.sender, amount);
            emit ReputationClaimedFromEconomy(msg.sender, amount);
        }
    }

    /// @notice REP `user` could claim now.
    function claimable(address user) external view returns (uint256 amount) {
        IEconomyProfile.UserProfile memory profile = economy.getUser(user);
        for (uint256 i = 0; i < profile.earnedTokens.length; i++) {
            uint256 prev = claimedEarnings[user][profile.earnedTokens[i]];
            if (profile.earnedAmounts[i] > prev) amount += _reputation(profile.earnedTokens[i], profile.earnedAmounts[i] - prev);
        }
        for (uint256 i = 0; i < profile.spentTokens.length; i++) {
            uint256 prev = claimedSpendings[user][profile.spentTokens[i]];
            if (profile.spentAmounts[i] > prev) amount += _reputation(profile.spentTokens[i], profile.spentAmounts[i] - prev);
        }
        amount = _atRate(amount);
    }

    function _take(mapping(address => uint256) storage claimed, address token, uint256 total) private returns (uint256) {
        uint256 prev = claimed[token];
        if (total <= prev) return 0;
        claimed[token] = total;
        return _reputation(token, total - prev);
    }

    function _atRate(uint256 amount) private view returns (uint256) {
        string memory v = registry.getRegistryValue(REP_RATE_KEY);
        if (bytes(v).length == 0) return amount;
        return amount * Strings.parseUint(v) / BPS;
    }

    function _reputation(address token, uint256 amount) private view returns (uint256) {
        string memory v = registry.getRegistryValue(string.concat("jurisdiction.parity.", Strings.toHexString(token)));
        if (bytes(v).length == 0) return 0;
        return amount * Strings.parseUint(v) / PARITY_ONE;
    }
}
