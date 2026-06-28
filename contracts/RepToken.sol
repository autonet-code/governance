// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {IAdminToken} from "./IAdminToken.sol";
import {Registry} from "./Registry.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {IJurisdictionData} from "./IJurisdictionData.sol";

// NEW: Interface to the Economy contract to fetch a user's full financial profile.
interface IEconomyWithProfile {
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

// RepToken is the specialized governance token for the Jurisdiction DAO.
// It inherits standard DAO token functionality but replaces generic reputation
// accrual with a "pull" mechanism that reads from a governed Economy contract.
contract RepToken is ERC20, ERC20Permit, ERC20Votes, IAdminToken, IJurisdictionData {
    using Checkpoints for Checkpoints.Trace208;

    address public admin;
    bool public immutable isTransferable;

    // Optional auto-delegation target. When set, an account that receives tokens
    // while having NO delegate of its own is auto-delegated to `defaultDelegate`
    // on first receipt. The moment a holder calls delegate() themselves, their
    // choice wins and is never auto-reset (auto-delegation only fires when the
    // account's current delegate is address(0)). Governance-settable; address(0)
    // disables the feature (default). Suite-level primitive: enables flows like
    // the Coin Offering auto-delegating buyers to an execution delegate without
    // any signature, while preserving each holder's right to reclaim their vote.
    address public defaultDelegate;

    // Accounts exempted from auto-delegation. Inventory-holding contracts (e.g.
    // a Coin Offering holding unsold tokens, a treasury, a vesting vault) must
    // be exempt so their held float does NOT accrue voting power to the default
    // delegate — only tokens in the hands of real holders should auto-delegate.
    // Governance-settable. An exempt account can still self-delegate explicitly.
    mapping(address => bool) public autoDelegateExempt;

    event DefaultDelegateUpdated(address indexed previous, address indexed current);
    event AutoDelegateExemptSet(address indexed account, bool exempt);
    event AutoDelegated(address indexed account, address indexed delegatee);

    address payable public immutable registryAddress;
    address public immutable timelockAddress;

    address public economyAddress;

    // MODIFIED: Separated claimed activity into earnings and spendings for cleaner logic.
    mapping(address => mapping(address => uint)) public claimedEarnings;
    mapping(address => mapping(address => uint)) public claimedSpendings;
    
    mapping(address => Checkpoints.Trace208) private _balanceHistory;

    struct RewardEpoch {
        uint256 budget;
        address paymentToken;
        uint48 startTimestamp;
    }

    uint256 public currentPassiveIncomeEpoch;
    mapping(uint256 => RewardEpoch) public passiveIncomeEpochs;
    mapping(uint256 => mapping(address => bool)) public hasClaimedPassiveIncome;

    uint256 public currentDelegateRewardEpoch;
    mapping(uint256 => RewardEpoch) public delegateRewardEpochs;
    mapping(uint256 => mapping(address => bool)) public hasClaimedDelegateReward;

    event NewPassiveIncomeEpoch(uint256 indexed epochId, uint256 budget, address indexed paymentToken);
    event PassiveIncomeClaimed(address indexed member, uint256 indexed epochId, uint256 amount);
    event NewDelegateRewardEpoch(uint256 indexed epochId, uint256 budget, address indexed paymentToken);
    event DelegateRewardClaimed(address indexed delegate, uint256 indexed epochId, uint256 amount);
    event ReputationClaimedFromEconomy(address indexed user, uint256 amount);

    constructor(
        string memory name,
        string memory symbol,
        address payable _registryAddress,
        address _timelockAddress,
        address[] memory initialMembers,
        uint256[] memory initialAmounts,
        bool _isTransferable
    )
        ERC20(name, symbol)
        ERC20Permit(name)
    {
        require(_registryAddress != address(0) && _timelockAddress != address(0), "RepToken: Invalid addresses");
        registryAddress = _registryAddress;
        timelockAddress = _timelockAddress;
        isTransferable = _isTransferable;
        admin = msg.sender; // THE FIX: Set initial admin to the deployer (the RepTokenFactory)

        for (uint i = 0; i < initialMembers.length; i++) {
            _mint(initialMembers[i], initialAmounts[i]);
        }
    }

    // --- CORE JURISDICTION LOGIC (FIXED) ---

    function claimReputationFromEconomy() external {
        require(economyAddress != address(0), "RepToken: Economy address not set");
        
        IEconomyWithProfile.UserProfile memory profile = IEconomyWithProfile(economyAddress).getUser(msg.sender);
        
        uint256 totalReputationToMint = 0;

        // Process unclaimed earnings
        for (uint i = 0; i < profile.earnedTokens.length; i++) {
            address token = profile.earnedTokens[i];
            uint totalEarnings = profile.earnedAmounts[i];
            uint previouslyClaimed = claimedEarnings[msg.sender][token];
            
            if (totalEarnings > previouslyClaimed) {
                uint unclaimedAmount = totalEarnings - previouslyClaimed;
                totalReputationToMint += _calculateReputation(token, unclaimedAmount);
                claimedEarnings[msg.sender][token] = totalEarnings;
            }
        }
        
        // Process unclaimed spendings
        for (uint i = 0; i < profile.spentTokens.length; i++) {
            address token = profile.spentTokens[i];
            uint totalSpendings = profile.spentAmounts[i];
            uint previouslyClaimed = claimedSpendings[msg.sender][token];

            if (totalSpendings > previouslyClaimed) {
                uint unclaimedAmount = totalSpendings - previouslyClaimed;
                totalReputationToMint += _calculateReputation(token, unclaimedAmount);
                claimedSpendings[msg.sender][token] = totalSpendings;
            }
        }
        
        if (totalReputationToMint > 0) {
            _mint(msg.sender, totalReputationToMint);
            emit ReputationClaimedFromEconomy(msg.sender, totalReputationToMint);
        }
    }

    // Canonical parity convention (see docs/ECONOMY_REGISTRY_SETTINGS.md):
    // parity is an 18-decimal fixed-point multiplier. parity == 1e18 means 1:1.
    // reputation = amount * parity / 1e18. This is decimal-correct for any
    // payment-token decimals: the registry value bakes in the decimal adjustment
    // (e.g. a 6-decimal USDC at 1:1 rep uses parity = 1e18 * 1e12 = 1e30), so a
    // single convention serves both the Economy reputation pull and the CO.
    uint256 internal constant PARITY_ONE = 1e18;

    function _calculateReputation(address token, uint amount) internal view returns (uint256) {
        string memory parityKey = string.concat("jurisdiction.parity.", Strings.toHexString(uint160(token)));
        string memory parityStr = Registry(registryAddress).getRegistryValue(parityKey);

        if (bytes(parityStr).length > 0) {
            uint256 parity = Strings.parseUint(parityStr);
            if (parity > 0) {
                return (amount * parity) / PARITY_ONE;
            }
        }
        return 0;
    }
    
    // --- LEGACY INCENTIVE MECHANISMS ---

    function startNewPassiveIncomeEpoch(uint256 budget, address paymentToken) external {
        require(msg.sender == timelockAddress, "RepToken: Only Timelock can start an epoch");
        currentPassiveIncomeEpoch++;
        passiveIncomeEpochs[currentPassiveIncomeEpoch] = RewardEpoch({
            budget: budget,
            paymentToken: paymentToken,
            startTimestamp: clock()
        });
        emit NewPassiveIncomeEpoch(currentPassiveIncomeEpoch, budget, paymentToken);
    }

    function startNewDelegateRewardEpoch(uint256 budget, address paymentToken) external {
        require(msg.sender == timelockAddress, "RepToken: Only Timelock can start an epoch");
        currentDelegateRewardEpoch++;
        delegateRewardEpochs[currentDelegateRewardEpoch] = RewardEpoch({
            budget: budget,
            paymentToken: paymentToken,
            startTimestamp: clock()
        });
        emit NewDelegateRewardEpoch(currentDelegateRewardEpoch, budget, paymentToken);
    }

    function claimPassiveIncome(uint256 epochId) external {
        RewardEpoch storage epoch = passiveIncomeEpochs[epochId];
        require(epochId > 0 && epochId <= currentPassiveIncomeEpoch, "RepToken: Invalid epoch ID");
        require(epoch.startTimestamp > 0, "RepToken: Epoch does not exist");
        require(!hasClaimedPassiveIncome[epochId][msg.sender], "RepToken: Already claimed for this epoch");
        uint256 snapshotTime = epoch.startTimestamp - 1;
        uint256 userReputation = _getPastBalance(msg.sender, snapshotTime);
        require(userReputation > 0, "RepToken: No reputation at epoch start");
        uint256 totalReputation = getPastTotalSupply(snapshotTime);
        require(totalReputation > 0, "RepToken: Zero total supply at epoch start");
        uint256 rewardAmount = (userReputation * epoch.budget) / totalReputation;
        require(rewardAmount > 0, "RepToken: Reward amount is zero");
        hasClaimedPassiveIncome[epochId][msg.sender] = true;
        bytes32 purpose = keccak256(abi.encodePacked("PASSIVE_INCOME", epochId, epoch.paymentToken));
        Registry(registryAddress).disburseEarmarked(msg.sender, rewardAmount, purpose, epoch.paymentToken);
        emit PassiveIncomeClaimed(msg.sender, epochId, rewardAmount);
    }

    function claimRepresentationReward(uint256 epochId) external {
        RewardEpoch storage epoch = delegateRewardEpochs[epochId];
        require(epochId > 0 && epochId <= currentDelegateRewardEpoch, "RepToken: Invalid epoch ID");
        require(epoch.startTimestamp > 0, "RepToken: Epoch does not exist");
        require(!hasClaimedDelegateReward[epochId][msg.sender], "RepToken: Already claimed for this epoch");
        uint256 snapshotTime = epoch.startTimestamp - 1;
        uint256 totalVotingPower = getPastVotes(msg.sender, snapshotTime);
        uint256 ownPastBalance = _getPastBalance(msg.sender, snapshotTime);
        require(totalVotingPower > ownPastBalance, "RepToken: No delegated votes at epoch start");
        uint256 delegatedVotes = totalVotingPower - ownPastBalance;
        uint256 totalReputation = getPastTotalSupply(snapshotTime);
        require(totalReputation > 0, "RepToken: Zero total supply at epoch start");
        uint256 rewardAmount = (delegatedVotes * epoch.budget) / totalReputation;
        require(rewardAmount > 0, "RepToken: Reward amount is zero");
        hasClaimedDelegateReward[epochId][msg.sender] = true;
        bytes32 purpose = keccak256(abi.encodePacked("DELEGATE_REWARD", epochId, epoch.paymentToken));
        Registry(registryAddress).disburseEarmarked(msg.sender, rewardAmount, purpose, epoch.paymentToken);
        emit DelegateRewardClaimed(msg.sender, epochId, rewardAmount);
    }

    // --- GETTERS & CONFIG ---
    function getPassiveIncomeEpochStart(uint256 epochId) external view override returns (uint48) {
        return passiveIncomeEpochs[epochId].startTimestamp;
    }

    function getDelegateRewardEpochStart(uint256 epochId) external view override returns (uint48) {
        return delegateRewardEpochs[epochId].startTimestamp;
    }

    function _getPastBalance(address account, uint256 timepoint) internal view returns (uint256) {
        require(timepoint < block.timestamp, "ERC20: snapshot query for future block");
        require(timepoint <= type(uint48).max, "RepToken: timepoint exceeds uint48 range");
        return _balanceHistory[account].upperLookup(uint48(timepoint));
    }

    function setEconomyAddress(address _economyAddress) external {
        require(msg.sender == admin || msg.sender == timelockAddress, "RepToken: Caller is not the admin or Timelock");
        require(economyAddress == address(0), "RepToken: Economy address already set");
        economyAddress = _economyAddress;
    }

    // Governance-settable auto-delegation target. Set to address(0) to disable.
    // Does not retroactively change existing delegations; only affects accounts
    // that receive tokens while holding no delegate of their own.
    function setDefaultDelegate(address _defaultDelegate) external {
        require(msg.sender == admin || msg.sender == timelockAddress, "RepToken: Caller is not the admin or Timelock");
        emit DefaultDelegateUpdated(defaultDelegate, _defaultDelegate);
        defaultDelegate = _defaultDelegate;
    }

    // Exempt (or un-exempt) an account from auto-delegation. Used for
    // inventory-holding contracts (Coin Offering, treasury, vesting) whose held
    // float must not accrue votes to the default delegate. Does not change any
    // existing delegation; only affects future auto-delegation on receipt.
    function setAutoDelegateExempt(address account, bool exempt) external {
        require(msg.sender == admin || msg.sender == timelockAddress, "RepToken: Caller is not the admin or Timelock");
        autoDelegateExempt[account] = exempt;
        emit AutoDelegateExemptSet(account, exempt);
    }
    
    function decimals() public pure override returns (uint8) { return 18; }
    function CLOCK_MODE() public pure override returns (string memory) { return "mode=timestamp"; }
    function clock() public view override returns (uint48) { return uint48(block.timestamp); }

    // MODIFIED: This is now a standard admin transfer function
    function setAdmin(address newAdmin) public override {
        require(msg.sender == admin, "RepToken: Caller is not the admin");
        require(newAdmin != address(0), "RepToken: New admin cannot be the zero address");
        admin = newAdmin;
    }

    // Mint and burn functions for governance proposals (controlled by admin/timelock)
    function mint(address to, uint256 amount) public {
        require(msg.sender == admin, "RepToken: Only admin can mint");
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) public {
        require(msg.sender == admin, "RepToken: Only admin can burn");
        _burn(from, amount);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
        uint48 timestamp = clock();
        if (from != address(0)) {
            _balanceHistory[from].push(timestamp, uint208(balanceOf(from)));
        }
        if (to != address(0)) {
            _balanceHistory[to].push(timestamp, uint208(balanceOf(to)));

            // Auto-delegate on first receipt: if a default delegate is configured
            // and the recipient has not chosen a delegate of their own, point their
            // voting weight at the default. A holder who later calls delegate()
            // sets a non-zero delegatee and is never auto-reset by this branch.
            // Skipped for the default delegate itself (it self-represents) and for
            // exempt accounts (inventory-holding contracts whose float must not vote).
            if (
                defaultDelegate != address(0) &&
                to != defaultDelegate &&
                !autoDelegateExempt[to] &&
                delegates(to) == address(0)
            ) {
                _delegate(to, defaultDelegate);
                emit AutoDelegated(to, defaultDelegate);
            }
        }
    }
    
    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) { return super.nonces(owner); }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (!isTransferable) {
            revert("RepToken: Reputation is non-transferable");
        }
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (!isTransferable) {
            revert("RepToken: Reputation is non-transferable");
        }
        return super.transferFrom(from, to, value);
    }
}
// RepToken.sol