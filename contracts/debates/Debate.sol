// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/governance/utils/IVotes.sol";
import "@openzeppelin/contracts/interfaces/IERC6372.sol";

/**
 * @title Debate
 * @notice A debate contract where token holders can add arguments weighted by their voting power
 * @dev Arguments form a tree structure with PRO/CON relationships. Net scores are calculated
 *      recursively: netScore = directWeight + sum(proChildren) - sum(conChildren)
 *
 *      Designed for efficient on-chain reading - getFullDebate() returns everything in one call,
 *      eliminating the need for an indexer.
 */
contract Debate {
    enum ArgumentType { PRO, CON }

    struct Argument {
        uint256 id;
        uint256 parentId;           // 0 for root argument
        ArgumentType argType;
        address author;
        string content;
        uint256 directWeight;       // Weight directly staked on this argument
        int256 netScore;            // Calculated: directWeight + sum(pro) - sum(con)
        uint256[] proChildIds;
        uint256[] conChildIds;
        bool isValid;
    }

    // View struct for returning argument data
    struct ArgumentView {
        uint256 id;
        uint256 parentId;
        ArgumentType argType;
        address author;
        string content;
        uint256 directWeight;
        int256 netScore;
        uint256[] proChildIds;
        uint256[] conChildIds;
        bool isValid;
    }

    // View struct for returning full debate state
    struct DebateView {
        address debateAddress;
        string title;
        address token;
        uint256 referenceBlock;
        uint256 totalSupplyAtCreation;
        uint256 totalStakedWeight;
        uint256 argumentCount;
        int256 debateSentiment;
        bool isOpen;
        ArgumentView[] arguments;
    }

    // State
    string public title;
    address public token;
    address public creator;
    uint256 public referenceBlock;
    uint256 public totalSupplyAtCreation;
    uint256 public totalStakedWeight;
    uint256 public createdAt;
    bool public isOpen;

    Argument[] private arguments;
    mapping(address => uint256) public usedVotingPower;

    // Events
    event ArgumentAdded(
        uint256 indexed argumentId,
        uint256 indexed parentId,
        ArgumentType argType,
        address indexed author,
        uint256 weight,
        string content
    );
    event WeightAdded(uint256 indexed argumentId, address indexed contributor, uint256 additionalWeight);
    event DebateClosed();

    constructor(
        address _token,
        string memory _title,
        string memory _rootArgument,
        uint256 _rootWeight,
        address _creator
    ) {
        require(_token != address(0), "Invalid token address");
        require(bytes(_title).length > 0, "Title required");
        require(bytes(_rootArgument).length > 0, "Root argument required");
        require(_rootWeight > 0, "Root weight must be positive");

        token = _token;
        title = _title;
        creator = _creator;
        createdAt = block.timestamp;
        isOpen = true;

        // Use previous timepoint for voting power snapshot (current timepoint has no checkpoint yet)
        uint48 currentClock = IERC6372(_token).clock();
        referenceBlock = currentClock > 0 ? currentClock - 1 : 0;
        totalSupplyAtCreation = IVotes(_token).getPastTotalSupply(referenceBlock);

        // Verify creator has sufficient voting power
        uint256 creatorVotes = IVotes(_token).getPastVotes(_creator, referenceBlock);
        require(_rootWeight <= creatorVotes, "Insufficient voting power for root argument");

        // Track used voting power
        usedVotingPower[_creator] = _rootWeight;
        totalStakedWeight = _rootWeight;

        // Create root argument (id = 1, parentId = 0)
        uint256[] memory emptyIds = new uint256[](0);
        arguments.push(Argument({
            id: 1,
            parentId: 0,
            argType: ArgumentType.PRO,
            author: _creator,
            content: _rootArgument,
            directWeight: _rootWeight,
            netScore: int256(_rootWeight),
            proChildIds: emptyIds,
            conChildIds: emptyIds,
            isValid: true
        }));

        emit ArgumentAdded(1, 0, ArgumentType.PRO, _creator, _rootWeight, _rootArgument);
    }

    /**
     * @notice Add an argument to the debate
     * @param _parentId ID of the parent argument (must exist)
     * @param _argType PRO (0) or CON (1)
     * @param _weight Voting power to stake on this argument
     * @param _content The argument text
     * @return argumentId The ID of the newly created argument
     */
    function addArgument(
        uint256 _parentId,
        ArgumentType _argType,
        uint256 _weight,
        string calldata _content
    ) external returns (uint256 argumentId) {
        require(isOpen, "Debate is closed");
        require(_parentId > 0 && _parentId <= arguments.length, "Invalid parent ID");
        require(_weight > 0, "Weight must be positive");
        require(bytes(_content).length > 0, "Content required");

        // Verify sender has sufficient remaining voting power
        uint256 senderVotes = IVotes(token).getPastVotes(msg.sender, referenceBlock);
        uint256 used = usedVotingPower[msg.sender];
        require(used + _weight <= senderVotes, "Insufficient voting power");

        // Update used voting power
        usedVotingPower[msg.sender] = used + _weight;
        totalStakedWeight += _weight;

        // Create new argument
        argumentId = arguments.length + 1;
        uint256[] memory emptyIds = new uint256[](0);

        arguments.push(Argument({
            id: argumentId,
            parentId: _parentId,
            argType: _argType,
            author: msg.sender,
            content: _content,
            directWeight: _weight,
            netScore: int256(_weight),
            proChildIds: emptyIds,
            conChildIds: emptyIds,
            isValid: true
        }));

        // Link to parent
        Argument storage parent = arguments[_parentId - 1];
        if (_argType == ArgumentType.PRO) {
            parent.proChildIds.push(argumentId);
        } else {
            parent.conChildIds.push(argumentId);
        }

        // Update net scores up the tree
        _updateNetScores(_parentId);

        emit ArgumentAdded(argumentId, _parentId, _argType, msg.sender, _weight, _content);
    }

    /**
     * @notice Add additional weight to an existing argument
     * @param _argumentId ID of the argument to boost
     * @param _additionalWeight Additional voting power to stake
     */
    function addWeight(uint256 _argumentId, uint256 _additionalWeight) external {
        require(isOpen, "Debate is closed");
        require(_argumentId > 0 && _argumentId <= arguments.length, "Invalid argument ID");
        require(_additionalWeight > 0, "Weight must be positive");

        // Verify sender has sufficient remaining voting power
        uint256 senderVotes = IVotes(token).getPastVotes(msg.sender, referenceBlock);
        uint256 used = usedVotingPower[msg.sender];
        require(used + _additionalWeight <= senderVotes, "Insufficient voting power");

        // Update used voting power
        usedVotingPower[msg.sender] = used + _additionalWeight;
        totalStakedWeight += _additionalWeight;

        // Update argument weight
        Argument storage arg = arguments[_argumentId - 1];
        arg.directWeight += _additionalWeight;
        arg.netScore += int256(_additionalWeight);

        // Update net scores up the tree (if not root)
        if (arg.parentId > 0) {
            _updateNetScores(arg.parentId);
        }

        emit WeightAdded(_argumentId, msg.sender, _additionalWeight);
    }

    /**
     * @notice Get remaining voting power for an account in this debate
     * @param _account The address to check
     * @return Remaining voting power that can be used
     */
    function getRemainingVotingPower(address _account) external view returns (uint256) {
        uint256 totalVotes = IVotes(token).getPastVotes(_account, referenceBlock);
        uint256 used = usedVotingPower[_account];
        return totalVotes > used ? totalVotes - used : 0;
    }

    /**
     * @notice Get the overall debate sentiment (root argument's net score)
     * @return The debate sentiment as a signed integer
     */
    function getDebateSentiment() external view returns (int256) {
        if (arguments.length == 0) return 0;
        return arguments[0].netScore;
    }

    /**
     * @notice Check if the debate is still open for new arguments
     * @return True if debate is open
     */
    function isDebateOpen() external view returns (bool) {
        return isOpen;
    }

    /**
     * @notice Get a single argument by ID
     * @param _argumentId The argument ID (1-indexed)
     * @return The argument view struct
     */
    function getArgument(uint256 _argumentId) external view returns (ArgumentView memory) {
        require(_argumentId > 0 && _argumentId <= arguments.length, "Invalid argument ID");
        return _toArgumentView(arguments[_argumentId - 1]);
    }

    /**
     * @notice Get the full debate with all arguments in a single call
     * @dev Designed for efficient client-side loading without needing an indexer
     * @return The complete debate view struct
     */
    function getFullDebate() external view returns (DebateView memory) {
        ArgumentView[] memory argViews = new ArgumentView[](arguments.length);
        for (uint256 i = 0; i < arguments.length; i++) {
            argViews[i] = _toArgumentView(arguments[i]);
        }

        return DebateView({
            debateAddress: address(this),
            title: title,
            token: token,
            referenceBlock: referenceBlock,
            totalSupplyAtCreation: totalSupplyAtCreation,
            totalStakedWeight: totalStakedWeight,
            argumentCount: arguments.length,
            debateSentiment: arguments.length > 0 ? arguments[0].netScore : int256(0),
            isOpen: isOpen,
            arguments: argViews
        });
    }

    /**
     * @notice Close the debate (only creator can close)
     */
    function closeDebate() external {
        require(msg.sender == creator, "Only creator can close");
        require(isOpen, "Already closed");
        isOpen = false;
        emit DebateClosed();
    }

    // Internal functions

    /**
     * @dev Update net scores from a node up to the root
     * @param _nodeId The node to start updating from
     */
    function _updateNetScores(uint256 _nodeId) internal {
        uint256 currentId = _nodeId;

        while (currentId > 0) {
            Argument storage current = arguments[currentId - 1];

            // Recalculate net score: directWeight + sum(pro) - sum(con)
            int256 newNetScore = int256(current.directWeight);

            for (uint256 i = 0; i < current.proChildIds.length; i++) {
                uint256 childId = current.proChildIds[i];
                newNetScore += arguments[childId - 1].netScore;
            }

            for (uint256 i = 0; i < current.conChildIds.length; i++) {
                uint256 childId = current.conChildIds[i];
                newNetScore -= arguments[childId - 1].netScore;
            }

            current.netScore = newNetScore;
            currentId = current.parentId;
        }
    }

    /**
     * @dev Convert internal Argument struct to view struct
     */
    function _toArgumentView(Argument storage arg) internal view returns (ArgumentView memory) {
        return ArgumentView({
            id: arg.id,
            parentId: arg.parentId,
            argType: arg.argType,
            author: arg.author,
            content: arg.content,
            directWeight: arg.directWeight,
            netScore: arg.netScore,
            proChildIds: arg.proChildIds,
            conChildIds: arg.conChildIds,
            isValid: arg.isValid
        });
    }
}
