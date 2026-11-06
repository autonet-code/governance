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

// RepToken is the specialized governance token for the Jurisdiction DAO. Reputation is created
// only by its minters (the Economy module's EconomyRepClaim, the Autonet REP claim...), which the DAO grants and revokes, so no source of reputation is built in.
contract RepToken is ERC20, ERC20Permit, ERC20Votes, IAdminToken, IJurisdictionData {
    using Checkpoints for Checkpoints.Trace208;

    address public admin;

    // Optional auto-delegation target. When set, an account that receives tokens
    // while having NO delegate of its own is auto-delegated to `defaultDelegate`
    // on first receipt. The moment a holder calls delegate() themselves, their
    // choice wins and is never auto-reset (auto-delegation only fires when the
    // account's current delegate is address(0)). Governance-settable; address(0)
    // disables the feature (default). Suite-level primitive: auto-delegates new
    // holders to an execution delegate without any signature, while preserving
    // each holder's right to reclaim their vote.
    address public defaultDelegate;

    // Accounts exempted from auto-delegation. Inventory-holding contracts (e.g.
    // a treasury, a vesting vault) must
    // be exempt so their held float does NOT accrue voting power to the default
    // delegate — only tokens in the hands of real holders should auto-delegate.
    // Governance-settable. An exempt account can still self-delegate explicitly.
    mapping(address => bool) public autoDelegateExempt;

    // Addresses authorized to mint, in addition to admin. Used to grant a module
    // (a REP claim, say) the right to mint REP on its own terms. Governance-settable.
    mapping(address => bool) public minters;

    // Addresses authorized to slash REP (e.g. a verdict contract that penalizes a malicious tool
    // author) and to reassign what they slashed. A slasher can only move existing REP, never
    // create it. Governance-settable.
    mapping(address => bool) public slashers;
    mapping(address => uint256) public slashedCredit; // REP a slasher burned and may reassign

    event DefaultDelegateUpdated(address indexed previous, address indexed current);
    event AutoDelegateExemptSet(address indexed account, bool exempt);
    event MinterSet(address indexed account, bool allowed);
    event SlasherSet(address indexed account, bool allowed);
    event Slashed(address indexed slasher, address indexed from, uint256 amount);
    event Reassigned(address indexed slasher, address indexed to, uint256 amount);
    event AutoDelegated(address indexed account, address indexed delegatee);

    address payable public immutable registryAddress;
    address public immutable timelockAddress;

    mapping(address => Checkpoints.Trace208) private _balanceHistory;

    // Reward epochs: two pools, each with its own budget. The passive pool pays by REP balance at the
    // snapshot, whatever the holder delegated. The delegate pool pays the top delegates by the weight
    // they received from others at the snapshot: sorting every address on chain can't work, so after
    // the epoch starts there is a sign-up window that keeps the top list, and claims open when it ends.
    enum RewardPool { Passive, Delegate }

    struct RewardEpoch {
        uint256 budget;
        address paymentToken;
        uint48 startTimestamp;
        RewardPool pool;
        uint16 topN;       // delegate pool: how many delegates it pays
        uint48 signupEnds; // delegate pool: entries close and claims open after this time
    }

    uint16 public constant MAX_DELEGATE_TOP_N = 100; // bounds the search for the lowest entry
    uint32 public constant MAX_DELEGATE_SIGNUP = 30 days;
    uint16 public delegateTopN = 10;
    uint32 public delegateSignupPeriod = 3 days;

    uint256 public currentRewardEpoch;
    mapping(uint256 => RewardEpoch) public rewardEpochs;
    mapping(uint256 => mapping(address => bool)) public hasClaimedReward;

    mapping(uint256 => address[]) private _topDelegates;
    mapping(uint256 => mapping(address => uint256)) public delegatePoolWeight; // 0: not in the top list
    mapping(uint256 => uint256) public delegatePoolTotal;

    mapping(address => Checkpoints.Trace208) private _delegateeHistory;

    event NewRewardEpoch(uint256 indexed epochId, RewardPool pool, uint256 budget, address indexed paymentToken, uint16 topN, uint48 signupEnds);
    event RewardClaimed(address indexed account, uint256 indexed epochId, uint256 amount);
    event DelegateRewardsSet(uint16 topN, uint32 signupPeriod);
    event DelegatePoolEntered(uint256 indexed epochId, address indexed delegatee, uint256 weight);
    event DelegatePoolDisplaced(uint256 indexed epochId, address indexed delegatee);

    constructor(
        string memory name,
        string memory symbol,
        address payable _registryAddress,
        address _timelockAddress,
        address[] memory initialMembers,
        uint256[] memory initialAmounts
    )
        ERC20(name, symbol)
        ERC20Permit(name)
    {
        require(_registryAddress != address(0) && _timelockAddress != address(0), "RepToken: Invalid addresses");
        registryAddress = _registryAddress;
        timelockAddress = _timelockAddress;
        admin = msg.sender; // THE FIX: Set initial admin to the deployer (the RepTokenFactory)

        for (uint i = 0; i < initialMembers.length; i++) {
            _mint(initialMembers[i], initialAmounts[i]);
        }
    }

    // --- REWARD EPOCHS ---

    function setDelegateRewards(uint16 topN, uint32 signupPeriod) external {
        require(msg.sender == timelockAddress, "RepToken: Only Timelock can set delegate rewards");
        require(topN > 0 && topN <= MAX_DELEGATE_TOP_N, "RepToken: Invalid top N");
        require(signupPeriod > 0 && signupPeriod <= MAX_DELEGATE_SIGNUP, "RepToken: Invalid sign-up period");
        delegateTopN = topN;
        delegateSignupPeriod = signupPeriod;
        emit DelegateRewardsSet(topN, signupPeriod);
    }

    function rewardPurpose(uint256 epochId, address paymentToken) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("REWARD", epochId, paymentToken));
    }

    // Starts a passive pool and reserves its budget in the registry in the same call.
    function startPassiveEpoch(uint256 budget, address paymentToken) external {
        _startEpoch(budget, paymentToken, RewardPool.Passive, 0, 0);
    }

    // Starts a delegate pool, its sign-up window and its reservation. The epoch keeps today's settings.
    function startDelegateEpoch(uint256 budget, address paymentToken) external {
        _startEpoch(budget, paymentToken, RewardPool.Delegate, delegateTopN, clock() + delegateSignupPeriod);
    }

    function _startEpoch(uint256 budget, address paymentToken, RewardPool pool, uint16 topN, uint48 signupEnds) private {
        require(msg.sender == timelockAddress, "RepToken: Only Timelock can start an epoch");
        require(budget > 0, "RepToken: Empty budget");
        currentRewardEpoch++;
        rewardEpochs[currentRewardEpoch] = RewardEpoch({
            budget: budget,
            paymentToken: paymentToken,
            startTimestamp: clock(),
            pool: pool,
            topN: topN,
            signupEnds: signupEnds
        });
        Registry(registryAddress).earmarkFunds(rewardPurpose(currentRewardEpoch, paymentToken), budget, paymentToken);
        emit NewRewardEpoch(currentRewardEpoch, pool, budget, paymentToken, topN, signupEnds);
    }

    // The voting weight others gave an account: its votes, less its own REP if it delegated to itself.
    function receivedWeight(address account, uint256 timepoint) public view returns (uint256) {
        uint256 votes = getPastVotes(account, timepoint);
        return pastDelegatee(account, timepoint) == account ? votes - _getPastBalance(account, timepoint) : votes;
    }

    // Enters a delegate in the top list, displacing the lowest entry when the list is full. Anyone
    // can enter anyone: the weight is on chain, so one honest caller is enough to get a delegate in.
    function enterDelegatePool(uint256 epochId, address delegatee) external {
        RewardEpoch memory epoch = rewardEpochs[epochId];
        require(epoch.pool == RewardPool.Delegate && epoch.startTimestamp > 0, "RepToken: Not a delegate pool");
        require(clock() <= epoch.signupEnds, "RepToken: Sign-up has closed");
        require(delegatePoolWeight[epochId][delegatee] == 0, "RepToken: Already in the top list");
        uint256 weight = receivedWeight(delegatee, epoch.startTimestamp - 1);
        require(weight > 0, "RepToken: No delegated weight");

        address[] storage top = _topDelegates[epochId];
        if (top.length < epoch.topN) {
            top.push(delegatee);
        } else {
            uint256 lowest;
            uint256 lowestWeight = type(uint256).max;
            for (uint256 i = 0; i < top.length; i++) {
                uint256 w = delegatePoolWeight[epochId][top[i]];
                if (w < lowestWeight) (lowest, lowestWeight) = (i, w);
            }
            require(weight > lowestWeight, "RepToken: Below the top list");
            emit DelegatePoolDisplaced(epochId, top[lowest]);
            delete delegatePoolWeight[epochId][top[lowest]];
            delegatePoolTotal[epochId] -= lowestWeight;
            top[lowest] = delegatee;
        }
        delegatePoolWeight[epochId][delegatee] = weight;
        delegatePoolTotal[epochId] += weight;
        emit DelegatePoolEntered(epochId, delegatee, weight);
    }

    function topDelegates(uint256 epochId) external view returns (address[] memory) {
        return _topDelegates[epochId];
    }

    // An account's reward. While a delegate pool's sign-up is open this is what it would get so far.
    function rewardOf(uint256 epochId, address account) public view returns (uint256) {
        RewardEpoch memory epoch = rewardEpochs[epochId];
        require(epochId > 0 && epochId <= currentRewardEpoch, "RepToken: Invalid epoch ID");
        if (epoch.pool == RewardPool.Delegate) {
            uint256 total = delegatePoolTotal[epochId];
            return total == 0 ? 0 : (delegatePoolWeight[epochId][account] * epoch.budget) / total;
        }
        uint256 snapshot = epoch.startTimestamp - 1;
        uint256 totalReputation = getPastTotalSupply(snapshot);
        return totalReputation == 0 ? 0 : (_getPastBalance(account, snapshot) * epoch.budget) / totalReputation;
    }

    function claimReward(uint256 epochId) external {
        require(!hasClaimedReward[epochId][msg.sender], "RepToken: Already claimed for this epoch");
        RewardEpoch memory epoch = rewardEpochs[epochId];
        require(clock() > epoch.signupEnds, "RepToken: Sign-up is still open");
        uint256 rewardAmount = rewardOf(epochId, msg.sender);
        require(rewardAmount > 0, "RepToken: Reward amount is zero");
        hasClaimedReward[epochId][msg.sender] = true;
        Registry(registryAddress).disburseEarmarked(msg.sender, rewardAmount, rewardPurpose(epochId, epoch.paymentToken), epoch.paymentToken);
        emit RewardClaimed(msg.sender, epochId, rewardAmount);
    }

    // --- GETTERS & CONFIG ---
    function getRewardEpochStart(uint256 epochId) external view override returns (uint48) {
        return rewardEpochs[epochId].startTimestamp;
    }

    function getRewardClaimsOpen(uint256 epochId) external view override returns (uint48) {
        RewardEpoch storage epoch = rewardEpochs[epochId];
        return epoch.pool == RewardPool.Delegate ? epoch.signupEnds : epoch.startTimestamp;
    }

    function pastDelegatee(address account, uint256 timepoint) public view returns (address) {
        require(timepoint < block.timestamp, "ERC20: snapshot query for future block");
        return address(uint160(_delegateeHistory[account].upperLookup(uint48(timepoint))));
    }

    function _delegate(address account, address delegatee) internal override {
        super._delegate(account, delegatee);
        _delegateeHistory[account].push(clock(), uint208(uint160(delegatee)));
    }

    function getPastBalance(address account, uint256 timepoint) external view returns (uint256) {
        return _getPastBalance(account, timepoint);
    }

    function _getPastBalance(address account, uint256 timepoint) internal view returns (uint256) {
        uint48 now_ = clock();
        if (timepoint >= now_) revert ERC5805FutureLookup(timepoint, now_);
        return _balanceHistory[account].upperLookup(uint48(timepoint));
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
    // inventory-holding contracts (treasury, vesting) whose held
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

    // Grant/revoke minter rights (e.g. a REP claim). Governance-gated.
    function setMinter(address account, bool allowed) external {
        require(msg.sender == admin || msg.sender == timelockAddress, "RepToken: Caller is not the admin or Timelock");
        minters[account] = allowed;
        emit MinterSet(account, allowed);
    }

    // Mint: admin/timelock (governance proposals) or a whitelisted minter (a REP claim, say).
    function mint(address to, uint256 amount) public {
        require(msg.sender == admin || minters[msg.sender], "RepToken: Not authorized to mint");
        _mint(to, amount);
    }

    // Mint to an account that votes for itself unless it already chose a delegate. Used by claim rails
    // whose recipients must carry their own weight (AutonetRepClaim: agents sign Substrate anchors with it).
    function mintDelegated(address to, uint256 amount) public {
        require(msg.sender == admin || minters[msg.sender], "RepToken: Not authorized to mint");
        if (delegates(to) == address(0)) _delegate(to, to);
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) public {
        require(msg.sender == admin, "RepToken: Only admin can burn");
        _burn(from, amount);
    }

    // Grant/revoke slasher rights (e.g. a tool-verdict contract). Governance-gated.
    function setSlasher(address account, bool allowed) external {
        require(msg.sender == admin || msg.sender == timelockAddress, "RepToken: Caller is not the admin or Timelock");
        slashers[account] = allowed;
        emit SlasherSet(account, allowed);
    }

    // Burn REP as a penalty. Capped at the holder's balance, so a slash never reverts on an
    // account that already lost part of it. What is burned becomes the slasher's credit.
    function slash(address from, uint256 amount) external returns (uint256 burned) {
        require(slashers[msg.sender], "RepToken: Not a slasher");
        uint256 balance = balanceOf(from);
        burned = amount < balance ? amount : balance;
        if (burned > 0) {
            _burn(from, burned);
            slashedCredit[msg.sender] += burned;
        }
        emit Slashed(msg.sender, from, burned);
    }

    // Hand slashed REP to someone else (e.g. the auditors who caught a malicious tool). Mints only
    // out of the slasher's own credit, so a slasher can never create REP, only move it. The
    // recipient votes for itself unless it already chose a delegate.
    function reassign(address to, uint256 amount) external {
        require(slashers[msg.sender], "RepToken: Not a slasher");
        require(amount <= slashedCredit[msg.sender], "RepToken: Exceeds slashed credit");
        slashedCredit[msg.sender] -= amount;
        if (delegates(to) == address(0)) _delegate(to, to);
        _mint(to, amount);
        emit Reassigned(msg.sender, to, amount);
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

    // REP is earned, so voting weight can't be bought: it only moves by mint, burn and slash
    function transfer(address, uint256) public pure override returns (bool) {
        revert("RepToken: Reputation is non-transferable");
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        revert("RepToken: Reputation is non-transferable");
    }

    // Always false. The indexer reads this from every token, older transferable ones included.
    function isTransferable() external pure returns (bool) {
        return false;
    }
}
// RepToken.sol