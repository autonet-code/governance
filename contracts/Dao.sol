// SPDX-License-Identifier: MIT
// Compatible with OpenZeppelin Contracts ^5.0.0
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/governance/Governor.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorSuperQuorum.sol";
import "./IOptionSource.sol";

/// A proposal is decided as soon as its outcome can't change: it succeeds early once For holds more
/// than half of all REP at the snapshot and meets the quorum, and is defeated early once Against holds
/// half. Otherwise it resolves at the deadline as usual. With liquid delegation a few delegates can
/// settle a proposal in one block, and only the timelock delay remains.
///
/// Options mode: a proposal whose only target is a governance-approved option source is a
/// single-choice election. `support` is the option index, each account votes once, quorum counts
/// all votes cast, and the option with the most votes wins (a tie goes to the lowest optionHash).
/// proposalVotes reports the leading option's tally as For, so it passes early only once the
/// leader alone holds the super quorum, which no other option can then catch.
///
/// Constitutional proposals: a proposal is protected, decided once when it is proposed, if any of its
/// actions (see _isProtected) edits the Autonet charter or epoch rules or the economy's REP rate in a
/// registry, calls the timelock, calls this governor (every governance-only setting: voting delay and period, proposal
/// threshold, quorum, supermajority, option sources, relay, updateTimelock), or calls the governance
/// token for anything but reward epochs (minting, burning, minter and slasher rights, slashing,
/// default delegation, its admin). So attaching or detaching a module that grants token rights is
/// constitutional too. Rights already granted keep working without a vote. It passes only if For holds
/// supermajorityBps of all REP at the snapshot and the quorum is met, so REP that doesn't vote For,
/// delegated or not, counts against. It fails as soon as the bar is out of reach. Option-source
/// elections are never protected: a protected proposal is counted For/Against/Abstain even if its
/// target is a source.
contract HomebaseDAO is Governor, GovernorSettings, GovernorCountingSimple, GovernorVotes, GovernorVotesQuorumFraction, GovernorTimelockControl, GovernorSuperQuorum {
constructor(
        IVotes _token,
        TimelockController _timelock,
        string memory name,
        uint48 minsDelay,
        uint32 minsVoting,
        uint256 pThreshold,
        uint8 qvrm,
        address _launcher,
        uint256 _supermajorityBps
    )
        Governor(name)
        GovernorSettings(minsDelay * 1 minutes, minsVoting * 1 minutes, pThreshold) 
        GovernorVotes(_token)
        GovernorVotesQuorumFraction(qvrm)
        GovernorTimelockControl(_timelock)
    {
        launcher = _launcher;
        _setSupermajority(_supermajorityBps);
    }

    /// Share of all REP at the snapshot, in basis points, a protected proposal needs (5001..10000)
    uint256 public supermajorityBps;
    mapping(uint256 => uint256) private _supermajorityOf;

    bytes32 private constant CHARTER_KEY = keccak256("jurisdiction.autonet.charter");
    bytes32 private constant EPOCH_RULES_KEY = keccak256("jurisdiction.autonet.epoch_rules");
    bytes32 private constant REP_RATE_KEY = keccak256("jurisdiction.economy.rep_rate_bps");
    // The contract addresses every Autonet daemon reads at start: repointing one moves them all
    bytes32 private constant SUBSTRATE_KEY = keccak256("jurisdiction.autonet.substrate");
    bytes32 private constant REP_TOKEN_KEY = keccak256("jurisdiction.autonet.rep_token");
    bytes32 private constant TOOL_BOND_KEY = keccak256("jurisdiction.autonet.tool_bond");
    bytes32 private constant DAO_KEY = keccak256("jurisdiction.autonet.dao");
    bytes32 private constant TIMELOCK_KEY = keccak256("jurisdiction.autonet.timelock");
    bytes4 private constant EDIT_REGISTRY = bytes4(keccak256("editRegistry(string,string)"));
    // The token calls that stay ordinary: reward epochs move treasury funds, not voting power
    bytes4 private constant START_PASSIVE_EPOCH = bytes4(keccak256("startPassiveEpoch(uint256,address)"));
    bytes4 private constant START_DELEGATE_EPOCH = bytes4(keccak256("startDelegateEpoch(uint256,address)"));
    bytes4 private constant SET_DELEGATE_BAR = bytes4(keccak256("setDelegateBar(uint16)"));
    bytes4 private constant BATCH_EDIT_REGISTRY = bytes4(keccak256("batchEditRegistry(string[],string[])"));

    event ProposalSupermajority(uint256 indexed proposalId, uint256 bps);
    event SupermajoritySet(uint256 oldBps, uint256 newBps);
    error InvalidSupermajority(uint256 bps);
    /// The proposal threshold is at least 1 (the smallest unit of REP): proposing, and posting in a
    /// debate (which uses the same bar), takes membership, never nothing
    error InvalidProposalThreshold(uint256 threshold);

    /// Changing the threshold takes a proposal, which is itself protected
    function setSupermajority(uint256 bps) external onlyGovernance {
        _setSupermajority(bps);
    }

    function _setSupermajority(uint256 bps) private {
        if (bps <= 5000 || bps > 10000) revert InvalidSupermajority(bps);
        emit SupermajoritySet(supermajorityBps, bps);
        supermajorityBps = bps;
    }

    /// The supermajority a proposal needs, in basis points, fixed when it was proposed; 0 if unprotected
    function proposalSupermajority(uint256 proposalId) public view returns (uint256) {
        return _supermajorityOf[proposalId];
    }

    /// True if any action is constitutional. Registry edits are recognized on any target: only the
    /// DAO's own Registry obeys this DAO's timelock, and protecting a foreign one costs nothing.
    function _isProtected(address[] memory targets, bytes[] memory calldatas) private view returns (bool) {
        address tl = timelock();
        address tk = address(token());
        for (uint256 i = 0; i < targets.length; i++) {
            address t = targets[i];
            bytes memory d = calldatas[i];
            // The timelock's roles, delay and admin make votes binding; the governor's settings decide
            // how votes run (only governance can call them, so every call here is a settings change)
            if (t == tl || t == address(this)) return true;
            bytes4 s = d.length < 4 ? bytes4(0) : bytes4(d);
            // Voting power: minting, burning, minter and slasher rights, slashing, default delegation, admin
            if (t == tk) {
                if (s != START_PASSIVE_EPOCH && s != START_DELEGATE_EPOCH && s != SET_DELEGATE_BAR) return true;
            } else if (s == EDIT_REGISTRY || s == BATCH_EDIT_REGISTRY) {
                if (_editsProtectedKey(s, d)) return true;
            }
        }
        return false;
    }

    function _editsProtectedKey(bytes4 s, bytes memory d) private pure returns (bool) {
        bytes memory args = new bytes(d.length - 4);
        for (uint256 i = 0; i < args.length; i++) args[i] = d[i + 4];
        string[] memory keys;
        if (s == EDIT_REGISTRY) {
            keys = new string[](1);
            (keys[0], ) = abi.decode(args, (string, string));
        } else {
            (keys, ) = abi.decode(args, (string[], string[]));
        }
        for (uint256 i = 0; i < keys.length; i++) {
            bytes32 k = keccak256(bytes(keys[i]));
            if (k == CHARTER_KEY || k == EPOCH_RULES_KEY || k == REP_RATE_KEY || k == SUBSTRATE_KEY
                || k == REP_TOKEN_KEY || k == TOOL_BOND_KEY || k == DAO_KEY || k == TIMELOCK_KEY) return true;
        }
        return false;
    }

    /// The factory that launched this DAO: it may approve option sources (modules attached at launch)
    /// until the timelock takes this governor as proposer, and never after
    address public immutable launcher;

    mapping(address => bool) public optionSources;
    mapping(uint256 => address) private _sourceOf;
    mapping(uint256 => mapping(uint256 => uint256)) private _optionTally;
    mapping(uint256 => mapping(address => bool)) private _optionVoted;
    mapping(uint256 => uint256) private _optionTotal;
    mapping(uint256 => uint256) private _leader;

    event OptionSourceSet(address indexed source, bool allowed);

    function setOptionSource(address source, bool allowed) external {
        TimelockController t = TimelockController(payable(timelock()));
        if (msg.sender != launcher || t.hasRole(t.PROPOSER_ROLE(), address(this))) _checkGovernance();
        optionSources[source] = allowed;
        emit OptionSourceSet(source, allowed);
    }

    function optionSourceOf(uint256 proposalId) public view returns (address) {
        return _sourceOf[proposalId];
    }

    function optionVotes(uint256 proposalId, uint256 index) external view returns (uint256) {
        return _optionTally[proposalId][index];
    }

    function winningOption(uint256 proposalId) external view returns (bool decided, uint256 index) {
        index = _leader[proposalId];
        if (_sourceOf[proposalId] == address(0)) return (false, 0);
        ProposalState s = state(proposalId);
        decided = s == ProposalState.Succeeded || s == ProposalState.Queued || s == ProposalState.Executed;
    }

    function _propose(address[] memory targets, uint256[] memory values, bytes[] memory calldatas, string memory description, address proposer)
        internal
        override
        returns (uint256 proposalId)
    {
        proposalId = super._propose(targets, values, calldatas, description, proposer);
        if (_isProtected(targets, calldatas)) {
            _supermajorityOf[proposalId] = supermajorityBps;
            emit ProposalSupermajority(proposalId, supermajorityBps);
        } else if (targets.length == 1 && optionSources[targets[0]]) {
            _sourceOf[proposalId] = targets[0];
        }
    }

    function hasVoted(uint256 proposalId, address account) public view override(IGovernor, GovernorCountingSimple) returns (bool) {
        return _optionVoted[proposalId][account] || super.hasVoted(proposalId, account);
    }

    function _countVote(uint256 proposalId, address account, uint8 support, uint256 totalWeight, bytes memory params)
        internal
        override(Governor, GovernorCountingSimple)
        returns (uint256)
    {
        address source = _sourceOf[proposalId];
        if (source == address(0)) return super._countVote(proposalId, account, support, totalWeight, params);
        if (_optionVoted[proposalId][account]) revert GovernorAlreadyCastVote(account);
        if (support >= IOptionSource(source).optionCount(proposalId)) revert GovernorInvalidVoteType();
        _optionVoted[proposalId][account] = true;
        uint256 t = _optionTally[proposalId][support] += totalWeight;
        _optionTotal[proposalId] += totalWeight;
        uint256 lead = _leader[proposalId];
        if (support != lead) {
            uint256 lt = _optionTally[proposalId][lead];
            if (t > lt || (t == lt && IOptionSource(source).optionHash(proposalId, support) < IOptionSource(source).optionHash(proposalId, lead))) {
                _leader[proposalId] = support;
            }
        }
        return totalWeight;
    }

    function _quorumReached(uint256 proposalId) internal view override(Governor, GovernorCountingSimple) returns (bool) {
        if (_sourceOf[proposalId] == address(0)) return super._quorumReached(proposalId);
        return quorum(proposalSnapshot(proposalId)) <= _optionTotal[proposalId];
    }

    function _voteSucceeded(uint256 proposalId) internal view override(Governor, GovernorCountingSimple) returns (bool) {
        if (_sourceOf[proposalId] != address(0)) return _optionTotal[proposalId] > 0;
        uint256 bps = _supermajorityOf[proposalId];
        if (bps == 0) return super._voteSucceeded(proposalId);
        (, uint256 forVotes, ) = proposalVotes(proposalId);
        return forVotes > 0 && forVotes * 10000 >= bps * token().getPastTotalSupply(proposalSnapshot(proposalId));
    }

    function votingDelay()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingDelay();
    }

    function votingPeriod()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingPeriod();
    }

    function quorum(uint256 blockNumber)
        public
        view
        override(Governor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return super.quorum(blockNumber);
    }

    /// More than half of all REP, and never less than the quorum, so an early pass is final
    function superQuorum(uint256 timepoint) public view override returns (uint256) {
        uint256 majority = token().getPastTotalSupply(timepoint) / 2 + 1;
        uint256 q = quorum(timepoint);
        return q > majority ? q : majority;
    }

    function proposalVotes(uint256 proposalId)
        public
        view
        override(GovernorCountingSimple, GovernorSuperQuorum)
        returns (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes)
    {
        if (_sourceOf[proposalId] != address(0)) return (0, _optionTally[proposalId][_leader[proposalId]], 0);
        return super.proposalVotes(proposalId);
    }

    function state(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl, GovernorSuperQuorum)
        returns (ProposalState)
    {
        ProposalState s = super.state(proposalId);
        // Only a vote in progress can change below; the supply at the snapshot is readable only once
        // the snapshot is in the past, so a pending proposal must return here
        if (s != ProposalState.Active) return s;
        uint256 bps = _supermajorityOf[proposalId];
        uint256 supply = token().getPastTotalSupply(proposalSnapshot(proposalId));
        (uint256 againstVotes, , uint256 abstainVotes) = proposalVotes(proposalId);
        if (supply == 0) return s;
        if (bps == 0) {
            // Against holds half of all REP: For can never get ahead
            if (againstVotes * 2 >= supply) return ProposalState.Defeated;
        } else if ((supply - againstVotes - abstainVotes) * 10000 < bps * supply) {
            // Even with all the remaining REP, For can't reach the supermajority
            return ProposalState.Defeated;
        }
        return s;
    }

    function proposalNeedsQueuing(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.proposalNeedsQueuing(proposalId);
    }

    function proposalThreshold()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.proposalThreshold();
    }

    /// At creation (GovernorSettings' constructor) and by proposal (setProposalThreshold)
    function _setProposalThreshold(uint256 newProposalThreshold) internal override {
        if (newProposalThreshold == 0) revert InvalidProposalThreshold(newProposalThreshold);
        super._setProposalThreshold(newProposalThreshold);
    }

    function _queueOperations(uint256 proposalId, address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash)
        internal
        override(Governor, GovernorTimelockControl)
        returns (uint48)
    {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(uint256 proposalId, address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash)
        internal
        override(Governor, GovernorTimelockControl)
    {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash)
        internal
        override(Governor, GovernorTimelockControl)
        returns (uint256)
    {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor()
        internal
        view
        override(Governor, GovernorTimelockControl)
        returns (address)
    {
        return super._executor();
    }
}
