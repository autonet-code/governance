// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../AutonetVault.sol";
import "../AutonetRepClaim.sol";
import "../ToolBond.sol"; // for ToolBond.Params; the code itself comes from a blob
import "./ModuleSetup.sol";

/// @title AutonetSetup
/// @notice The `autonet` module: a jurisdiction's whole Autonet layer in one transaction. The
///         Substrate, AutonetVault, AutonetRepClaim, ToolBond, ServiceRegistry, PaymentChannel and
///         VentureVaultFactory, wired to the jurisdiction's timelock (governor), Registry (treasury)
///         and RepToken. Attaching it grants the REP claim minter rights and the bond slasher rights,
///         and records the jurisdiction.autonet.* entries the daemon joins a jurisdiction from,
///         including the charter (jurisdiction.autonet.charter and .charter_uri), which the DAO
///         changes by proposal like any registry entry.
///
///         The autonet contracts' creation code is stored on-chain as code blobs fixed when this
///         contract is deployed, so a preparer chooses parameters but never the code.
///
///         The Substrate takes the vault as its minter and the vault takes the Substrate, so the
///         Substrate is created with CREATE2 at an address computed first.
contract AutonetSetup is ModuleSetup {
    struct AutonetParams {
        uint16 anchorQuorumBps;    // Substrate: REP share whose signatures accept an anchor
        address[] genesisSigners;  // Substrate: anchor signers until REP exists
        uint256 genesisQuorum;     // Substrate: genesis signatures an anchor needs
        uint256 challengeWindow;   // PaymentChannel
        bytes32 charterHash;       // sha256 of the canonical charter the daemons follow (0 = none recorded)
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
        bytes32 charterHash;
        string charterUri;
    }

    // Code blobs: contracts whose runtime code is 0x00 followed by the creation code
    address public immutable substrateCode;
    address public immutable serviceRegistryCode;
    address public immutable paymentChannelCode;
    address public immutable ventureVaultFactoryCode;
    address public immutable toolBondCode;

    mapping(uint256 => Deployment) private _deployments;

    error CreateFailed();

    constructor(
        address _substrateCode,
        address _serviceRegistryCode,
        address _paymentChannelCode,
        address _ventureVaultFactoryCode,
        address _toolBondCode
    ) {
        substrateCode = _substrateCode;
        serviceRegistryCode = _serviceRegistryCode;
        paymentChannelCode = _paymentChannelCode;
        ventureVaultFactoryCode = _ventureVaultFactoryCode;
        toolBondCode = _toolBondCode;
    }

    function moduleName() public pure override returns (string memory) {
        return "autonet";
    }

    function deploymentOf(uint256 id) external view returns (Deployment memory) {
        return _deployments[id];
    }

    /// @param data abi.encode(AutonetParams, ToolBond.Params)
    function _prepare(uint256 id, Core calldata core, bytes calldata data) internal override returns (address) {
        (AutonetParams memory s, ToolBond.Params memory b) = abi.decode(data, (AutonetParams, ToolBond.Params));
        bytes32 salt = bytes32(id);
        Deployment memory d;
        (d.charterHash, d.charterUri) = (s.charterHash, s.charterUri);

        // Substrate(treasury, vaultMinter, governor, repToken, anchorQuorumBps, genesisSigners, genesisQuorum)
        // needs the vault, and the vault needs the Substrate: compute the Substrate's address first.
        address vaultAddr = _createAddress(1 + (id - 1) * CREATES_PER_LAUNCH);
        bytes memory substrateInit = abi.encodePacked(_read(substrateCode), abi.encode(
            core.registry, vaultAddr, core.timelock, core.token, s.anchorQuorumBps, s.genesisSigners, s.genesisQuorum));
        address substrateAddr = address(uint160(uint256(keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(substrateInit))))));

        d.vault = address(new AutonetVault(substrateAddr, core.registry, core.timelock));
        // The vault is this contract's next plain CREATE, so the predicted minter is the real vault
        if (d.vault != vaultAddr) revert CreateFailed();
        d.substrate = _create2(substrateInit, salt);
        if (d.substrate != substrateAddr) revert CreateFailed();

        d.repClaim = address(new AutonetRepClaim(d.substrate, core.token, new address[](0), new uint256[](0)));
        d.toolBond = _create(abi.encodePacked(_read(toolBondCode), abi.encode(d.substrate, core.token, core.governor, core.timelock, b)));
        d.serviceRegistry = _create(abi.encodePacked(_read(serviceRegistryCode), abi.encode(d.substrate)));
        d.paymentChannel = _create(abi.encodePacked(_read(paymentChannelCode), abi.encode(d.substrate, s.challengeWindow)));
        d.ventureVaultFactory = _create(abi.encodePacked(_read(ventureVaultFactoryCode), abi.encode(d.substrate)));

        _deployments[id] = d;
        return d.substrate;
    }

    function _describe(uint256 id, Core memory core, Prepared memory p) internal view override {
        Deployment memory d = _deployments[id];
        p.helpers = new address[](6);
        (p.helpers[0], p.helpers[1], p.helpers[2], p.helpers[3]) = (d.vault, d.repClaim, d.toolBond, d.serviceRegistry);
        (p.helpers[4], p.helpers[5]) = (d.paymentChannel, d.ventureVaultFactory);
        _repGrants(p, core.token, _one(d.repClaim), _one(d.toolBond));
        string[11] memory n = ["substrate", "vault", "rep_claim", "tool_bond", "service_registry",
            "payment_channel", "venture_vault_factory", "rep_token", "dao", "timelock", "registry"];
        address[11] memory a = [d.substrate, d.vault, d.repClaim, d.toolBond, d.serviceRegistry,
            d.paymentChannel, d.ventureVaultFactory, core.token, core.governor, core.timelock, address(core.registry)];
        bool charter = d.charterHash != bytes32(0);
        string[] memory names = new string[](11);
        address[] memory addrs = new address[](11);
        for (uint256 i = 0; i < 11; i++) (names[i], addrs[i]) = (n[i], a[i]);
        _entries(p, "jurisdiction.autonet.", names, addrs);
        if (!charter) return;
        // The charter: hash as 0x + 64 lowercase hex, like the address entries
        string[] memory keys = new string[](13);
        string[] memory values = new string[](13);
        for (uint256 i = 0; i < 11; i++) (keys[i], values[i]) = (p.registryKeys[i], p.registryValues[i]);
        (keys[11], values[11]) = ("jurisdiction.autonet.charter", Strings.toHexString(uint256(d.charterHash), 32));
        (keys[12], values[12]) = ("jurisdiction.autonet.charter_uri", d.charterUri);
        (p.registryKeys, p.registryValues) = (keys, values);
    }

    // Every CREATE and CREATE2 from this contract bumps its nonce, which started at 1. Each launch
    // creates exactly CREATES_PER_LAUNCH contracts (a failed one reverts the launch), so the count of
    // past launches gives the nonce, and from it the address, of this launch's first create: the vault.
    uint256 private constant CREATES_PER_LAUNCH = 7;

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
