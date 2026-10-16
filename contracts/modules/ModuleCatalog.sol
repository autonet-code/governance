// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./ModuleRepo.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title ModuleCatalog
/// @notice The modules a network offers (Aragon OSx: PluginRepoRegistry): one ModuleRepo per
///         module name. Apps read the catalog to list modules and their versions, so a new module
///         or version needs no app release. The curator (owner) adds and removes repos; setups
///         outside the catalog can't be installed through JurisdictionFactory or ModuleProcessor,
///         since attaching a module grants whatever its setup lists.
contract ModuleCatalog is Ownable {
    string[] private _names;
    mapping(string => ModuleRepo) public repoOf;

    event RepoRegistered(string name, address repo);
    event RepoRemoved(string name, address repo);

    error NameTaken();
    error UnknownRepo();

    constructor(address curator) Ownable(curator) {}

    function register(ModuleRepo repo) external onlyOwner {
        string memory name = repo.name();
        if (address(repoOf[name]) != address(0)) revert NameTaken();
        repoOf[name] = repo;
        _names.push(name);
        emit RepoRegistered(name, address(repo));
    }

    function remove(string calldata name) external onlyOwner {
        ModuleRepo repo = repoOf[name];
        if (address(repo) == address(0)) revert UnknownRepo();
        delete repoOf[name];
        for (uint256 i = 0; i < _names.length; i++) {
            if (keccak256(bytes(_names[i])) == keccak256(bytes(name))) {
                _names[i] = _names[_names.length - 1];
                _names.pop();
                break;
            }
        }
        emit RepoRemoved(name, address(repo));
    }

    function names() external view returns (string[] memory) {
        return _names;
    }

    /// @notice Whether `setup` is a published version of a module in the catalog.
    function isPublished(address setup) public view returns (bool) {
        try IModuleSetup(setup).moduleName() returns (string memory name) {
            ModuleRepo repo = repoOf[name];
            return address(repo) != address(0) && repo.isPublished(setup);
        } catch {
            return false;
        }
    }
}
