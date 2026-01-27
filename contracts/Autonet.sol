// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {Registry} from "./Registry.sol";

/**
 * @title IInferenceProvider
 * @notice Interface that decentralized inference services must implement.
 *
 * This grounds ATN tokens in real utility: any service registered with
 * serviceType=INFERENCE_PROVIDER must implement this interface, allowing
 * ATN holders to burn tokens for inference.
 */
interface IInferenceProvider {
    /// @notice Request inference, burning ATN as payment
    /// @param input The inference request (model-specific encoding)
    /// @param maxCredits Maximum ATN to spend (will burn actual cost)
    /// @return requestId Unique ID for this inference request
    function requestInference(bytes calldata input, uint256 maxCredits) external returns (bytes32 requestId);

    /// @notice Check if inference result is ready
    /// @param requestId The request ID from requestInference
    /// @return ready True if result is available
    function isResultReady(bytes32 requestId) external view returns (bool ready);

    /// @notice Get inference result (reverts if not ready)
    /// @param requestId The request ID from requestInference
    /// @return output The inference output
    /// @return creditsUsed Actual ATN burned for this request
    function getResult(bytes32 requestId) external view returns (bytes calldata output, uint256 creditsUsed);

    /// @notice Get current price per inference unit
    /// @return pricePerUnit ATN cost per unit (provider-defined unit)
    function getPricePerUnit() external view returns (uint256 pricePerUnit);

    /// @notice Emitted when inference is requested
    event InferenceRequested(bytes32 indexed requestId, address indexed requester, uint256 maxCredits);

    /// @notice Emitted when inference completes
    event InferenceCompleted(bytes32 indexed requestId, uint256 creditsUsed);
}

/**
 * @title Autonet
 * @notice Economic layer for decentralized AI services within a Jurisdiction.
 *
 * ATN tokens are inference credits with real utility:
 * - Services tagged INFERENCE_PROVIDER must implement IInferenceProvider
 * - ATN can be burned to request inference from these providers
 * - This makes ATN more than a promise - it's a claim on compute
 *
 * Key features:
 * - One-way mint: Lock governance tokens → mint ATN (irreversible)
 * - Service types: Regular services vs INFERENCE_PROVIDER (ATN-backed compute)
 * - Usage-based rewards: Services earn ATN based on attested usage
 * - Backer claiming: Project backers claim rewards via checkpoint system
 */
contract Autonet is ERC20, ERC20Burnable, ReentrancyGuard {
    using Checkpoints for Checkpoints.Trace208;

    // --- CONSTANTS ---
    uint256 public constant MINT_RATE_PRECISION = 10000; // Basis points

    // Service types
    bytes32 public constant SERVICE_TYPE_GENERAL = keccak256("GENERAL");
    bytes32 public constant SERVICE_TYPE_INFERENCE_PROVIDER = keccak256("INFERENCE_PROVIDER");

    // --- LINKED JURISDICTION ---
    address public immutable economyAddress;
    address public immutable registryAddress;
    address public immutable repTokenAddress;
    address public immutable timelockAddress;

    // --- ADMIN ---
    address public admin;

    // --- SERVICE REGISTRY ---
    struct Service {
        address projectContract;    // Trustless Project contract from Economy
        address serviceEndpoint;    // For INFERENCE_PROVIDER: the IInferenceProvider contract
        string codebaseHash;        // Git commit hash or IPFS CID
        bytes32 serviceType;        // GENERAL or INFERENCE_PROVIDER
        bool isActive;
        uint256 totalUsageUnits;    // Lifetime usage
        uint256 totalRewards;       // Total ATN allocated (not yet claimed)
    }

    mapping(bytes32 => Service) public services;
    bytes32[] public serviceIds;
    mapping(address => bytes32[]) public servicesByCreator;

    // --- BACKER REWARDS (per service) ---
    // Track rewards allocated per epoch so backers can claim proportionally
    struct EpochReward {
        uint256 totalReward;        // ATN allocated to this service this epoch
        uint256 claimedAmount;      // Amount already claimed by backers
        uint48 timestamp;           // When epoch was finalized
    }

    mapping(bytes32 => mapping(uint256 => EpochReward)) public serviceEpochRewards;
    mapping(bytes32 => mapping(uint256 => mapping(address => bool))) public hasClaimedReward;

    // --- USAGE TRACKING ---
    uint256 public currentEpoch;
    mapping(uint256 => mapping(bytes32 => uint256)) public epochUsage;
    mapping(uint256 => uint256) public epochTotalUsage;
    mapping(uint256 => uint256) public epochBudget;
    mapping(uint256 => bool) public epochFinalized;
    mapping(uint256 => uint48) public epochFinalizedAt;

    // --- MINT PARAMETERS ---
    uint256 public governanceToAtnRate = 10000;  // 1:1 by default
    uint256 public attestationRewardBps = 100;   // 1% reward for attesting
    uint256 public minUsageForReward = 1;

    // --- INFERENCE TRACKING ---
    // Total ATN burned for inference (proves real utility)
    uint256 public totalInferenceBurned;
    mapping(address => uint256) public userInferenceBurned;

    // --- EVENTS ---
    event ServiceRegistered(bytes32 indexed serviceId, address indexed projectContract, bytes32 serviceType, address indexed creator);
    event ServiceActivated(bytes32 indexed serviceId);
    event ServiceDeactivated(bytes32 indexed serviceId);
    event GovernanceTokenConverted(address indexed user, uint256 repLocked, uint256 atnMinted);
    event UsageAttested(bytes32 indexed serviceId, address indexed attester, uint256 units, uint256 epoch);
    event EpochStarted(uint256 indexed epochId, uint256 budget);
    event EpochFinalized(uint256 indexed epochId, uint256 totalDistributed);
    event ServiceRewarded(bytes32 indexed serviceId, uint256 indexed epoch, uint256 amount);
    event BackerRewardClaimed(bytes32 indexed serviceId, uint256 indexed epoch, address indexed backer, uint256 amount);
    event InferenceRequested(bytes32 indexed serviceId, address indexed requester, bytes32 requestId, uint256 creditsBurned);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // --- ERRORS ---
    error NotAuthorized();
    error InvalidService();
    error ServiceAlreadyExists();
    error ServiceNotActive();
    error NotInferenceProvider();
    error EpochAlreadyFinalized();
    error EpochNotFinalized();
    error AlreadyClaimed();
    error NothingToClaim();
    error ZeroAddress();
    error InvalidRate();
    error InvalidServiceType();

    // --- MODIFIERS ---
    modifier onlyAdmin() {
        if (msg.sender != admin && msg.sender != timelockAddress) revert NotAuthorized();
        _;
    }

    modifier onlyTimelock() {
        if (msg.sender != timelockAddress) revert NotAuthorized();
        _;
    }

    constructor(
        address _economyAddress,
        address _registryAddress,
        address _repTokenAddress,
        address _timelockAddress,
        string memory name,
        string memory symbol
    ) ERC20(name, symbol) {
        if (_economyAddress == address(0)) revert ZeroAddress();
        if (_registryAddress == address(0)) revert ZeroAddress();
        if (_repTokenAddress == address(0)) revert ZeroAddress();
        if (_timelockAddress == address(0)) revert ZeroAddress();

        economyAddress = _economyAddress;
        registryAddress = _registryAddress;
        repTokenAddress = _repTokenAddress;
        timelockAddress = _timelockAddress;
        admin = msg.sender;
        currentEpoch = 0;
    }

    // =========================================================================
    // GOVERNANCE TOKEN CONVERSION (One-Way Mint)
    // =========================================================================

    /**
     * @notice Convert governance tokens to ATN (irreversible)
     * @param amount Amount of governance tokens to lock
     */
    function convertGovernanceToAtn(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidRate();

        uint256 atnAmount = (amount * governanceToAtnRate) / MINT_RATE_PRECISION;
        if (atnAmount == 0) revert InvalidRate();

        // Lock RepToken in this contract (one-way)
        require(
            ERC20(repTokenAddress).transferFrom(msg.sender, address(this), amount),
            "Autonet: RepToken transfer failed"
        );

        _mint(msg.sender, atnAmount);
        emit GovernanceTokenConverted(msg.sender, amount, atnAmount);
    }

    // =========================================================================
    // SERVICE REGISTRY
    // =========================================================================

    /**
     * @notice Register a general service
     */
    function registerService(
        bytes32 serviceId,
        address projectContract,
        string calldata codebaseHash
    ) external {
        _registerService(serviceId, projectContract, address(0), codebaseHash, SERVICE_TYPE_GENERAL);
    }

    /**
     * @notice Register an inference provider service
     * @dev The serviceEndpoint must implement IInferenceProvider
     * @param serviceEndpoint Contract implementing IInferenceProvider
     */
    function registerInferenceProvider(
        bytes32 serviceId,
        address projectContract,
        address serviceEndpoint,
        string calldata codebaseHash
    ) external {
        if (serviceEndpoint == address(0)) revert ZeroAddress();
        _registerService(serviceId, projectContract, serviceEndpoint, codebaseHash, SERVICE_TYPE_INFERENCE_PROVIDER);
    }

    function _registerService(
        bytes32 serviceId,
        address projectContract,
        address serviceEndpoint,
        string calldata codebaseHash,
        bytes32 serviceType
    ) internal {
        if (services[serviceId].projectContract != address(0)) revert ServiceAlreadyExists();
        if (projectContract == address(0)) revert ZeroAddress();

        services[serviceId] = Service({
            projectContract: projectContract,
            serviceEndpoint: serviceEndpoint,
            codebaseHash: codebaseHash,
            serviceType: serviceType,
            isActive: false,
            totalUsageUnits: 0,
            totalRewards: 0
        });

        serviceIds.push(serviceId);
        servicesByCreator[msg.sender].push(serviceId);

        emit ServiceRegistered(serviceId, projectContract, serviceType, msg.sender);
    }

    function activateService(bytes32 serviceId) external onlyAdmin {
        Service storage service = services[serviceId];
        if (service.projectContract == address(0)) revert InvalidService();
        service.isActive = true;
        emit ServiceActivated(serviceId);
    }

    function deactivateService(bytes32 serviceId) external onlyAdmin {
        Service storage service = services[serviceId];
        if (service.projectContract == address(0)) revert InvalidService();
        service.isActive = false;
        emit ServiceDeactivated(serviceId);
    }

    // =========================================================================
    // INFERENCE (ATN UTILITY)
    // =========================================================================

    /**
     * @notice Use ATN to request inference from a provider
     * @dev Burns ATN and forwards request to the provider
     * @param serviceId Must be an INFERENCE_PROVIDER service
     * @param input Provider-specific input encoding
     * @param maxCredits Maximum ATN willing to spend
     * @return requestId The inference request ID
     */
    function requestInference(
        bytes32 serviceId,
        bytes calldata input,
        uint256 maxCredits
    ) external nonReentrant returns (bytes32 requestId) {
        Service storage service = services[serviceId];
        if (!service.isActive) revert ServiceNotActive();
        if (service.serviceType != SERVICE_TYPE_INFERENCE_PROVIDER) revert NotInferenceProvider();
        if (service.serviceEndpoint == address(0)) revert InvalidService();

        // Burn ATN from caller (the actual cost is handled by the provider)
        // For simplicity, we burn maxCredits upfront; provider refunds excess
        _burn(msg.sender, maxCredits);

        // Track inference burns (proves ATN utility)
        totalInferenceBurned += maxCredits;
        userInferenceBurned[msg.sender] += maxCredits;

        // Forward to provider
        requestId = IInferenceProvider(service.serviceEndpoint).requestInference(input, maxCredits);

        emit InferenceRequested(serviceId, msg.sender, requestId, maxCredits);
    }

    /**
     * @notice Check inference providers' stats
     */
    function getInferenceStats() external view returns (
        uint256 totalBurned,
        uint256 totalSupply_
    ) {
        return (totalInferenceBurned, totalSupply());
    }

    // =========================================================================
    // USAGE ATTESTATION
    // =========================================================================

    function attestUsage(bytes32 serviceId, uint256 units) external nonReentrant {
        Service storage service = services[serviceId];
        if (!service.isActive) revert ServiceNotActive();
        if (units == 0) return;

        epochUsage[currentEpoch][serviceId] += units;
        epochTotalUsage[currentEpoch] += units;
        service.totalUsageUnits += units;

        // Small attestation reward
        if (attestationRewardBps > 0 && units >= minUsageForReward) {
            uint256 unitValue = _getRegistryUint("autonet.usage.unitValue");
            if (unitValue > 0) {
                uint256 attestReward = (units * unitValue * attestationRewardBps) / MINT_RATE_PRECISION;
                if (attestReward > 0) {
                    _mint(msg.sender, attestReward);
                }
            }
        }

        emit UsageAttested(serviceId, msg.sender, units, currentEpoch);
    }

    // =========================================================================
    // EPOCH MANAGEMENT & REWARDS
    // =========================================================================

    function startEpoch(uint256 budget) external onlyAdmin {
        if (currentEpoch > 0 && !epochFinalized[currentEpoch]) {
            _finalizeEpoch(currentEpoch);
        }
        currentEpoch++;
        epochBudget[currentEpoch] = budget;
        emit EpochStarted(currentEpoch, budget);
    }

    function finalizeCurrentEpoch() external onlyAdmin {
        if (epochFinalized[currentEpoch]) revert EpochAlreadyFinalized();
        _finalizeEpoch(currentEpoch);
    }

    function _finalizeEpoch(uint256 epochId) internal {
        uint256 totalUsage = epochTotalUsage[epochId];
        uint256 budget = epochBudget[epochId];
        uint256 totalDistributed = 0;
        uint48 timestamp = uint48(block.timestamp);

        if (totalUsage > 0 && budget > 0) {
            for (uint i = 0; i < serviceIds.length; i++) {
                bytes32 serviceId = serviceIds[i];
                uint256 serviceUsage = epochUsage[epochId][serviceId];

                if (serviceUsage > 0) {
                    uint256 reward = (serviceUsage * budget) / totalUsage;

                    if (reward > 0) {
                        Service storage service = services[serviceId];

                        // Don't mint directly to project - track for backer claiming
                        service.totalRewards += reward;
                        serviceEpochRewards[serviceId][epochId] = EpochReward({
                            totalReward: reward,
                            claimedAmount: 0,
                            timestamp: timestamp
                        });

                        // Mint to THIS contract to hold for backer claims
                        _mint(address(this), reward);
                        totalDistributed += reward;

                        emit ServiceRewarded(serviceId, epochId, reward);
                    }
                }
            }
        }

        epochFinalized[epochId] = true;
        epochFinalizedAt[epochId] = timestamp;
        emit EpochFinalized(epochId, totalDistributed);
    }

    // =========================================================================
    // BACKER REWARD CLAIMING
    // =========================================================================

    /**
     * @notice Claim reward as a backer of a service's Trustless Project
     * @dev Caller must have been a backer at the epoch's finalization time
     * @param serviceId The service to claim from
     * @param epochId The epoch to claim
     * @param backerStake Your stake in the project (from project contract)
     * @param totalStake Total stake in project at snapshot
     */
    function claimBackerReward(
        bytes32 serviceId,
        uint256 epochId,
        uint256 backerStake,
        uint256 totalStake
    ) external nonReentrant {
        if (hasClaimedReward[serviceId][epochId][msg.sender]) revert AlreadyClaimed();
        if (!epochFinalized[epochId]) revert EpochNotFinalized();

        Service storage service = services[serviceId];
        if (service.projectContract == address(0)) revert InvalidService();

        EpochReward storage epochReward = serviceEpochRewards[serviceId][epochId];
        if (epochReward.totalReward == 0) revert NothingToClaim();

        // TODO: In production, verify backerStake/totalStake from project contract
        // For now, trust the caller (governance can dispute abuse)
        // Example verification:
        // (backerStake, totalStake) = IProject(service.projectContract).getBackerStakeAt(msg.sender, epochReward.timestamp);

        if (backerStake == 0 || totalStake == 0) revert NothingToClaim();

        uint256 reward = (backerStake * epochReward.totalReward) / totalStake;
        if (reward == 0) revert NothingToClaim();

        // Ensure we don't over-claim
        uint256 remaining = epochReward.totalReward - epochReward.claimedAmount;
        if (reward > remaining) {
            reward = remaining;
        }

        hasClaimedReward[serviceId][epochId][msg.sender] = true;
        epochReward.claimedAmount += reward;
        service.totalRewards -= reward;

        // Transfer from this contract's holdings
        _transfer(address(this), msg.sender, reward);

        emit BackerRewardClaimed(serviceId, epochId, msg.sender, reward);
    }

    // =========================================================================
    // CONFIGURATION
    // =========================================================================

    function setGovernanceToAtnRate(uint256 newRate) external onlyTimelock {
        if (newRate == 0 || newRate > 100000) revert InvalidRate();
        governanceToAtnRate = newRate;
    }

    function setAttestationRewardBps(uint256 newBps) external onlyAdmin {
        if (newBps > 1000) revert InvalidRate();
        attestationRewardBps = newBps;
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    // =========================================================================
    // VIEW FUNCTIONS
    // =========================================================================

    function getAllServiceIds() external view returns (bytes32[] memory) {
        return serviceIds;
    }

    function getServicesByCreator(address creator) external view returns (bytes32[] memory) {
        return servicesByCreator[creator];
    }

    function getService(bytes32 serviceId) external view returns (
        address projectContract,
        address serviceEndpoint,
        string memory codebaseHash,
        bytes32 serviceType,
        bool isActive,
        uint256 totalUsageUnits,
        uint256 totalRewards
    ) {
        Service storage s = services[serviceId];
        return (s.projectContract, s.serviceEndpoint, s.codebaseHash, s.serviceType, s.isActive, s.totalUsageUnits, s.totalRewards);
    }

    function getEpochStats(uint256 epochId) external view returns (
        uint256 totalUsage,
        uint256 budget,
        bool finalized,
        uint48 finalizedAt
    ) {
        return (epochTotalUsage[epochId], epochBudget[epochId], epochFinalized[epochId], epochFinalizedAt[epochId]);
    }

    function getServiceEpochReward(bytes32 serviceId, uint256 epochId) external view returns (
        uint256 totalReward,
        uint256 claimedAmount,
        uint48 timestamp
    ) {
        EpochReward storage r = serviceEpochRewards[serviceId][epochId];
        return (r.totalReward, r.claimedAmount, r.timestamp);
    }

    /**
     * @notice Get inference provider details
     */
    function getInferenceProviders() external view returns (bytes32[] memory providerIds) {
        uint256 count = 0;
        for (uint i = 0; i < serviceIds.length; i++) {
            if (services[serviceIds[i]].serviceType == SERVICE_TYPE_INFERENCE_PROVIDER) {
                count++;
            }
        }

        providerIds = new bytes32[](count);
        uint256 j = 0;
        for (uint i = 0; i < serviceIds.length; i++) {
            if (services[serviceIds[i]].serviceType == SERVICE_TYPE_INFERENCE_PROVIDER) {
                providerIds[j++] = serviceIds[i];
            }
        }
    }

    // =========================================================================
    // INTERNAL HELPERS
    // =========================================================================

    function _getRegistryUint(string memory key) internal view returns (uint256) {
        string memory value = Registry(registryAddress).getRegistryValue(key);
        if (bytes(value).length == 0) return 0;

        bytes memory b = bytes(value);
        uint256 result = 0;
        for (uint i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            if (c >= 48 && c <= 57) {
                result = result * 10 + (c - 48);
            }
        }
        return result;
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }
}
