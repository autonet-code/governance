// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title MockAutonetATN
 * @notice Minimal stand-in for the Autonet network's Substrate ATN contract,
 *         implementing exactly the IAutonetATN surface the AutonetVault consumes
 *         (`mintFromVault`). ATN is 6-decimal (1e6-scaled); this mock tracks a
 *         plain balance mapping so tests can assert base-unit amounts.
 *
 * In production, Substrate.sol implements mintFromVault and gates it to the
 * vault address. This mock leaves it open (the vault is the only caller in
 * tests) and records the last minter so a "only vault mints" gate could be
 * asserted if desired.
 */
contract MockAutonetATN {
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    address public lastMinter;

    event VaultMint(address indexed minter, address indexed to, uint256 amount);

    function mintFromVault(address to, uint256 amount) external {
        lastMinter = msg.sender;
        balanceOf[to] += amount;
        totalSupply += amount;
        emit VaultMint(msg.sender, to, amount);
    }
}
