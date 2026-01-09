// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Debate.sol";

/**
 * @title DebatesFactory
 * @notice Factory contract for creating and tracking debates across all DAOs on a network
 * @dev One DebatesFactory per network serves ALL DAOs. Debates are tracked by token address.
 *      Provides efficient list retrieval for UI without needing an indexer.
 */
contract DebatesFactory {
    // Lightweight struct for list display
    struct DebateListItem {
        address debateAddress;
        address token;
        string title;
        address creator;
        uint256 createdAt;
        uint256 argumentCount;
        int256 sentiment;
        bool isOpen;
    }

    // State - track all debates and debates per token
    address[] public debates;
    mapping(address => address[]) public debatesByToken;

    // Events
    event DebateCreated(
        address indexed debateAddress,
        address indexed token,
        address indexed creator,
        string title,
        uint256 rootWeight
    );

    /**
     * @notice Create a new debate for a DAO
     * @param _token The DAO's governance token (must implement IVotes)
     * @param _title The debate title
     * @param _rootArgument The root thesis/argument text
     * @param _rootWeight Voting power to stake on the root argument
     * @return debateAddress The address of the newly created debate
     */
    function createDebate(
        address _token,
        string calldata _title,
        string calldata _rootArgument,
        uint256 _rootWeight
    ) external returns (address debateAddress) {
        require(_token != address(0), "Invalid token address");

        Debate debate = new Debate(
            _token,
            _title,
            _rootArgument,
            _rootWeight,
            msg.sender
        );

        debateAddress = address(debate);
        debates.push(debateAddress);
        debatesByToken[_token].push(debateAddress);

        emit DebateCreated(debateAddress, _token, msg.sender, _title, _rootWeight);
    }

    /**
     * @notice Get all debate addresses across all DAOs
     * @return Array of all debate contract addresses
     */
    function getDebates() external view returns (address[] memory) {
        return debates;
    }

    /**
     * @notice Get all debate addresses for a specific DAO token
     * @param _token The DAO's governance token address
     * @return Array of debate contract addresses for that DAO
     */
    function getDebatesByToken(address _token) external view returns (address[] memory) {
        return debatesByToken[_token];
    }

    /**
     * @notice Get total debate count across all DAOs
     * @return Number of debates created
     */
    function getDebateCount() external view returns (uint256) {
        return debates.length;
    }

    /**
     * @notice Get debate count for a specific DAO token
     * @param _token The DAO's governance token address
     * @return Number of debates created for that DAO
     */
    function getDebateCountByToken(address _token) external view returns (uint256) {
        return debatesByToken[_token].length;
    }

    /**
     * @notice Get debate list with summaries for efficient UI loading (all DAOs)
     * @return Array of debate list items with key metadata
     */
    function getDebateList() external view returns (DebateListItem[] memory) {
        DebateListItem[] memory items = new DebateListItem[](debates.length);

        for (uint256 i = 0; i < debates.length; i++) {
            Debate debate = Debate(debates[i]);
            Debate.DebateView memory debateView = debate.getFullDebate();

            items[i] = DebateListItem({
                debateAddress: debates[i],
                token: debate.token(),
                title: debateView.title,
                creator: debate.creator(),
                createdAt: debate.createdAt(),
                argumentCount: debateView.argumentCount,
                sentiment: debateView.debateSentiment,
                isOpen: debateView.isOpen
            });
        }

        return items;
    }

    /**
     * @notice Get debate list for a specific DAO token
     * @param _token The DAO's governance token address
     * @return Array of debate list items for that DAO
     */
    function getDebateListByToken(address _token) external view returns (DebateListItem[] memory) {
        address[] memory tokenDebates = debatesByToken[_token];
        DebateListItem[] memory items = new DebateListItem[](tokenDebates.length);

        for (uint256 i = 0; i < tokenDebates.length; i++) {
            Debate debate = Debate(tokenDebates[i]);
            Debate.DebateView memory debateView = debate.getFullDebate();

            items[i] = DebateListItem({
                debateAddress: tokenDebates[i],
                token: _token,
                title: debateView.title,
                creator: debate.creator(),
                createdAt: debate.createdAt(),
                argumentCount: debateView.argumentCount,
                sentiment: debateView.debateSentiment,
                isOpen: debateView.isOpen
            });
        }

        return items;
    }
}
