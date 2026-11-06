// contracts/Registry.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import {IJurisdictionData} from "./IJurisdictionData.sol"; // <-- ADDED IMPORT

contract Registry is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    mapping (string => string) private reg;
    string[] private keys;
    mapping (string => bool) private listed; // a key cleared to "" stays listed, so it's never pushed twice
    address public owner;
    // The owner changes once, when the factory hands the Registry to the timelock; never again,
    // so no vote can move the charter and the treasury out of the DAO's protected proposals
    bool public ownershipHandedOver;
    address public wrapper;
    address public jurisdictionAddress;
    mapping(bytes32 => uint256) public earmarkedFunds;
    // Earmarks reserve real balance: the per-token total can't be over-committed or spent
    // by ordinary transfers. NATIVE_TOKEN stands for the chain's native currency.
    mapping(bytes32 => address) public earmarkToken;
    mapping(address => uint256) public totalEarmarked;
    // Purposes earmarked by the jurisdiction (reward epochs); see withdrawEarmarkedFunds.
    mapping(bytes32 => bool) public rewardEarmark;

    // ---------------------------------------------------------------------
    // TREASURY-SPEND GUARD (rolling-window rate limit)
    // ---------------------------------------------------------------------
    // Time-diffused, absolute (not percent-of-balance) cap on treasury
    // outflows so that even a captured vote cannot drain the treasury faster
    // than the build cadence. Metered per token over a fixed rolling window.
    //
    // Pattern: classic rolling-window absolute cap. On each metered spend we
    // lazily roll the window forward if it has elapsed, then accumulate the
    // amount and require the running total stays <= maxPerWindow[token].
    //
    // Sentinel: native ETH is metered under NATIVE_TOKEN.
    //
    // DEFAULT-OPEN per token: maxPerWindow[token] == 0 means UNMETERED for
    // that token. This preserves all existing behavior on already-deployed
    // registries (no cap until governance opts a token in) and avoids
    // bricking outflows the moment this code ships. Governance sets a cap
    // per token via setSpendCap() to arm the guard. Caps pair with the
    // timelock: destructive powers lean on the timelock for delay, this
    // guard bounds throughput regardless of vote outcome.
    //
    // OPERATOR NOTE (fixed-window boundary property): this is a FIXED window,
    // not a sliding one. The worst-case throughput across a window boundary is
    // up to 2x the cap in an arbitrarily short interval (spend the full cap just
    // before the window rolls, then the full cap again just after). This is
    // inherent to fixed-window limiters. Size `maxPerWindow` at HALF the true
    // tolerable burst, and rely on the timelock delay for additional cover. If a
    // hard single-window bound is ever required, upgrade to a sliding-window /
    // token-bucket accumulator. ERC721 transfers are intentionally unmetered
    // (an absolute fungible cap does not map to NFTs).
    // ---------------------------------------------------------------------

    /// @notice Sentinel address used to meter native ETH outflows.
    address public constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @notice Rolling-window length (seconds) shared by all metered tokens.
    ///         Defaults to ~the build cadence; governance-tunable.
    uint256 public windowDuration = 7 days;

    /// @notice Per-token absolute cap on spend within one window. 0 == unmetered.
    mapping(address => uint256) public maxPerWindow;
    /// @notice Per-token timestamp at which the current window opened.
    mapping(address => uint256) public windowStart;
    /// @notice Per-token amount already spent within the current window.
    mapping(address => uint256) public spentInWindow;

    modifier _treasuryOps(){
         require(msg.sender == owner , "Only the DAO can make transfers");
        _;
    }

    modifier _regedit() {
        require(msg.sender == owner || msg.sender==wrapper, "Only the DAO can edit registry");
        _;
    }

    event ReceivedETH(address indexed from, uint256 amount);
    event ReceivedERC721(address indexed from, address indexed token, uint256 tokenId);
    event TransferredETH(address indexed to, uint256 amount);
    event TransferredERC20(address indexed token, address indexed to, uint256 amount);
    event TransferredERC721(address indexed token, address indexed to, uint256 tokenId);

    event JurisdictionAddressSet(address indexed jurisdiction);
    event FundsEarmarked(bytes32 indexed purpose, uint256 amount);
    event EarmarkedFundsWithdrawn(bytes32 indexed purpose, uint256 amount);
    event EarmarkedFundsDisbursed(address indexed recipient, bytes32 indexed purpose, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // Spend-guard events
    event SpendCapSet(address indexed token, uint256 maxPerWindow);
    event WindowDurationSet(uint256 windowDuration);
    event SpendWindowReset(address indexed token, uint256 windowStart);


     receive() external payable {
        emit ReceivedETH(msg.sender, msg.value);
    }
     function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external override returns (bytes4) {
        operator; data;
        emit ReceivedERC721(from, msg.sender, tokenId);
        return this.onERC721Received.selector;
    }

    // ---------------------------------------------------------------------
    // Spend-guard internals & governance setters
    // ---------------------------------------------------------------------

    /**
     * @notice Governance setter: arm/disarm/adjust the rolling-window cap for a token.
     * @dev Use NATIVE_TOKEN as `token` to meter native ETH. Set `cap` to 0 to
     *      disable metering for that token. Adjusting the cap does NOT reset the
     *      window or already-accrued spend; a lowered cap can therefore cause the
     *      remainder of the current window to be unavailable, which is intentional.
     */
    function setSpendCap(address token, uint256 cap) external _treasuryOps {
        maxPerWindow[token] = cap;
        emit SpendCapSet(token, cap);
    }

    /**
     * @notice Governance setter: change the shared rolling-window duration.
     * @dev Applies to subsequent window rolls for every token. Must be > 0.
     */
    function setWindowDuration(uint256 duration) external _treasuryOps {
        require(duration > 0, "Registry: window duration must be > 0");
        windowDuration = duration;
        emit WindowDurationSet(duration);
    }

    /**
     * @notice Read remaining spendable amount for `token` in the current window.
     * @dev View-only; accounts for a window that has elapsed (would reset on spend).
     *      Returns type(uint256).max when the token is unmetered.
     */
    function remainingInWindow(address token) external view returns (uint256) {
        uint256 cap = maxPerWindow[token];
        if (cap == 0) {
            return type(uint256).max;
        }
        // If the window has elapsed, a spend would reset it: full cap available.
        if (block.timestamp >= windowStart[token] + windowDuration) {
            return cap;
        }
        uint256 spent = spentInWindow[token];
        return spent >= cap ? 0 : cap - spent;
    }

    /**
     * @dev Core rolling-window meter. Lazily rolls the window forward when it has
     *      elapsed, then accumulates `amount` and enforces the per-token cap.
     *      No-op (always passes) for unmetered tokens (cap == 0).
     */
    function _meterSpend(address token, uint256 amount) internal {
        uint256 cap = maxPerWindow[token];
        if (cap == 0) {
            // Unmetered token: preserve original unconstrained behavior.
            return;
        }

        // Roll the window forward if the current one has fully elapsed.
        // Uses >= so a window of exactly `windowDuration` seconds resets cleanly.
        if (block.timestamp >= windowStart[token] + windowDuration) {
            windowStart[token] = block.timestamp;
            spentInWindow[token] = 0;
            emit SpendWindowReset(token, block.timestamp);
        }

        uint256 newSpent = spentInWindow[token] + amount;
        require(newSpent <= cap, "Registry: spend exceeds rolling-window cap");
        spentInWindow[token] = newSpent;
    }

    function transferETH(address payable to, uint256 amount) _treasuryOps external nonReentrant {
        require(address(this).balance >= amount, "Insufficient balance");
        _requireUnreserved(NATIVE_TOKEN, amount);
        _meterSpend(NATIVE_TOKEN, amount);
        (bool sent, ) = to.call{value: amount}("");
        require(sent, "Native transfer failed");
        emit TransferredETH(to, amount);
    }

    function transferERC20(
        address token,
        address to,
        uint256 amount
    ) external _treasuryOps nonReentrant {
        _requireUnreserved(token, amount);
        _meterSpend(token, amount);
        IERC20(token).safeTransfer(to, amount);
        emit TransferredERC20(token, to, amount);
    }

    function transferERC721(
        address token,
        address to,
        uint256 tokenId
    ) external _treasuryOps {
        // ERC721 is intentionally UNMETERED: the rolling-window cap is an
        // absolute (fungible) rate limit and does not apply to NFTs.
        IERC721(token).safeTransferFrom(address(this), to, tokenId);
        emit TransferredERC721(token, to, tokenId);
    }

    constructor(address _owner, address _wrapper) {
        require(_owner != address(0), "Owner address cannot be zero");
        owner = _owner;
        wrapper=_wrapper;
    }

    event RegistryUpdated(string  key, string  value);

    /// The factory's handover to the timelock at creation, the only ownership change there is
    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "Only the current owner can transfer ownership");
        require(!ownershipHandedOver, "Registry: ownership was already handed over");
        require(newOwner != address(0), "New owner cannot be the zero address");
        ownershipHandedOver = true;
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function editRegistry(string memory key, string memory value) public _regedit {
        if (!listed[key]) {
            listed[key] = true;
            keys.push(key);
        }
        reg[key] = value;
        emit RegistryUpdated(key, value);
    }

    function batchEditRegistry(string[] memory newKeys, string[] memory values) public _regedit {
        require(newKeys.length == values.length, "Registry: Length mismatch");
        for (uint256 i = 0; i < newKeys.length; i++) {
            string memory key = newKeys[i];
            string memory value = values[i];
            if (!listed[key]) {
                listed[key] = true;
                keys.push(key);
            }
            reg[key] = value;
            emit RegistryUpdated(key, value);
        }
    }

    function getRegistryValue(string memory key) public view returns (string memory) {
        return reg[key];
    }

    function getAllKeys() public view returns (string[] memory) {
        return keys;
    }

    function getAllValues() public view returns (string[] memory) {
        string[] memory values = new string[](keys.length);
        for (uint i = 0; i < keys.length; i++) {
            values[i] = reg[keys[i]];
        }
        return values;
    }

    function setJurisdictionAddress(address _jurisdictionAddress) external _regedit {
        require(_jurisdictionAddress != address(0), "Jurisdiction address cannot be zero");
        jurisdictionAddress = _jurisdictionAddress;
        emit JurisdictionAddressSet(_jurisdictionAddress);
    }

    function _balanceOf(address token) internal view returns (uint256) {
        return token == NATIVE_TOKEN ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    function _requireUnreserved(address token, uint256 amount) internal view {
        require(_balanceOf(token) >= totalEarmarked[token] + amount, "Registry: Funds are earmarked");
    }

    function _release(bytes32 purpose, uint256 amount) internal {
        earmarkedFunds[purpose] -= amount;
        totalEarmarked[earmarkToken[purpose]] -= amount;
    }

    // The jurisdiction earmarks reward epoch budgets as it starts them (itself timelock-gated).
    function earmarkFunds(bytes32 purpose, uint256 amount, address tokenAddress) external {
        require(msg.sender == owner || msg.sender == jurisdictionAddress, "Only the DAO can earmark funds");
        address existing = earmarkToken[purpose];
        require(existing == address(0) || existing == tokenAddress, "Registry: Purpose bound to another token");
        require(_balanceOf(tokenAddress) >= totalEarmarked[tokenAddress] + amount, "Cannot earmark more than available balance");
        earmarkToken[purpose] = tokenAddress;
        if (msg.sender == jurisdictionAddress) rewardEarmark[purpose] = true;
        earmarkedFunds[purpose] += amount;
        totalEarmarked[tokenAddress] += amount;
        emit FundsEarmarked(purpose, amount);
    }

    // Reward epoch budgets can only come back through reclaimEarmarkedFunds, after the claim grace period.
    function withdrawEarmarkedFunds(bytes32 purpose, uint256 amount) external _treasuryOps {
        require(!rewardEarmark[purpose], "Registry: Reward earmarks are reclaimed after the grace period");
        require(earmarkedFunds[purpose] >= amount, "Registry: Cannot withdraw more than earmarked");
        _release(purpose, amount);
        emit EarmarkedFundsWithdrawn(purpose, amount);
    }

    function disburseEarmarked(address recipient, uint256 amount, bytes32 purpose, address tokenAddress) external nonReentrant {
        require(msg.sender == jurisdictionAddress, "Registry: Caller is not the Jurisdiction");
        require(earmarkToken[purpose] == tokenAddress, "Registry: Wrong token for purpose");
        require(earmarkedFunds[purpose] >= amount, "Registry: Insufficient earmarked funds");

        // Epoch-reward bypass path is ALSO metered: the rolling-window cap
        // covers this outflow exactly like a direct transferERC20, so the
        // disburse path cannot be used to outrun the build cadence.
        _meterSpend(tokenAddress, amount);

        _release(purpose, amount);
        if (tokenAddress == NATIVE_TOKEN) {
            (bool sent, ) = payable(recipient).call{value: amount}("");
            require(sent, "Native transfer failed during disbursement");
        } else {
            IERC20(tokenAddress).safeTransfer(recipient, amount);
        }
        emit EarmarkedFundsDisbursed(recipient, purpose, amount);
    }

    /**
     * @notice Allows DAO governance to release the unclaimed rest of a reward epoch after a grace period.
     * @dev The grace period starts from the beginning of the *next* epoch, or when claims open if that is later.
     * @param epochId The ID of the epoch to reclaim from.
     * @param paymentToken The address of the token used in that epoch.
     */
    function reclaimEarmarkedFunds(uint256 epochId, address paymentToken) external _treasuryOps {
        uint256 gracePeriod = Strings.parseUint(getRegistryValue("benefits.claim.gracePeriod"));
        require(gracePeriod > 0, "Registry: Grace period not set");

        uint48 gracePeriodStartTime = IJurisdictionData(jurisdictionAddress).getRewardEpochStart(epochId + 1);
        require(gracePeriodStartTime > 0, "Registry: The subsequent epoch has not started yet");
        // A delegate pool's claims open after its sign-up, which can end after the next epoch starts
        uint48 claimsOpen = IJurisdictionData(jurisdictionAddress).getRewardClaimsOpen(epochId);
        if (claimsOpen > gracePeriodStartTime) gracePeriodStartTime = claimsOpen;
        require(block.timestamp > gracePeriodStartTime + gracePeriod, "Registry: Claim grace period has not passed");

        bytes32 purpose = keccak256(abi.encodePacked("REWARD", epochId, paymentToken));
        uint256 remainingAmount = earmarkedFunds[purpose];
        require(remainingAmount > 0, "Registry: No funds to reclaim");

        _release(purpose, remainingAmount);
        emit EarmarkedFundsWithdrawn(purpose, remainingAmount);
    }

}
// Registry.sol end
