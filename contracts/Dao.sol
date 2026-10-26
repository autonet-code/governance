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
contract HomebaseDAO is Governor, GovernorSettings, GovernorCountingSimple, GovernorVotes, GovernorVotesQuorumFraction, GovernorTimelockControl, GovernorSuperQuorum {
constructor(
        IVotes _token,
        TimelockController _timelock,
        string memory name,
        uint48 minsDelay,
        uint32 minsVoting,
        uint256 pThreshold,
        uint8 qvrm,
        address _launcher
    )
        Governor(name)
        GovernorSettings(minsDelay * 1 minutes, minsVoting * 1 minutes, pThreshold) 
        GovernorVotes(_token)
        GovernorVotesQuorumFraction(qvrm)
        GovernorTimelockControl(_timelock)
    {
        launcher = _launcher;
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
        if (targets.length == 1 && optionSources[targets[0]]) _sourceOf[proposalId] = targets[0];
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
        if (_sourceOf[proposalId] == address(0)) return super._voteSucceeded(proposalId);
        return _optionTotal[proposalId] > 0;
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
        if (s != ProposalState.Active) return s;
        // Against holds half of all REP: For can never get ahead
        (uint256 againstVotes, , ) = proposalVotes(proposalId);
        uint256 supply = token().getPastTotalSupply(proposalSnapshot(proposalId));
        if (supply > 0 && againstVotes * 2 >= supply) return ProposalState.Defeated;
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
