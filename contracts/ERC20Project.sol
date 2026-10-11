// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./IEconomy.sol";
import "./IGovernedEconomy.sol";
import "@openzeppelin/contracts/governance/utils/IVotes.sol";
import "@openzeppelin/contracts/governance/IGovernor.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";

contract ERC20Project is Initializable {
    using SafeERC20 for IERC20;

    IEconomy public economy;
    IERC20 public token;
    uint public coolingOffPeriodEnds;
    uint public disputeStarted;
    string public name;
    address public author;
    address public contractor;
    address public arbiter;
    string public termsHash;
    string public repo;
    address[] public backers;

    // Immediate release: backers can specify what portion is available to contractor at signing
    struct Contribution {
        uint total;           // Total amount contributed
        uint immediate;       // Total immediate portion (released at signing)
        uint locked;          // Total locked portion (in escrow until resolution)
    }
    mapping(address => Contribution) public contributions;
    uint public totalImmediate;    // Sum of all immediate portions (released at signing)
    uint public totalLocked;       // Sum of all locked portions (in escrow)
    uint public immediateReleased; // Amount of immediate funds already paid out

    mapping(address => uint) public contributorsReleasing;  // Tracks locked amount voting to release
    mapping(address => uint) public contributorsDisputing;  // Tracks locked amount voting to dispute
    uint public availableToContractor;
    uint public totalVotesForRelease;
    uint public totalVotesForDispute;
    uint public projectValue;
    uint public disputeResolution;
    string public ruling_hash;
    bool public fundsReleased;
    uint public arbitrationFee;
    bool public arbitrationFeePaidOut = false;
    bool public contractorReclaimedStake = false;
    mapping(address => bool) public contributorSettled; // withdrew after close
    
    address public daoTimelock;
    address public daoGovernor;
    
    enum Stage { Open, Pending, Ongoing, Dispute, Appealable, Appeal, Closed }
    Stage public stage;

    uint public appealEnds;
    uint public originalDisputeResolution;
    string public originalRulingHash;
    bool public arbiterHasRuled = false;

    struct ProjectDetails {
        string name;
        address author;
        address contractor;
        address arbiter;
        Stage stage;
        uint projectValue;
        uint totalImmediate;
        uint totalLocked;
        uint immediateReleased;
        uint totalVotesForRelease;
        uint totalVotesForDispute;
        uint availableToContractor;
        uint arbitrationFee;
        bool fundsReleased;
    }
    uint256 public constant ARBITRATION_TIMEOUT = 150 days;
    
    event SetParties(address _contractor, address _arbiter, string _termsHash);
    event SendFunds(address who, uint256 howMuch, uint256 immediateBps);
    event ImmediateFundsReleased(address contractor, uint256 amount);
    event ContractorPaid(address contractor, uint256 amount);
    event ContributorWithdrawn(address contributor, uint256 amount);
    event ProjectDisputed(address by);
    event ProjectClosed(address by);
    event ContractSigned(address contractor);
    event ArbitrationDecision(address arbiter, uint256 percent, string rulingHash);
    event ArbitrationAppealed(address indexed appealer, uint256 indexed proposalId);
    event ArbitrationFinalized(address indexed finalizer);
    event DaoOverruled(address indexed timelock, uint256 percent, string rulingHash);
    event AuthorPaid(address author, uint256 amount);
    event VetoedByDao(address indexed timelock);
    event ArbitrationStakeReclaimed(address contractor, uint256 amount);
    event OrphanedTokensSwept(address indexed token, uint256 amount);
    event BackerVoteCast(address indexed voter, uint256 votingPower, bool forDispute);

    function initialize(
        address payable _economy,
        address _tokenAddress,
        string memory _name,
        address _author,
        address _contractor,
        address _arbiter,
        string memory _termsHash,
        string memory _repo,
        address _daoTimelock,
        address _daoGovernor
    ) public initializer {
        economy = IEconomy(_economy);
        token = IERC20(_tokenAddress);
        fundsReleased = false;
        name = _name;
        author = _author;
        contractor = _contractor;
        arbiter = _arbiter;
        termsHash = _termsHash;
        repo = _repo;
        ruling_hash = "";

        daoTimelock = _daoTimelock;
        daoGovernor = _daoGovernor;

        // arbitrationFee is now calculated at signing time based on projectValue

        economy.registerProjectRoles(address(this), _author, _contractor, _arbiter);

        if (contractor != address(0) && arbiter != address(0)) {
            // Parties named at creation get the same cooling-off as setParties
            coolingOffPeriodEnds = block.timestamp + IGovernedEconomy(address(economy)).effectiveCoolingOffPeriod();
            stage = Stage.Pending;
        } else {
            stage = Stage.Open;
        }
    }

    function getProjectDetails() public view returns (ProjectDetails memory d) {
        // Assigned field by field: a 14-field struct literal overflows the stack under viaIR
        d.name = name;
        d.author = author;
        d.contractor = contractor;
        d.arbiter = arbiter;
        d.stage = stage;
        d.projectValue = projectValue;
        d.totalImmediate = totalImmediate;
        d.totalLocked = totalLocked;
        d.immediateReleased = immediateReleased;
        d.totalVotesForRelease = totalVotesForRelease;
        d.totalVotesForDispute = totalVotesForDispute;
        d.availableToContractor = availableToContractor;
        d.arbitrationFee = arbitrationFee;
        d.fundsReleased = fundsReleased;
    }

    function arbitrationPeriodExpired() public {
        require(stage == Stage.Dispute, "Project must be in dispute stage");
        require(
            block.timestamp >= disputeStarted + ARBITRATION_TIMEOUT,
            "Arbitration period has not expired yet"
        );
        stage = Stage.Closed;
        emit ProjectClosed(msg.sender);
    }
    
    function setParties(address _contractor, address _arbiter, string memory _termsHash) public {
        require(stage == Stage.Open, "Parties can only be set in 'open' stage.");
        require(msg.sender == author, "Only the Project's Author can set the other parties.");
        require(_contractor != address(0) && _arbiter != address(0), "Contractor and arbiter addresses must be valid.");
        
        coolingOffPeriodEnds = block.timestamp + IGovernedEconomy(address(economy)).effectiveCoolingOffPeriod();
        contractor = _contractor;
        arbiter = _arbiter;
        termsHash = _termsHash;

        economy.registerProjectRoles(address(this), address(0), _contractor, _arbiter);
        
        emit SetParties(_contractor, _arbiter, _termsHash);
        stage = Stage.Pending;
    }

    // Legacy function for backwards compatibility - defaults to 0% immediate
    function sendFunds(uint256 amount) public {
        sendFundsWithImmediate(amount, 0);
    }

    function sendFundsWithImmediate(uint256 amount, uint immediateBps) public {
        require(
            stage == Stage.Open || stage == Stage.Pending,
            "Funding is only allowed when the project is in 'open' or 'pending' stage."
        );
        require(amount > 0, "Amount must be greater than zero.");
        require(immediateBps <= IGovernedEconomy(address(economy)).maxImmediateBps(), "Immediate percentage exceeds maximum allowed");

        uint immediateAmount = (amount * immediateBps) / 10000;

        if (contributions[msg.sender].total == 0) {
            backers.push(msg.sender);
            economy.registerBacker(msg.sender);
            contributions[msg.sender].total = amount;
            contributions[msg.sender].immediate = immediateAmount;
            contributions[msg.sender].locked = amount - immediateAmount;
        } else {
            // Accumulate actual amounts for additional contributions
            contributions[msg.sender].total = contributions[msg.sender].total + amount;
            contributions[msg.sender].immediate += immediateAmount;
            contributions[msg.sender].locked += amount - immediateAmount;
        }

        totalImmediate += immediateAmount;
        totalLocked += amount - immediateAmount;
        projectValue += amount;

        token.safeTransferFrom(msg.sender, address(this), amount);
        emit SendFunds(msg.sender, amount, immediateBps);
    }

    function signContract() public {
        require(msg.sender == contractor, "Only the designated contractor can sign the contract");
        require(stage == Stage.Pending, "The project can only be signed while in `pending` stage.");
        require(block.timestamp > coolingOffPeriodEnds, "Contract signing is blocked during the cooling-off period.");
        require(projectValue > 0, "Can't sign a contract with no funds in it.");

        arbitrationFee = (totalLocked * IGovernedEconomy(address(economy)).arbitrationFeeBps()) / 10000;
        token.safeTransferFrom(msg.sender, address(this), arbitrationFee / 2);

        stage = Stage.Ongoing;
        emit ContractSigned(msg.sender);

        // Release immediate funds to contractor (taxed like any other payout)
        if (totalImmediate > 0) {
            immediateReleased = totalImmediate;
            uint paid = _payContractor(totalImmediate);
            emit ImmediateFundsReleased(contractor, paid);
        }
    }

    // Every payout that accrues reputation pays the platform fee to the treasury first.
    // Returns the amount the payee actually received.
    function _payWithFees(address payee, uint amount, bool withAuthorFee) private returns (uint) {
        IGovernedEconomy governedEconomy = IGovernedEconomy(address(economy));

        uint platformFee = (amount * governedEconomy.platformFeeBps()) / 10000;
        uint remainder = amount - platformFee;
        uint authorFee = withAuthorFee ? (remainder * governedEconomy.authorFeeBps()) / 10000 : 0;
        uint net = remainder - authorFee;

        if (platformFee > 0) {
            token.safeTransfer(governedEconomy.registryAddress(), platformFee);
        }
        if (authorFee > 0) {
            economy.updateEarnings(author, authorFee, address(token));
            token.safeTransfer(author, authorFee);
            emit AuthorPaid(author, authorFee);
        }
        if (net > 0) {
            economy.updateEarnings(payee, net, address(token));
            token.safeTransfer(payee, net);
        }
        return net;
    }

    function _payContractor(uint amount) private returns (uint) {
        return _payWithFees(contractor, amount, true);
    }

    // Helper to calculate locked amount for a contributor
    function _getLockedAmount(address contributor) internal view returns (uint) {
        Contribution memory contrib = contributions[contributor];
        // Use stored locked amount directly (no rounding errors)
        return contrib.locked;
    }

    function voteToReleasePayment() public {
        require(stage == Stage.Ongoing, "Project must be ongoing to vote");

        // Voting power = locked portion only (immediate givers have less say)
        uint lockedAmount = _getLockedAmount(msg.sender);
        require(lockedAmount > 0, "Only contributors with locked funds can vote");

        if (contributorsDisputing[msg.sender] > 0) {
            totalVotesForDispute -= contributorsDisputing[msg.sender];
            contributorsDisputing[msg.sender] = 0;
        }
        if (contributorsReleasing[msg.sender] == 0) {
            totalVotesForRelease += lockedAmount;
            contributorsReleasing[msg.sender] = lockedAmount;
            emit BackerVoteCast(msg.sender, lockedAmount, false);
        }

        // Quorum calculated against totalLocked (not totalImmediate which is already released)
        uint quorumBps = IGovernedEconomy(address(economy)).backersVoteQuorumBps();
        if (totalVotesForRelease * 10000 >= totalLocked * quorumBps) {
            stage = Stage.Closed;
            availableToContractor = totalLocked; // Only locked portion remains to distribute
            fundsReleased = true;
            disputeResolution = 100; // 100% to contractor means 0% back to backers
            emit ProjectClosed(msg.sender);
        }
    }

    function voteToDispute() public {
        require(stage == Stage.Ongoing, "Project must be ongoing to vote");

        // Voting power = locked portion only
        uint lockedAmount = _getLockedAmount(msg.sender);
        require(lockedAmount > 0, "Only contributors with locked funds can vote");

        if (contributorsReleasing[msg.sender] > 0) {
            totalVotesForRelease -= contributorsReleasing[msg.sender];
            contributorsReleasing[msg.sender] = 0;
        }
        if (contributorsDisputing[msg.sender] == 0) {
            totalVotesForDispute += lockedAmount;
            contributorsDisputing[msg.sender] = lockedAmount;
            emit BackerVoteCast(msg.sender, lockedAmount, true);
        }

        // Quorum calculated against totalLocked
        uint quorumBps = IGovernedEconomy(address(economy)).backersVoteQuorumBps();
        if (totalVotesForDispute * 10000 >= totalLocked * quorumBps) {
            stage = Stage.Dispute;
            disputeStarted = block.timestamp;
            emit ProjectDisputed(msg.sender);
        }
    }
    
    function disputeAsContractor() public {
        require(
            msg.sender == contractor,
            "Only the designated Contractor can call this function"
        );
        require(
            stage == Stage.Ongoing,
            "This can only be called while the project is ongoing"
        );
        stage = Stage.Dispute;
        disputeStarted = block.timestamp;
        emit ProjectDisputed(msg.sender);
    }

    function reimburse() public {
        require(
            msg.sender == contractor,
            "Only the contractor can call this function."
        );
        require(
            stage == Stage.Ongoing,
            "This action can only be performed while the project is ongoing."
        );
        stage = Stage.Closed;
        emit ProjectClosed(msg.sender);
    }

    function arbitrate(uint256 percent, string memory rulingHash) public {
        require(msg.sender == arbiter, "Only the Arbiter can call this function");
        require(stage == Stage.Dispute, "Arbitration can only occur if the project is in dispute.");
        require(percent <= 100, "Resolution needs to be a number between 0 and 100");

        originalDisputeResolution = percent;
        originalRulingHash = rulingHash;
        arbiterHasRuled = true;
        stage = Stage.Appealable;
        appealEnds = block.timestamp + IGovernedEconomy(address(economy)).appealPeriod();

        emit ArbitrationDecision(msg.sender, percent, rulingHash);
    }

    function appeal(uint256 proposalId, address[] calldata targets) external {
        IGovernedEconomy governedEconomy = IGovernedEconomy(address(economy));
        
        require(
            stage == Stage.Appealable ||
            (stage == Stage.Dispute && block.timestamp > disputeStarted + governedEconomy.appealPeriod()),
            "Appeal not allowed at this time"
        );

        if (stage == Stage.Appealable) {
            require(block.timestamp <= appealEnds, "Appeal initiation period has ended");
        }
        
        address repTokenAddress = governedEconomy.repTokenAddress();
        uint256 threshold = governedEconomy.projectThreshold();
        uint256 votingPower = IVotes(repTokenAddress).getVotes(msg.sender);
        require(votingPower >= threshold, "Insufficient voting power to appeal");

        IGovernor.ProposalState propState = IGovernor(daoGovernor).state(proposalId);
        require(
            propState == IGovernor.ProposalState.Pending ||
            propState == IGovernor.ProposalState.Active ||
            propState == IGovernor.ProposalState.Succeeded ||
            propState == IGovernor.ProposalState.Queued,
            "Invalid proposal state"
        );

        require(targets.length > 0 && targets[0] == address(this), "Proposal does not target this project");

        stage = Stage.Appeal;
        appealEnds = block.timestamp + governedEconomy.appealPeriod();
        emit ArbitrationAppealed(msg.sender, proposalId);
    }

    function daoOverrule(uint256 percent, string memory rulingHash) public {
        require(msg.sender == daoTimelock, "Only the DAO Timelock can overrule");
        require(stage == Stage.Appeal, "DAO can only overrule during appeal stage");
        require(block.timestamp <= appealEnds, "Appeal period has ended");
        require(percent <= 100, "Resolution needs to be a number between 0 and 100");

        _finalizeDispute(percent, rulingHash);
        emit DaoOverruled(msg.sender, percent, rulingHash);
    }

    function finalizeArbitration() public {
        require(
            stage == Stage.Appealable || stage == Stage.Appeal,
            "Project not in a finalizable stage"
        );
        require(block.timestamp > appealEnds, "Appeal/Finalization period has not ended yet");
        
        _finalizeDispute(originalDisputeResolution, originalRulingHash);
        emit ArbitrationFinalized(msg.sender);
    }

    function _finalizeDispute(uint256 percent, string memory rulingHash) private {
        disputeResolution = percent;
        ruling_hash = rulingHash;
        stage = Stage.Closed;
        arbitrationFeePaidOut = true;

        // Arb fee: half from contractor's stake, half from backer pool
        // Pool = totalLocked - backer's share of arb fee (immediateReleased already sent at signing)
        uint backersArbShare = arbitrationFee - (arbitrationFee / 2);
        uint pool = totalLocked - backersArbShare;
        availableToContractor = (pool * percent) / 100;

        if (arbiterHasRuled) {
            _payWithFees(arbiter, arbitrationFee, false);
        } else {
            // Arbiter didn't rule - forfeit fee to DAO treasury
            address registry = IGovernedEconomy(address(economy)).registryAddress();
            token.safeTransfer(registry, arbitrationFee);
        }
        emit ProjectClosed(msg.sender);
    }
    
    function withdrawAsContractor() public {
        require(stage == Stage.Closed, "The contractor can only withdraw once the project is closed.");
        require(msg.sender == contractor, "Only the contractor can withdraw.");
        
        uint256 amountToPay = availableToContractor;
        require(amountToPay > 0, "Nothing to withdraw");
        availableToContractor = 0;

        uint paid = _payContractor(amountToPay);
        emit ContractorPaid(contractor, paid);
    }
    
    // What a backer gets back from a closed project.
    function _closedExit(address contributor) internal view returns (uint) {
        Contribution memory contrib = contributions[contributor];
        // If the contract was never signed (e.g. vetoed while pending), immediate funds were never released
        uint exitAmount = immediateReleased == 0 ? contrib.immediate : 0;
        if (arbitrationFeePaidOut) {
            // Pool = totalLocked - backer's share of arb fee (same as _finalizeDispute)
            uint backersArbShare = arbitrationFee - (arbitrationFee / 2);
            uint pool = totalLocked - backersArbShare;
            // Proportion based on lockedAmount / totalLocked (not total contribution)
            exitAmount += ((pool * (100 - disputeResolution)) / 100) * contrib.locked / totalLocked;
        } else {
            exitAmount += (contrib.locked * (100 - disputeResolution)) / 100;
        }
        return exitAmount;
    }

    /// What a backer spent on this project. Zero until the project closes.
    function spentBy(address contributor) external view returns (uint) {
        if (stage != Stage.Closed) return 0;
        return contributions[contributor].total - _closedExit(contributor);
    }

    function withdrawAsContributor() public {
        require(stage == Stage.Open || stage == Stage.Pending || stage == Stage.Closed, "Withdrawals only allowed when the project is open, pending or closed.");

        Contribution memory contrib = contributions[msg.sender];
        require(contrib.total > 0, "No contributions to withdraw.");

        uint256 exitAmount;
        if (stage == Stage.Open || stage == Stage.Pending) {
            // Pre-signing withdrawal: get everything back
            contributions[msg.sender].total = 0;
            contributions[msg.sender].immediate = 0;
            contributions[msg.sender].locked = 0;
            exitAmount = contrib.total;
            totalImmediate -= contrib.immediate;
            totalLocked -= contrib.locked;
            projectValue -= contrib.total;
        } else {
            // Closed: the contribution record stays so spentBy() keeps reporting spending
            require(!contributorSettled[msg.sender], "Already withdrawn.");
            contributorSettled[msg.sender] = true;
            exitAmount = _closedExit(msg.sender);
        }

        if (exitAmount > 0) token.safeTransfer(msg.sender, exitAmount);
        emit ContributorWithdrawn(msg.sender, exitAmount);
    }
    
    function reclaimArbitrationStake() public {
        require(stage == Stage.Closed, "Stake can only be reclaimed once the project is closed.");
        require(arbitrationFeePaidOut == false, "Stake was used to pay the arbiter.");
        require(msg.sender == contractor, "Only the contractor can reclaim their stake.");
        require(contractorReclaimedStake == false, "You have already reclaimed your stake.");

        contractorReclaimedStake = true;
        uint stakeAmount = arbitrationFee / 2;
        token.safeTransfer(contractor, stakeAmount);
        emit ArbitrationStakeReclaimed(contractor, stakeAmount);
    }
    
    function daoVeto() public {
        require(msg.sender == daoTimelock, "Only the DAO Timelock can veto a project.");
        require(stage != Stage.Closed, "Cannot veto a closed project.");
        stage = Stage.Closed;
        disputeResolution = 0; // Ensures 100% refund to backers.
        emit VetoedByDao(msg.sender);
    }

    function sweepOrphanedTokens(address tokenAddress) external {
        require(msg.sender == daoTimelock, "Only the DAO Timelock can sweep tokens.");
        IERC20 sweepToken = IERC20(tokenAddress);
        uint256 totalBalance = sweepToken.balanceOf(address(this));
        uint256 trackedBalance = (tokenAddress == address(token)) ? projectValue : 0;

        if (tokenAddress == address(token)) {
            // Only contractor stakes half the arbitration fee (after signing)
            if (stage == Stage.Ongoing || stage == Stage.Dispute || stage == Stage.Appealable || stage == Stage.Appeal) {
                 if (!arbitrationFeePaidOut) {
                    trackedBalance += arbitrationFee / 2; // Only contractor's stake
                 }
            }
        }

        if (totalBalance > trackedBalance) {
            uint256 orphanedAmount = totalBalance - trackedBalance;
            address registry = IGovernedEconomy(address(economy)).registryAddress();
            sweepToken.safeTransfer(registry, orphanedAmount);
            emit OrphanedTokensSwept(tokenAddress, orphanedAmount);
        }
    }
}
// ERC20Project.sol