// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

/// @title ProposalLifecycle
/// @notice How long a DAO proposal takes at least: voting delay, voting period and timelock delay,
///         read live so a governance change to them applies at once. Verdict contracts that the DAO
///         overrules by proposal keep their appeal window at least this long plus APPEAL_BUFFER.
library ProposalLifecycle {
    // A day to propose after the verdict and a day to execute after the vote
    uint256 internal constant APPEAL_BUFFER = 2 days;

    function total(address governor, address timelock) internal view returns (uint256 t) {
        t += _readUint(governor, "votingDelay()");
        t += _readUint(governor, "votingPeriod()");
        t += _readUint(timelock, "getMinDelay()");
    }

    /// The appeal window to use: [period], or one lifecycle plus the buffer if that is longer
    function appealWindow(uint256 period, address governor, address timelock) internal view returns (uint256) {
        uint256 floor = total(governor, timelock) + APPEAL_BUFFER;
        return period > floor ? period : floor;
    }

    function _readUint(address target, string memory signature) private view returns (uint256) {
        if (target.code.length == 0) return 0;
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature(signature));
        return ok && data.length >= 32 ? abi.decode(data, (uint256)) : 0;
    }
}
