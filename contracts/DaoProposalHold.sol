// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import "./IGovernor.sol";

/// @title DaoProposalHold
/// @notice A contract waits for its DAO without keeping a list: anyone (the indexer, or any user when
///         it's down) registers a live DAO proposal about it inside a window, and the contract keeps
///         one timestamp, the latest moment any registered proposal could still land. It is computed
///         from the proposal itself at registration: its vote deadline, a grace to queue, the
///         timelock delay and a grace to execute, or its eta and the execution grace once queued.
///         Registering costs a few reads and checking the hold costs none, however many are filed.
library DaoProposalHold {
    uint256 internal constant GRACE = 1 days;

    bytes4 internal constant VETO = bytes4(keccak256("daoVeto()"));
    bytes4 internal constant OVERRULE = bytes4(keccak256("daoOverrule(uint256,string)"));

    /// Whether the calls veto or overrule [project], and whether they overrule it
    function projectCalls(address project, address[] calldata targets, bytes[] calldata calldatas)
        internal pure returns (bool about, bool overrule)
    {
        for (uint256 i = 0; i < targets.length; i++) {
            if (targets[i] != project || calldatas[i].length < 4) continue;
            bytes4 sel = bytes4(calldatas[i][:4]);
            if (sel == OVERRULE) overrule = true;
            if (sel == VETO || sel == OVERRULE) about = true;
        }
    }

    function proposalId(
        address governor,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas,
        bytes32 descriptionHash
    ) internal pure returns (uint256) {
        return IGovernor(governor).hashProposal(targets, values, calldatas, descriptionHash);
    }

    /// Reverts unless proposal [id] is live on [governor]; returns when it could last land
    function holdUntil(address governor, address timelock, uint256 id) internal view returns (uint256) {
        IGovernor g = IGovernor(governor);
        IGovernor.ProposalState s = g.state(id);
        if (s == IGovernor.ProposalState.Queued) {
            uint256 eta = g.proposalEta(id);
            require(block.timestamp <= eta + GRACE, "Proposal isn't live");
            return eta + GRACE;
        }
        uint256 deadline = g.proposalDeadline(id);
        require(
            s == IGovernor.ProposalState.Pending || s == IGovernor.ProposalState.Active ||
            (s == IGovernor.ProposalState.Succeeded && block.timestamp <= deadline + GRACE),
            "Proposal isn't live"
        );
        return deadline + GRACE + _minDelay(timelock) + GRACE;
    }

    function _minDelay(address timelock) private view returns (uint256) {
        if (timelock.code.length == 0) return 0;
        (bool ok, bytes memory data) = timelock.staticcall(abi.encodeWithSignature("getMinDelay()"));
        return ok && data.length >= 32 ? abi.decode(data, (uint256)) : 0;
    }
}
