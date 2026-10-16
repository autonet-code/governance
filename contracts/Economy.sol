// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./IEconomy.sol";
import "./NativeProject.sol";
import "./ERC20Project.sol";

// NEW: Interface to check RepToken balance for projectThreshold
interface IRepToken {
    function balanceOf(address account) external view returns (uint256);
}

interface IProjectSpending {
    function spentBy(address backer) external view returns (uint);
}

contract Economy is IEconomy {
    using SafeERC20 for IERC20;
    // --- STATE: DAO Governance ---
    address public timelockAddress;
    address public registryAddress;
    address public governorAddress;
    address public repTokenAddress;

    address public constant override NATIVE_CURRENCY = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    // --- STATE: DAO-Controlled Parameters ---
    uint public arbitrationFeeBps;  // Unified arbitration fee in basis points (e.g., 500 = 5%)
    uint public platformFeeBps;
    uint public authorFeeBps;
    uint public coolingOffPeriod;
    uint public backersVoteQuorumBps;
    uint public projectThreshold;
    uint public appealPeriod;
    uint public maxImmediateBps; // Max % of contribution that can be released immediately (basis points)

    // Every payout that accrues reputation pays the platform fee to the treasury, so the floor
    // is the minimum price of reputation. Without it, wash trading mints REP for free.
    uint public constant MIN_PLATFORM_FEE_BPS = 100; // 1%
    uint public constant MAX_PLATFORM_FEE_BPS = 5000; // 50%
    // Platform + author fees stay well below 100% of any payout
    uint public constant MAX_AUTHOR_FEE_BPS = 2500; // 25%
    uint public constant MAX_ARBITRATION_FEE_BPS = 2500; // 25% of the locked value
    // Court and tool verdicts can't hold for a DAO proposal, so their appeal window fits a full
    // proposal plus a day to propose and a day to execute. Projects hold instead (DaoProposalHold).
    uint public constant APPEAL_BUFFER = 2 days;
    // Backers always get this long to withdraw after the author names the contractor and arbiter.
    // Fixed by the deployer before the DAO takes over; the DAO can't lower it.
    uint public minCoolingOffPeriod;

    // Configures the economy until the DAO addresses are set; after that only the timelock can.
    address public admin;

    // --- STATE: Project & User Ledgers ---
    address public nativeProjectImplementation;
    address public erc20ProjectImplementation;

    address[] public deployedProjects;
    mapping(address => bool) public isProjectContract;

    mapping(address => mapping(address => uint)) public earnings; // user => token => amount
    mapping(address => mapping(address => uint)) public spendings; // user => token => amount

    mapping(address => address[]) private _earnedTokens;
    mapping(address => address[]) private _spentTokens;
    mapping(address => mapping(address => bool)) private _hasEarnedToken;
    mapping(address => mapping(address => bool)) private _hasSpentToken;

    mapping(address => address[]) public projectsAsAuthor;
    mapping(address => address[]) public projectsAsContractor;
    mapping(address => address[]) public projectsAsArbiter;

    // Backers' spending is read from each backed project once it closes, so it accrues
    // without the backer having to withdraw and without per-backer loops at close.
    mapping(address => address[]) public projectsAsBacker;
    mapping(address => mapping(address => bool)) private _isBackerOf;
    mapping(address => address) public projectToken; // project => payment token (NATIVE_CURRENCY for native)

    struct UserProfile {
        address[] earnedTokens;
        uint[] earnedAmounts;
        address[] spentTokens;
        uint[] spentAmounts;
        address[] projectsAsAuthor;
        address[] projectsAsContractor;
        address[] projectsAsArbiter;
    }

    struct EconomyConfig {
        // DAO Governance Addresses
        address timelockAddress;
        address registryAddress;
        address governorAddress;
        address repTokenAddress;
        // DAO-Controlled Parameters
        uint arbitrationFeeBps;
        uint platformFeeBps;
        uint authorFeeBps;
        uint coolingOffPeriod;
        uint backersVoteQuorumBps;
        uint projectThreshold;
        uint appealPeriod;
        uint maxImmediateBps;
        // Implementation addresses
        address nativeProjectImplementation;
        address erc20ProjectImplementation;
        // Stats
        uint numberOfProjects;
    }

    // --- EVENTS ---
    event InboundValue();
    event NewProject(address indexed contractAddress, string projectName, address contractor, address arbiter, string termsHash, string repo, string description, address token);
    event DaoAddressesSet(address timellock, address registry, address governor, address repToken);
    event PlatformFeeSet(uint newFeeBps);
    event AuthorFeeSet(uint newFeeBps);
    event ArbitrationFeeSet(uint newFeeBps);
    event CoolingOffPeriodSet(uint newPeriod);
    event BackersVoteQuorumSet(uint newQuorumBps);
    event ProjectThresholdSet(uint newThreshold);
    event AppealPeriodSet(uint newPeriod);
    event MaxImmediateBpsSet(uint newMaxBps);
    event AdminTransferred(address newAdmin);
    event MinCoolingOffPeriodSet(uint newMin);

    constructor(uint _arbitrationFeeBps) {
        require(_arbitrationFeeBps <= MAX_ARBITRATION_FEE_BPS, "Arbitration fee too high");
        arbitrationFeeBps = _arbitrationFeeBps;
        platformFeeBps = 100; // 1%
        authorFeeBps = 100;   // 1%
        minCoolingOffPeriod = 1 days;
        coolingOffPeriod = 1 days;
        backersVoteQuorumBps = 7000; // 70%
        appealPeriod = 7 days;
        maxImmediateBps = 2000; // 20% - max portion of contribution available to contractor immediately
        admin = msg.sender;
    }

    modifier onlyGovernance() {
        if (timelockAddress == address(0)) {
            require(msg.sender == admin, "Protected");
        } else {
            require(msg.sender == timelockAddress, "Protected");
        }
        _;
    }

    function transferAdmin(address newAdmin) external {
        require(timelockAddress == address(0) && msg.sender == admin, "Protected");
        admin = newAdmin;
        emit AdminTransferred(newAdmin);
    }

    function setMinCoolingOffPeriod(uint newMin) external {
        require(timelockAddress == address(0) && msg.sender == admin, "Protected");
        minCoolingOffPeriod = newMin;
        if (coolingOffPeriod < newMin) coolingOffPeriod = newMin;
        emit MinCoolingOffPeriodSet(newMin);
    }

    function setImplementations(address _native, address _erc20) external onlyGovernance {
        nativeProjectImplementation = _native;
        erc20ProjectImplementation = _erc20;
    }
    
    fallback() external payable { emit InboundValue(); }
    receive() external payable { emit InboundValue(); }

    // Voting delay, voting period and timelock delay: the time a DAO proposal takes at least
    function proposalLifecycle() public view returns (uint total) {
        total += _readUint(governorAddress, "votingDelay()");
        total += _readUint(governorAddress, "votingPeriod()");
        total += _readUint(timelockAddress, "getMinDelay()");
    }

    // The appeal window of court and tool verdicts: the DAO overrules them by proposal, so it never
    // drops below one proposal lifecycle. Projects use appealPeriod as is and hold for proposals.
    function effectiveAppealPeriod() external view returns (uint) {
        uint floor = proposalLifecycle() + APPEAL_BUFFER;
        return appealPeriod > floor ? appealPeriod : floor;
    }

    function _readUint(address target, string memory signature) private view returns (uint) {
        if (target.code.length == 0) return 0;
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature(signature));
        return ok && data.length >= 32 ? abi.decode(data, (uint)) : 0;
    }

    function getNumberOfProjects() public view returns (uint) { return deployedProjects.length; }

    function getConfig() public view returns (EconomyConfig memory) {
        return EconomyConfig({
            timelockAddress: timelockAddress,
            registryAddress: registryAddress,
            governorAddress: governorAddress,
            repTokenAddress: repTokenAddress,
            arbitrationFeeBps: arbitrationFeeBps,
            platformFeeBps: platformFeeBps,
            authorFeeBps: authorFeeBps,
            coolingOffPeriod: coolingOffPeriod,
            backersVoteQuorumBps: backersVoteQuorumBps,
            projectThreshold: projectThreshold,
            appealPeriod: appealPeriod,
            maxImmediateBps: maxImmediateBps,
            nativeProjectImplementation: nativeProjectImplementation,
            erc20ProjectImplementation: erc20ProjectImplementation,
            numberOfProjects: deployedProjects.length
        });
    }

    function getUser(address userAddress) public view returns (UserProfile memory) {
        address[] memory earnedTokenList = _earnedTokens[userAddress];
        uint[] memory earnedAmounts = new uint[](earnedTokenList.length);
        for(uint i = 0; i < earnedTokenList.length; i++) {
            earnedAmounts[i] = earnings[userAddress][earnedTokenList[i]];
        }

        (address[] memory spentTokenList, uint[] memory spentAmounts) = _spendingsOf(userAddress);

        return UserProfile({
            earnedTokens: earnedTokenList,
            earnedAmounts: earnedAmounts,
            spentTokens: spentTokenList,
            spentAmounts: spentAmounts,
            projectsAsAuthor: projectsAsAuthor[userAddress],
            projectsAsContractor: projectsAsContractor[userAddress],
            projectsAsArbiter: projectsAsArbiter[userAddress]
        });
    }

    function createProject(
        string memory name,
        address contractor,
        address arbiter,
        string memory termsHash,
        string memory repo,
        string memory description
    ) public payable {
        require(nativeProjectImplementation != address(0), "Native implementation not set.");
        require(repTokenAddress != address(0) && IRepToken(repTokenAddress).balanceOf(msg.sender) >= projectThreshold, "Insufficient reputation to create a project");

        address payable clone = payable(Clones.clone(nativeProjectImplementation));
        
        deployedProjects.push(clone);
        isProjectContract[clone] = true;
        projectToken[clone] = NATIVE_CURRENCY;

        NativeProject(clone).initialize{value: msg.value}(
            payable(address(this)), name, msg.sender, contractor, arbiter, 
            termsHash, repo, timelockAddress, governorAddress
        );
        
        emit NewProject(clone, name, contractor, arbiter, termsHash, repo, description, address(0));
    }

    function createERC20Project(
        string memory name,
        address contractor,
        address arbiter,
        string memory termsHash,
        string memory repo,
        string memory description,
        address tokenAddress
    ) public {
        require(erc20ProjectImplementation != address(0), "ERC20 implementation not set.");
        require(repTokenAddress != address(0) && IRepToken(repTokenAddress).balanceOf(msg.sender) >= projectThreshold, "Insufficient reputation to create a project");

        address clone = Clones.clone(erc20ProjectImplementation);

        deployedProjects.push(clone);
        isProjectContract[clone] = true;
        projectToken[clone] = tokenAddress;

        ERC20Project(clone).initialize(
            payable(address(this)), tokenAddress, name, msg.sender, contractor, arbiter,
            termsHash, repo, timelockAddress, governorAddress
        );

        emit NewProject(clone, name, contractor, arbiter, termsHash, repo, description, tokenAddress);
    }

    // Recorded spendings plus what the user spent on each closed project they backed, per token.
    function _spendingsOf(address user) internal view returns (address[] memory tokens, uint[] memory amounts) {
        address[] memory recorded = _spentTokens[user];
        address[] memory backed = projectsAsBacker[user];
        tokens = new address[](recorded.length + backed.length);
        amounts = new uint[](recorded.length + backed.length);
        uint n = recorded.length;
        for (uint i = 0; i < n; i++) {
            tokens[i] = recorded[i];
            amounts[i] = spendings[user][recorded[i]];
        }
        for (uint i = 0; i < backed.length; i++) {
            uint spent = IProjectSpending(backed[i]).spentBy(user);
            if (spent == 0) continue;
            address token = projectToken[backed[i]];
            uint j = 0;
            while (j < n && tokens[j] != token) j++;
            if (j == n) { tokens[n] = token; n++; }
            amounts[j] += spent;
        }
        assembly { mstore(tokens, n) mstore(amounts, n) }
    }

    function registerBacker(address backer) external override {
        require(isProjectContract[msg.sender], "Only Project contracts can call this function.");
        if (!_isBackerOf[backer][msg.sender]) {
            _isBackerOf[backer][msg.sender] = true;
            projectsAsBacker[backer].push(msg.sender);
        }
    }

    function updateEarnings(address user, uint amount, address tokenAddress) external override {
        require(isProjectContract[msg.sender], "Only Project contracts can call this function.");
        earnings[user][tokenAddress] += amount;
        if (!_hasEarnedToken[user][tokenAddress]) {
            _earnedTokens[user].push(tokenAddress);
            _hasEarnedToken[user][tokenAddress] = true;
        }
    }

    function updateSpendings(address user, uint amount, address tokenAddress) external override {
        require(isProjectContract[msg.sender], "Only Project contracts can call this function.");
        spendings[user][tokenAddress] += amount;
        if (!_hasSpentToken[user][tokenAddress]) {
            _spentTokens[user].push(tokenAddress);
            _hasSpentToken[user][tokenAddress] = true;
        }
    }
    
    function registerProjectRoles(address projectAddress, address author, address contractor, address arbiter) external override {
        require(isProjectContract[msg.sender], "Only Project contracts can call this function.");
        require(msg.sender == projectAddress, "Project can only register its own roles.");

        if (author != address(0)) { projectsAsAuthor[author].push(projectAddress); }
        if (contractor != address(0)) { projectsAsContractor[contractor].push(projectAddress); }
        if (arbiter != address(0)) { projectsAsArbiter[arbiter].push(projectAddress); }
    }

    function setDaoAddresses(address _timelock, address _registry, address _governor, address _repToken) external {
        require(timelockAddress == address(0), "DAO addresses can only be set once.");
        require(msg.sender == admin, "Protected");
        require(_timelock != address(0), "Invalid timelock");
        timelockAddress = _timelock;
        registryAddress = _registry;
        governorAddress = _governor;
        repTokenAddress = _repToken;
        emit DaoAddressesSet(_timelock, _registry, _governor, _repToken);
    }

    function setPlatformFee(uint newFeeBps) external onlyGovernance {
        require(newFeeBps >= MIN_PLATFORM_FEE_BPS && newFeeBps <= MAX_PLATFORM_FEE_BPS, "Platform fee out of range");
        platformFeeBps = newFeeBps;
        emit PlatformFeeSet(newFeeBps);
    }

    function setAuthorFee(uint newFeeBps) external onlyGovernance {
        require(newFeeBps <= MAX_AUTHOR_FEE_BPS, "Author fee too high");
        authorFeeBps = newFeeBps;
        emit AuthorFeeSet(newFeeBps);
    }

    function setArbitrationFee(uint newFeeBps) external onlyGovernance {
        require(newFeeBps <= MAX_ARBITRATION_FEE_BPS, "Arbitration fee too high");
        arbitrationFeeBps = newFeeBps;
        emit ArbitrationFeeSet(newFeeBps);
    }

    function setCoolingOffPeriod(uint newPeriod) external onlyGovernance {
        require(newPeriod >= minCoolingOffPeriod, "Cooling-off below the minimum");
        coolingOffPeriod = newPeriod;
        emit CoolingOffPeriodSet(newPeriod);
    }

    function setBackersVoteQuorum(uint newQuorumBps) external onlyGovernance {
        require(newQuorumBps >= 5000 && newQuorumBps <= 9900, "Quorum must be between 50% and 99%");
        backersVoteQuorumBps = newQuorumBps;
        emit BackersVoteQuorumSet(newQuorumBps);
    }

    function setProjectThreshold(uint newThreshold) external onlyGovernance {
        projectThreshold = newThreshold;
        emit ProjectThresholdSet(newThreshold);
    }

    function setAppealPeriod(uint newPeriod) external onlyGovernance {
        appealPeriod = newPeriod;
        emit AppealPeriodSet(newPeriod);
    }

    function setMaxImmediateBps(uint newMaxBps) external onlyGovernance {
        require(newMaxBps <= 5000, "Max immediate cannot exceed 50%");
        maxImmediateBps = newMaxBps;
        emit MaxImmediateBpsSet(newMaxBps);
    }

    function withdrawNative() public {
        require(msg.sender == timelockAddress, "Only the DAO can withdraw Ether");
        (bool sent, ) = payable(registryAddress).call{value: address(this).balance}("");
        require(sent, "Native withdrawal failed.");
    }

    function withdrawTokens(address tokenAddress) public {
        require(msg.sender == timelockAddress, "Only the DAO can withdraw tokens.");
        IERC20 token = IERC20(tokenAddress);
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "No tokens to withdraw.");
        token.safeTransfer(registryAddress, balance);
    }
}
// Economy.sol