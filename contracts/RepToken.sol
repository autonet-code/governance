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

/// The one Substrate call the delegate pool needs: the owner wallet an agent key is bound to
interface IAgentOwnerSource {
    function getAgentOwner(address agent) external view returns (address);
}

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
    // snapshot, whatever the holder delegated. The delegate pool pays any delegate whose weight
    // received from others at the snapshot reaches the bar, a share of all REP. Each pays
    // budget * received / total REP, so the budget is a ceiling and what isn't earned stays reclaimable.
    enum RewardPool { Passive, Delegate }

    struct RewardEpoch {
        uint256 budget;
        address paymentToken;
        uint48 startTimestamp;
        RewardPool pool;
        uint16 delegateBarBps; // delegate pool: the bar, fixed at the start
    }

    uint16 public delegateBarBps = 100; // 1% of all REP

    uint256 public currentRewardEpoch;
    mapping(uint256 => RewardEpoch) public rewardEpochs;
    mapping(uint256 => mapping(address => bool)) public hasClaimedReward;

    mapping(address => Checkpoints.Trace208) private _delegateeHistory;

    event NewRewardEpoch(uint256 indexed epochId, RewardPool pool, uint256 budget, address indexed paymentToken, uint16 delegateBarBps);
    event RewardClaimed(address indexed account, uint256 indexed epochId, uint256 amount);
    event DelegateBarSet(uint16 delegateBarBps);

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

    function setDelegateBar(uint16 newBarBps) external {
        require(msg.sender == timelockAddress, "RepToken: Only Timelock can set the delegate bar");
        require(newBarBps <= 10000, "RepToken: Delegate bar too high");
        delegateBarBps = newBarBps;
        emit DelegateBarSet(newBarBps);
    }

    function rewardPurpose(uint256 epochId, address paymentToken) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("REWARD", epochId, paymentToken));
    }

    // Starts a passive pool and reserves its budget in the registry in the same call.
    function startPassiveEpoch(uint256 budget, address paymentToken) external {
        _startEpoch(budget, paymentToken, RewardPool.Passive, 0);
    }

    // Starts a delegate pool and its reservation. The epoch keeps today's bar.
    function startDelegateEpoch(uint256 budget, address paymentToken) external {
        _startEpoch(budget, paymentToken, RewardPool.Delegate, delegateBarBps);
    }

    function _startEpoch(uint256 budget, address paymentToken, RewardPool pool, uint16 barBps) private {
        require(msg.sender == timelockAddress, "RepToken: Only Timelock can start an epoch");
        require(budget > 0, "RepToken: Empty budget");
        currentRewardEpoch++;
        rewardEpochs[currentRewardEpoch] = RewardEpoch({
            budget: budget,
            paymentToken: paymentToken,
            startTimestamp: clock(),
            pool: pool,
            delegateBarBps: barBps
        });
        Registry(registryAddress).earmarkFunds(rewardPurpose(currentRewardEpoch, paymentToken), budget, paymentToken);
        emit NewRewardEpoch(currentRewardEpoch, pool, budget, paymentToken, barBps);
    }

    /// Where an installed Autonet records its Substrate, which binds agent keys to owner wallets
    string public constant SUBSTRATE_KEY = "jurisdiction.autonet.substrate";

    // The voting weight others gave an account: its votes, less its own REP if it delegated to itself,
    // and less its owner's REP if it is an Autonet operator its owner delegated to (one household).
    function receivedWeight(address account, uint256 timepoint) public view returns (uint256) {
        uint256 votes = getPastVotes(account, timepoint);
        if (pastDelegatee(account, timepoint) == account) votes -= _getPastBalance(account, timepoint);
        address owner = _agentOwner(account);
        if (owner != address(0) && owner != account && pastDelegatee(owner, timepoint) == account) {
            uint256 own = _getPastBalance(owner, timepoint);
            votes = own < votes ? votes - own : 0;
        }
        return votes;
    }

    // The owner wallet the Substrate binds [account] to, or none without Autonet or a binding. The
    // binding is the current one, not one at the snapshot.
    function _agentOwner(address account) private view returns (address) {
        (bool ok, address substrate) = Strings.tryParseAddress(Registry(registryAddress).getRegistryValue(SUBSTRATE_KEY));
        if (!ok || substrate.code.length == 0) return address(0);
        try IAgentOwnerSource(substrate).getAgentOwner(account) returns (address owner) {
            return owner;
        } catch {
            return address(0);
        }
    }

    // An account's reward, all read at the snapshot before the epoch.
    function rewardOf(uint256 epochId, address account) public view returns (uint256) {
        RewardEpoch memory epoch = rewardEpochs[epochId];
        require(epochId > 0 && epochId <= currentRewardEpoch, "RepToken: Invalid epoch ID");
        uint256 snapshot = epoch.startTimestamp - 1;
        uint256 totalReputation = getPastTotalSupply(snapshot);
        if (totalReputation == 0) return 0;
        if (epoch.pool == RewardPool.Passive) return (_getPastBalance(account, snapshot) * epoch.budget) / totalReputation;
        uint256 received = receivedWeight(account, snapshot);
        if (received * 10000 < uint256(epoch.delegateBarBps) * totalReputation) return 0;
        return (received * epoch.budget) / totalReputation;
    }

    function claimReward(uint256 epochId) external {
        require(!hasClaimedReward[epochId][msg.sender], "RepToken: Already claimed for this epoch");
        uint256 rewardAmount = rewardOf(epochId, msg.sender);
        require(rewardAmount > 0, "RepToken: Reward amount is zero");
        hasClaimedReward[epochId][msg.sender] = true;
        RewardEpoch memory epoch = rewardEpochs[epochId];
        Registry(registryAddress).disburseEarmarked(msg.sender, rewardAmount, rewardPurpose(epochId, epoch.paymentToken), epoch.paymentToken);
        emit RewardClaimed(msg.sender, epochId, rewardAmount);
    }

    // --- GETTERS & CONFIG ---
    function getRewardEpochStart(uint256 epochId) external view override returns (uint48) {
        return rewardEpochs[epochId].startTimestamp;
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