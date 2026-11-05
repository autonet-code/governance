// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IBuyReenter {
    function buy(address paymentToken, uint256 paymentAmount) external returns (uint256);
}

/**
 * @title ReentrantPaymentToken
 * @notice Malicious ERC20 used only in tests: on transferFrom it tries to
 *         re-enter the AutonetVault.buy() function to prove the nonReentrant
 *         guard holds.
 */
contract ReentrantPaymentToken is ERC20 {
    address public immutable co;
    address public victimPaymentToken;
    bool public armed;

    constructor(address _co) ERC20("Evil", "EVL") {
        co = _co;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function armReentrancy(address _victimPaymentToken) external {
        victimPaymentToken = _victimPaymentToken;
        armed = true;
    }

    function transferFrom(address from, address to, uint256 value)
        public
        override
        returns (bool)
    {
        if (armed) {
            armed = false; // prevent infinite loop; one shot
            // Re-enter buy with a different (registered) token.
            IBuyReenter(co).buy(victimPaymentToken, 1);
        }
        return super.transferFrom(from, to, value);
    }
}
