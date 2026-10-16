// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./IModuleSetup.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title ModuleRepo
/// @notice The published versions of one module (Aragon OSx: PluginRepo). A version is a setup
///         contract tagged RELEASE.BUILD with a build metadata URI; each release has a release
///         metadata URI. A new release marks breaking changes, a new build compatible ones.
///         Builds are immutable once published. The maintainer is the owner.
///
///         Release metadata: { name, description, images }. Build metadata: { ui, change,
///         pluginSetup: { prepareInstallation: { description, inputs }, prepareUninstallation } },
///         where `inputs` is Solidity JSON ABI with a `description` per element (Aragon's format).
///         Apps encode those inputs as the `data` of prepareInstallation.
contract ModuleRepo is Ownable {
    struct Version {
        uint8 release;
        uint16 build;
        address setup;
        string buildMetadata;
    }

    string public name;
    uint8 public latestRelease;
    mapping(uint8 => uint16) public buildCount;
    mapping(uint8 => string) public releaseMetadata;
    mapping(uint8 => mapping(uint16 => Version)) private _versions;
    mapping(address => Version) private _bySetup;

    event VersionCreated(uint8 release, uint16 build, address indexed setup, string buildMetadata);
    event ReleaseMetadataUpdated(uint8 release, string releaseMetadata);

    error BadRelease();
    error WrongModule();
    error SetupAlreadyPublished();
    error UnknownVersion();

    constructor(string memory _name, address maintainer) Ownable(maintainer) {
        name = _name;
    }

    function createVersion(uint8 release, address setup, string calldata buildMetadata, string calldata relMetadata)
        external
        onlyOwner
    {
        if (release == 0 || release > latestRelease + 1) revert BadRelease();
        if (_bySetup[setup].setup != address(0)) revert SetupAlreadyPublished();
        if (keccak256(bytes(IModuleSetup(setup).moduleName())) != keccak256(bytes(name))) revert WrongModule();
        if (release > latestRelease) latestRelease = release;
        uint16 build = ++buildCount[release];
        Version memory v = Version(release, build, setup, buildMetadata);
        _versions[release][build] = v;
        _bySetup[setup] = v;
        emit VersionCreated(release, build, setup, buildMetadata);
        if (bytes(relMetadata).length > 0) _setReleaseMetadata(release, relMetadata);
    }

    function updateReleaseMetadata(uint8 release, string calldata relMetadata) external onlyOwner {
        if (release == 0 || release > latestRelease) revert BadRelease();
        _setReleaseMetadata(release, relMetadata);
    }

    function getVersion(uint8 release, uint16 build) public view returns (Version memory v) {
        v = _versions[release][build];
        if (v.setup == address(0)) revert UnknownVersion();
    }

    /// @notice The latest build of the latest release.
    function latestVersion() external view returns (Version memory) {
        return getVersion(latestRelease, buildCount[latestRelease]);
    }

    function versionOf(address setup) external view returns (Version memory v) {
        v = _bySetup[setup];
        if (v.setup == address(0)) revert UnknownVersion();
    }

    function isPublished(address setup) external view returns (bool) {
        return _bySetup[setup].setup != address(0);
    }

    function _setReleaseMetadata(uint8 release, string calldata relMetadata) private {
        releaseMetadata[release] = relMetadata;
        emit ReleaseMetadataUpdated(release, relMetadata);
    }
}
