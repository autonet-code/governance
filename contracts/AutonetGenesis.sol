// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./AutonetVault.sol";
import "./AutonetRepClaim.sol";
import "./ToolBond.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/// @title AutonetGenesis
/// @notice Launches the Autonet layer of a jurisdiction in one transaction, between TrustlessFactory's
///         deployDAOToken and configureAndFinalize: the Substrate, AutonetVault, AutonetRepClaim,
///         ToolBond, ServiceRegistry, PaymentChannel, VentureVaultFactory and CharterAnchor (with its
///         genesis charter anchored), wired to the jurisdiction's
///         timelock (governor), Registry (treasury) and RepToken. configureAndFinalize then grants the
///         REP claim minter rights and the bond slasher rights, and records the jurisdiction.autonet.*
///         registry keys, so the layer is live at genesis without a proposal.
///
///         The autonet contracts' creation code is stored on-chain as code blobs fixed when this
///         contract is deployed, so a launcher chooses parameters but never the code.
///
///         The Substrate takes the vault as its minter and the vault takes the Substrate, so the
///         Substrate is created with CREATE2 at an address computed first.
contract AutonetGenesis {
    struct Jurisdiction {
        address payable registry;
        address timelock;
        address repToken;
        address economy;
        address dao;
    }

    struct AutonetParams {
        uint16 anchorQuorumBps;    // Substrate: REP share whose signatures accept an anchor
        address[] genesisSigners;  // Substrate: anchor signers until REP exists
        uint256 genesisQuorum;     // Substrate: genesis signatures an anchor needs
        uint256 challengeWindow;   // PaymentChannel
        bytes32 charterHash;       // CharterAnchor: v1 charter, anchored at construction (0 = none)
        string charterUri;
    }

    struct Deployment {
        address substrate;
        address vault;
        address repClaim;
        address toolBond;
        address serviceRegistry;
        address paymentChannel;
        address ventureVaultFactory;
        address charterAnchor;
    }

    // Code blobs: contracts whose runtime code is 0x00 followed by the creation code
    address public immutable substrateCode;
    address public immutable serviceRegistryCode;
    address public immutable paymentChannelCode;
    address public immutable ventureVaultFactoryCode;
    address public immutable charterAnchorCode;

    event AutonetLaunched(
        address indexed launcher,
        address indexed repToken,
        address timelock,
        Deployment deployment
    );

    /// @notice Each launch by jurisdiction RepToken, with the jurisdiction it was wired to.
    mapping(address => Deployment) private _deployments;
    mapping(address => Jurisdiction) private _jurisdictions;

    error CreateFailed();
    error UnknownLaunch();
    error ZeroAddress();

    constructor(
        address _substrateCode,
        address _serviceRegistryCode,
        address _paymentChannelCode,
        address _ventureVaultFactoryCode,
        address _charterAnchorCode
    ) {
        substrateCode = _substrateCode;
        serviceRegistryCode = _serviceRegistryCode;
        paymentChannelCode = _paymentChannelCode;
        ventureVaultFactoryCode = _ventureVaultFactoryCode;
        charterAnchorCode = _charterAnchorCode;
    }

    function launch(Jurisdiction calldata j, AutonetParams calldata s, ToolBond.Params calldata b)
        external
        returns (Deployment memory d)
    {
        if (j.registry == address(0) || j.timelock == address(0) || j.repToken == address(0)
            || j.economy == address(0) || j.dao == address(0)) {
            revert ZeroAddress();
        }
        bytes32 salt = keccak256(abi.encode(msg.sender, j.repToken));

        // Substrate(treasury, vaultMinter, governor, repToken, anchorQuorumBps, genesisSigners, genesisQuorum)
        // needs the vault, and the vault needs the Substrate: compute the Substrate's address first.
        address vaultAddr = _nextVaultAddress();
        bytes memory substrateInit = abi.encodePacked(_read(substrateCode), abi.encode(
            j.registry, vaultAddr, j.timelock, j.repToken, s.anchorQuorumBps, s.genesisSigners, s.genesisQuorum));
        address substrateAddr = address(uint160(uint256(keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(substrateInit))))));

        d.vault = address(new AutonetVault(substrateAddr, j.registry, j.timelock));
        // The vault is this contract's next plain CREATE, so the predicted minter is the real vault
        if (d.vault != vaultAddr) revert CreateFailed();
        d.substrate = _create2(substrateInit, salt);
        if (d.substrate != substrateAddr) revert CreateFailed();

        d.repClaim = address(new AutonetRepClaim(d.substrate, j.repToken, new address[](0), new uint256[](0)));
        d.toolBond = address(new ToolBond(d.substrate, j.repToken, j.economy, j.timelock, b));
        d.serviceRegistry = _create(abi.encodePacked(_read(serviceRegistryCode), abi.encode(d.substrate)));
        d.paymentChannel = _create(abi.encodePacked(_read(paymentChannelCode), abi.encode(d.substrate, s.challengeWindow)));
        d.ventureVaultFactory = _create(abi.encodePacked(_read(ventureVaultFactoryCode), abi.encode(d.substrate)));
        d.charterAnchor = _create(abi.encodePacked(_read(charterAnchorCode), abi.encode(j.timelock, s.charterHash, s.charterUri)));

        _deployments[j.repToken] = d;
        _jurisdictions[j.repToken] = j;
        emit AutonetLaunched(msg.sender, j.repToken, j.timelock, d);
    }

    function deploymentOf(address repToken) external view returns (Deployment memory) {
        return _deployments[repToken];
    }

    /// @notice The jurisdiction.autonet.* Registry entries for a launch, ready for configureAndFinalize.
    ///         The daemon joins a jurisdiction from these keys alone.
    function registryEntries(address repToken) external view returns (string[] memory keys, string[] memory values) {
        Deployment memory d = _deployments[repToken];
        if (d.substrate == address(0)) revert UnknownLaunch();
        Jurisdiction memory j = _jurisdictions[repToken];
        string[13] memory names = ["substrate", "vault", "rep_claim", "tool_bond", "service_registry",
            "payment_channel", "venture_vault_factory", "charter_anchor", "rep_token", "dao", "timelock",
            "economy", "registry"];
        address[13] memory addrs = [d.substrate, d.vault, d.repClaim, d.toolBond, d.serviceRegistry,
            d.paymentChannel, d.ventureVaultFactory, d.charterAnchor, j.repToken, j.dao, j.timelock,
            j.economy, address(j.registry)];
        keys = new string[](13);
        values = new string[](13);
        for (uint256 i = 0; i < 13; i++) {
            keys[i] = string.concat("jurisdiction.autonet.", names[i]);
            values[i] = Strings.toHexString(addrs[i]);
        }
    }

    // Every CREATE and CREATE2 from this contract bumps its nonce, which started at 1. Each launch
    // creates exactly CREATES_PER_LAUNCH contracts (a failed one reverts the launch), so the count of
    // past launches gives the nonce, and from it the address, of this launch's first create: the vault.
    uint256 private constant CREATES_PER_LAUNCH = 8;
    uint256 public launches;

    function _nextVaultAddress() private returns (address) {
        uint256 nonce = 1 + launches * CREATES_PER_LAUNCH;
        launches++;
        return _createAddress(nonce);
    }

    function _createAddress(uint256 nonce) private view returns (address) {
        bytes memory rlpNonce;
        if (nonce == 0) rlpNonce = hex"80";
        else if (nonce < 0x80) rlpNonce = abi.encodePacked(uint8(nonce));
        else if (nonce < 0x100) rlpNonce = abi.encodePacked(bytes1(0x81), uint8(nonce));
        else if (nonce < 0x10000) rlpNonce = abi.encodePacked(bytes1(0x82), uint16(nonce));
        else if (nonce < 0x1000000) rlpNonce = abi.encodePacked(bytes1(0x83), uint24(nonce));
        else rlpNonce = abi.encodePacked(bytes1(0x84), uint32(nonce));
        bytes memory rlp = abi.encodePacked(bytes1(uint8(0xc0 + 21 + rlpNonce.length)), bytes1(0x94), address(this), rlpNonce);
        return address(uint160(uint256(keccak256(rlp))));
    }

    function _read(address blob) private view returns (bytes memory code) {
        uint256 size = blob.code.length - 1;
        code = new bytes(size);
        assembly {
            extcodecopy(blob, add(code, 0x20), 1, size)
        }
    }

    function _create(bytes memory init) private returns (address addr) {
        assembly {
            addr := create(0, add(init, 0x20), mload(init))
        }
        if (addr == address(0)) revert CreateFailed();
    }

    function _create2(bytes memory init, bytes32 salt) private returns (address addr) {
        assembly {
            addr := create2(0, add(init, 0x20), mload(init), salt)
        }
        if (addr == address(0)) revert CreateFailed();
    }
}
