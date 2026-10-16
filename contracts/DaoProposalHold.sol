// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import "./IGovernor.sol";

/// @title DaoProposalHold
/// @notice A project waits for its DAO: anyone (the indexer, or any user when it's down) registers a
///         live DAO proposal that vetoes or overrules this project, and while it is live the project
///         won't let the contractor sign or a ruling finalize. So neither the cooling-off nor the appeal
///         period has to fit a whole proposal lifecycle. A proposal counts as live while it is pending or
///         being voted on, for a grace after it passes until it is queued, and for a grace after its
///         timelock delay until it is executed; a DAO that never queues or executes can't hold forever.
library DaoProposalHold {
    uint256 internal constant GRACE = 1 days;
    uint256 internal constant MAX_HELD = 8;

    bytes4 internal constant VETO = bytes4(keccak256("daoVeto()"));
    bytes4 internal constant OVERRULE = bytes4(keccak256("daoOverrule(uint256,string)"));

    struct Holds {
        uint256[] ids;
        bool overruleFiled; // a registered proposal overrules: its overrule lands even after the window
    }

    event DaoProposalRegistered(uint256 indexed proposalId, bool overrule);

    /// Registers the proposal given in full; reverts unless it is live on [governor] and calls daoVeto
    /// or daoOverrule on [project]. Returns whether it overrules.
    function register(
        Holds storage h,
        address governor,
        address project,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas,
        bytes32 descriptionHash
    ) internal returns (bool overrule) {
        bool about;
        for (uint256 i = 0; i < targets.length; i++) {
            if (targets[i] != project || calldatas[i].length < 4) continue;
            bytes4 sel = bytes4(calldatas[i][:4]);
            if (sel == OVERRULE) overrule = true;
            if (sel == VETO || sel == OVERRULE) about = true;
        }
        require(about, "Proposal doesn't veto or overrule this project");
        uint256 id = IGovernor(governor).hashProposal(targets, values, calldatas, descriptionHash);
        require(isLive(governor, id), "Proposal isn't live");

        // Drop the ones that stopped holding, so dead proposals never fill the list
        uint256 n = h.ids.length;
        for (uint256 i = n; i > 0; i--) {
            uint256 held = h.ids[i - 1];
            require(held != id, "Proposal already registered");
            if (!isLive(governor, held)) {
                h.ids[i - 1] = h.ids[h.ids.length - 1];
                h.ids.pop();
            }
        }
        require(h.ids.length < MAX_HELD, "Too many DAO proposals held");
        h.ids.push(id);
        if (overrule) h.overruleFiled = true;
        emit DaoProposalRegistered(id, overrule);
    }

    /// True while any registered proposal is live
    function holding(Holds storage h, address governor) internal view returns (bool) {
        for (uint256 i = 0; i < h.ids.length; i++) {
            if (isLive(governor, h.ids[i])) return true;
        }
        return false;
    }

    function isLive(address governor, uint256 id) internal view returns (bool) {
        IGovernor g = IGovernor(governor);
        IGovernor.ProposalState s = g.state(id);
        if (s == IGovernor.ProposalState.Pending || s == IGovernor.ProposalState.Active) return true;
        if (s == IGovernor.ProposalState.Succeeded) return block.timestamp <= g.proposalDeadline(id) + GRACE;
        if (s == IGovernor.ProposalState.Queued) return block.timestamp <= g.proposalEta(id) + GRACE;
        return false;
    }
}
