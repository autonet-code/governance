// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockSubstrate} from "./MockSubstrate.sol";
import {MockAutonetATN} from "./MockAutonetATN.sol";

/// @notice Genesis-flow test double: ONE address serving BOTH Substrate surfaces
///         the jurisdiction satellites consume, exactly like the real
///         autonet Substrate.sol does:
///           - IAutonetATN.mintFromVault      (AutonetVault mints ATN here)
///           - ISubstrateReputation reads     (ReputationMirror reads
///             agentReputation / getAgentOwner here)
///         In production both satellites are constructed with the SAME
///         SUBSTRATE_ADDRESS; this mock preserves that topology in tests.
contract MockGenesisSubstrate is MockSubstrate, MockAutonetATN {}
