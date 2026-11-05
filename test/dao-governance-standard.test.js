const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Standard DAO Governance", function () {
    let deployer, member1, member2, member3, recipient;
    let dao, token, timelock, registry;

    beforeEach(async function () {
        [deployer, member1, member2, member3, recipient] = await ethers.getSigners();

        const { createJurisdiction } = require("./helpers/jurisdiction");
        const j = await createJurisdiction(deployer, {
            name: "Test DAO", symbol: "TDAO", description: "A test DAO for governance",
            members: [member1.address, member2.address], amounts: [ethers.parseEther("100"), ethers.parseEther("50")], supermajorityBps: 6000,
            votingDelay: 1, votingPeriod: 2, proposalThreshold: ethers.parseEther("1"), quorumFraction: 4,
            executionDelay: 60,
        });
        const daoAddress = j.core.governor;
        const tokenAddress = j.core.token;
        const registryAddress = j.core.registry;

        // Get contract instances
        dao = await ethers.getContractAt("HomebaseDAO", daoAddress);
        token = await ethers.getContractAt("RepToken", tokenAddress);
        registry = await ethers.getContractAt("Registry", registryAddress);

        const timelockAddress = await dao.timelock();
        timelock = await ethers.getContractAt(
            "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController",
            timelockAddress
        );
    });

    describe("Token & Delegation", function () {
        it("binds the token to the DAO timelock so governance can run reward epochs", async function () {
            expect(await token.timelockAddress()).to.equal(await timelock.getAddress());
        });

        it("lets the governor cancel operations on its timelock", async function () {
            expect(await timelock.hasRole(await timelock.CANCELLER_ROLE(), await dao.getAddress())).to.be.true;
        });

        it("should have correct initial token balances", async function () {
            expect(await token.balanceOf(member1.address)).to.equal(ethers.parseEther("100"));
            expect(await token.balanceOf(member2.address)).to.equal(ethers.parseEther("50"));
            expect(await token.totalSupply()).to.equal(ethers.parseEther("150"));
        });

        it("should require delegation before voting power is active", async function () {
            // Before delegation, voting power is 0
            expect(await token.getVotes(member1.address)).to.equal(0);

            // Delegate to self
            await token.connect(member1).delegate(member1.address);

            // After delegation, voting power equals balance
            expect(await token.getVotes(member1.address)).to.equal(ethers.parseEther("100"));
        });

        it("should allow delegating to another address", async function () {
            await token.connect(member1).delegate(member2.address);

            // member1 has no voting power
            expect(await token.getVotes(member1.address)).to.equal(0);
            // member2 has delegated voting power (but needs to self-delegate first for their own)
            await token.connect(member2).delegate(member2.address);
            expect(await token.getVotes(member2.address)).to.equal(ethers.parseEther("150"));
        });

        it("should prevent token transfers (non-transferable)", async function () {
            await expect(
                token.connect(member1).transfer(member3.address, ethers.parseEther("10"))
            ).to.be.revertedWith("RepToken: Reputation is non-transferable");
        });
    });

    describe("Proposal Creation", function () {
        beforeEach(async function () {
            // Delegate voting power
            await token.connect(member1).delegate(member1.address);
            await token.connect(member2).delegate(member2.address);

            // Mine a block to activate delegation
            await time.increase(1);
        });

        it("should allow creating a mint proposal", async function () {
            const mintAmount = ethers.parseEther("50");
            const target = await token.getAddress();
            const value = 0;
            const calldata = token.interface.encodeFunctionData("mint", [recipient.address, mintAmount]);
            const description = "Mint 50 tokens to recipient";

            await expect(
                dao.connect(member1).propose([target], [value], [calldata], description)
            ).to.emit(dao, "ProposalCreated");
        });

        it("should prevent proposal creation below threshold", async function () {
            // member3 has no tokens
            const target = await token.getAddress();
            const calldata = token.interface.encodeFunctionData("mint", [recipient.address, ethers.parseEther("10")]);

            await expect(
                dao.connect(member3).propose([target], [0], [calldata], "Test")
            ).to.be.reverted; // Below proposal threshold
        });

        it("should allow creating a burn proposal", async function () {
            const burnAmount = ethers.parseEther("10");
            const target = await token.getAddress();
            const calldata = token.interface.encodeFunctionData("burn", [member1.address, burnAmount]);
            const description = "Burn 10 tokens from member1";

            await expect(
                dao.connect(member1).propose([target], [0], [calldata], description)
            ).to.emit(dao, "ProposalCreated");
        });

        it("should allow creating a registry update proposal", async function () {
            const target = await registry.getAddress();
            const calldata = registry.interface.encodeFunctionData("editRegistry", ["test.key", "test.value"]);
            const description = "Update registry with test key-value";

            await expect(
                dao.connect(member1).propose([target], [0], [calldata], description)
            ).to.emit(dao, "ProposalCreated");
        });
    });

    describe("Voting", function () {
        let proposalId;
        const description = "Mint 50 tokens to recipient";

        beforeEach(async function () {
            // Delegate and mine block
            await token.connect(member1).delegate(member1.address);
            await token.connect(member2).delegate(member2.address);
            await time.increase(1);

            // Create a proposal
            const target = await token.getAddress();
            const mintAmount = ethers.parseEther("50");
            const calldata = token.interface.encodeFunctionData("mint", [recipient.address, mintAmount]);

            const tx = await dao.connect(member1).propose([target], [0], [calldata], description);
            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = dao.interface.parseLog(log);
                    return parsed.name === "ProposalCreated";
                } catch {
                    return false;
                }
            });
            proposalId = dao.interface.parseLog(event).args.proposalId;

            // Wait for voting delay
            await time.increase(61); // 1 minute + 1 second
        });

        it("should allow voting on active proposals", async function () {
            // 1 = For, 0 = Against, 2 = Abstain
            await expect(
                dao.connect(member1).castVote(proposalId, 1)
            ).to.emit(dao, "VoteCast");
        });

        it("should count votes correctly", async function () {
            // A mint is constitutional (60% of all REP here): Against first, since member1's 100 of 150
            // For reaches the bar and closes the vote
            await dao.connect(member2).castVote(proposalId, 0); // Against: 50 tokens
            await dao.connect(member1).castVote(proposalId, 1); // For: 100 tokens

            const proposal = await dao.proposalVotes(proposalId);
            expect(proposal.forVotes).to.equal(ethers.parseEther("100"));
            expect(proposal.againstVotes).to.equal(ethers.parseEther("50"));
        });

        it("should prevent double voting", async function () {
            await dao.connect(member1).castVote(proposalId, 1);

            await expect(
                dao.connect(member1).castVote(proposalId, 1)
            ).to.be.reverted;
        });
    });

    describe("Proposal Queue & Execute", function () {
        let proposalId;
        const description = "Mint 50 tokens to recipient";
        let targets, values, calldatas, descriptionHash;

        beforeEach(async function () {
            // Setup
            await token.connect(member1).delegate(member1.address);
            await token.connect(member2).delegate(member2.address);
            await time.increase(1);

            // Create proposal
            const target = await token.getAddress();
            const mintAmount = ethers.parseEther("50");
            const calldata = token.interface.encodeFunctionData("mint", [recipient.address, mintAmount]);

            targets = [target];
            values = [0];
            calldatas = [calldata];
            descriptionHash = ethers.id(description);

            const tx = await dao.connect(member1).propose(targets, values, calldatas, description);
            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try { return dao.interface.parseLog(log).name === "ProposalCreated"; }
                catch { return false; }
            });
            proposalId = dao.interface.parseLog(event).args.proposalId;

            // Wait for voting delay and vote
            await time.increase(61);
            await dao.connect(member1).castVote(proposalId, 1); // Vote for

            // Wait for voting period to end
            await time.increase(121); // 2 minutes + 1 second
        });

        it("should allow queuing a successful proposal", async function () {
            await expect(
                dao.connect(member1).queue(targets, values, calldatas, descriptionHash)
            ).to.emit(dao, "ProposalQueued");
        });

        it("should execute a queued proposal after timelock delay", async function () {
            // Queue the proposal
            await dao.connect(member1).queue(targets, values, calldatas, descriptionHash);

            // Wait for timelock delay
            await time.increase(61); // 1 minute execution delay

            // Execute
            const recipientBalanceBefore = await token.balanceOf(recipient.address);

            await expect(
                dao.connect(member1).execute(targets, values, calldatas, descriptionHash)
            ).to.emit(dao, "ProposalExecuted");

            // Verify mint executed
            const recipientBalanceAfter = await token.balanceOf(recipient.address);
            expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(ethers.parseEther("50"));
        });

        it("should prevent execution before timelock delay", async function () {
            await dao.connect(member1).queue(targets, values, calldatas, descriptionHash);

            // Try to execute immediately
            await expect(
                dao.connect(member1).execute(targets, values, calldatas, descriptionHash)
            ).to.be.reverted;
        });
    });

    describe("Full Governance Cycle - Mint", function () {
        it("should complete full mint proposal lifecycle", async function () {
            // 1. Delegate
            await token.connect(member1).delegate(member1.address);
            await time.increase(1);

            // 2. Create mint proposal
            const mintAmount = ethers.parseEther("100");
            const targets = [await token.getAddress()];
            const values = [0];
            const calldatas = [token.interface.encodeFunctionData("mint", [recipient.address, mintAmount])];
            const description = "Mint 100 tokens to recipient";

            const proposeTx = await dao.connect(member1).propose(targets, values, calldatas, description);
            const proposeReceipt = await proposeTx.wait();
            const proposeEvent = proposeReceipt.logs.find(log => {
                try { return dao.interface.parseLog(log).name === "ProposalCreated"; }
                catch { return false; }
            });
            const proposalId = dao.interface.parseLog(proposeEvent).args.proposalId;

            // 3. Wait for voting to start
            await time.increase(61);

            // 4. Vote
            await dao.connect(member1).castVote(proposalId, 1);

            // 5. Wait for voting to end
            await time.increase(121);

            // 6. Queue
            await dao.connect(member1).queue(targets, values, calldatas, ethers.id(description));

            // 7. Wait for timelock
            await time.increase(61);

            // 8. Execute
            const recipientBalanceBefore = await token.balanceOf(recipient.address);
            await dao.connect(member1).execute(targets, values, calldatas, ethers.id(description));
            const recipientBalanceAfter = await token.balanceOf(recipient.address);

            // Verify
            expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(mintAmount);
            expect(await token.totalSupply()).to.equal(ethers.parseEther("250")); // 150 initial + 100 minted
        });
    });

    describe("Full Governance Cycle - Burn", function () {
        it("should complete full burn proposal lifecycle", async function () {
            // Delegate
            await token.connect(member1).delegate(member1.address);
            await time.increase(1);

            // Create burn proposal
            const burnAmount = ethers.parseEther("20");
            const targets = [await token.getAddress()];
            const values = [0];
            const calldatas = [token.interface.encodeFunctionData("burn", [member1.address, burnAmount])];
            const description = "Burn 20 tokens from member1";

            const proposeTx = await dao.connect(member1).propose(targets, values, calldatas, description);
            const proposeReceipt = await proposeTx.wait();
            const proposeEvent = proposeReceipt.logs.find(log => {
                try { return dao.interface.parseLog(log).name === "ProposalCreated"; }
                catch { return false; }
            });
            const proposalId = dao.interface.parseLog(proposeEvent).args.proposalId;

            // Vote
            await time.increase(61);
            await dao.connect(member1).castVote(proposalId, 1);

            // Queue
            await time.increase(121);
            await dao.connect(member1).queue(targets, values, calldatas, ethers.id(description));

            // Execute
            await time.increase(61);
            const member1BalanceBefore = await token.balanceOf(member1.address);
            await dao.connect(member1).execute(targets, values, calldatas, ethers.id(description));
            const member1BalanceAfter = await token.balanceOf(member1.address);

            // Verify
            expect(member1BalanceBefore - member1BalanceAfter).to.equal(burnAmount);
            expect(await token.totalSupply()).to.equal(ethers.parseEther("130")); // 150 initial - 20 burned
        });
    });

    describe("Treasury Operations - Native ETH", function () {
        it("should transfer native ETH from treasury via proposal", async function () {
            // Setup: Send ETH to the timelock (treasury)
            const timelockAddress = await timelock.getAddress();
            await member1.sendTransaction({
                to: timelockAddress,
                value: ethers.parseEther("10")
            });

            const timelockBalance = await ethers.provider.getBalance(timelockAddress);
            expect(timelockBalance).to.equal(ethers.parseEther("10"));

            // Delegate and create proposal
            await token.connect(member1).delegate(member1.address);
            await time.increase(1);

            // Propose to transfer 5 ETH to recipient
            const transferAmount = ethers.parseEther("5");
            const targets = [recipient.address];
            const values = [transferAmount];
            const calldatas = ["0x"]; // Empty calldata for ETH transfer
            const description = "Transfer 5 ETH to recipient";

            const proposeTx = await dao.connect(member1).propose(targets, values, calldatas, description);
            const proposeReceipt = await proposeTx.wait();
            const proposeEvent = proposeReceipt.logs.find(log => {
                try { return dao.interface.parseLog(log).name === "ProposalCreated"; }
                catch { return false; }
            });
            const proposalId = dao.interface.parseLog(proposeEvent).args.proposalId;

            // Vote
            await time.increase(61);
            await dao.connect(member1).castVote(proposalId, 1);

            // Queue
            await time.increase(121);
            await dao.connect(member1).queue(targets, values, calldatas, ethers.id(description));

            // Execute
            await time.increase(61);
            const recipientBalanceBefore = await ethers.provider.getBalance(recipient.address);
            await dao.connect(member1).execute(targets, values, calldatas, ethers.id(description));
            const recipientBalanceAfter = await ethers.provider.getBalance(recipient.address);

            // Verify
            expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(transferAmount);
            expect(await ethers.provider.getBalance(timelockAddress)).to.equal(ethers.parseEther("5"));
        });
    });

    describe("Treasury Operations - ERC20", function () {
        let testToken;

        beforeEach(async function () {
            // Deploy a test ERC20 token
            const TestERC20 = await ethers.getContractFactory("TestERC20");
            testToken = await TestERC20.deploy("Test Token", "TEST", 18, ethers.parseEther("1000"));

            // Send tokens to the timelock
            const timelockAddress = await timelock.getAddress();
            await testToken.transfer(timelockAddress, ethers.parseEther("100"));
        });

        it("should transfer ERC20 tokens from treasury via proposal", async function () {
            // Delegate
            await token.connect(member1).delegate(member1.address);
            await time.increase(1);

            // Create proposal to transfer ERC20
            const transferAmount = ethers.parseEther("50");
            const targets = [await testToken.getAddress()];
            const values = [0];
            const calldatas = [testToken.interface.encodeFunctionData("transfer", [recipient.address, transferAmount])];
            const description = "Transfer 50 TEST tokens to recipient";

            const proposeTx = await dao.connect(member1).propose(targets, values, calldatas, description);
            const proposeReceipt = await proposeTx.wait();
            const proposeEvent = proposeReceipt.logs.find(log => {
                try { return dao.interface.parseLog(log).name === "ProposalCreated"; }
                catch { return false; }
            });
            const proposalId = dao.interface.parseLog(proposeEvent).args.proposalId;

            // Vote
            await time.increase(61);
            await dao.connect(member1).castVote(proposalId, 1);

            // Queue
            await time.increase(121);
            await dao.connect(member1).queue(targets, values, calldatas, ethers.id(description));

            // Execute
            await time.increase(61);
            const recipientBalanceBefore = await testToken.balanceOf(recipient.address);
            await dao.connect(member1).execute(targets, values, calldatas, ethers.id(description));
            const recipientBalanceAfter = await testToken.balanceOf(recipient.address);

            // Verify
            expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(transferAmount);
            expect(await testToken.balanceOf(await timelock.getAddress())).to.equal(ethers.parseEther("50"));
        });
    });

    describe("DAO Settings Updates", function () {
        beforeEach(async function () {
            await token.connect(member1).delegate(member1.address);
            await time.increase(1);
        });

        it("should update voting period via proposal", async function () {
            const currentVotingPeriod = await dao.votingPeriod();
            const newVotingPeriod = 300; // 5 minutes in seconds (changed from 2 minutes)

            // Create proposal to update voting period
            const targets = [await dao.getAddress()];
            const values = [0];
            const calldatas = [dao.interface.encodeFunctionData("setVotingPeriod", [newVotingPeriod])];
            const description = "Update voting period to 5 minutes";

            const proposeTx = await dao.connect(member1).propose(targets, values, calldatas, description);
            const proposeReceipt = await proposeTx.wait();
            const proposeEvent = proposeReceipt.logs.find(log => {
                try { return dao.interface.parseLog(log).name === "ProposalCreated"; }
                catch { return false; }
            });
            const proposalId = dao.interface.parseLog(proposeEvent).args.proposalId;

            // Vote, queue, execute
            await time.increase(61);
            await dao.connect(member1).castVote(proposalId, 1);
            await time.increase(121);
            await dao.connect(member1).queue(targets, values, calldatas, ethers.id(description));
            await time.increase(61);
            await dao.connect(member1).execute(targets, values, calldatas, ethers.id(description));

            // Verify
            expect(await dao.votingPeriod()).to.equal(newVotingPeriod);
            expect(await dao.votingPeriod()).to.not.equal(currentVotingPeriod);
        });

        it("should update voting delay via proposal", async function () {
            const newVotingDelay = 120; // 2 minutes in seconds

            const targets = [await dao.getAddress()];
            const values = [0];
            const calldatas = [dao.interface.encodeFunctionData("setVotingDelay", [newVotingDelay])];
            const description = "Update voting delay to 2 minutes";

            const proposeTx = await dao.connect(member1).propose(targets, values, calldatas, description);
            const proposeReceipt = await proposeTx.wait();
            const proposeEvent = proposeReceipt.logs.find(log => {
                try { return dao.interface.parseLog(log).name === "ProposalCreated"; }
                catch { return false; }
            });
            const proposalId = dao.interface.parseLog(proposeEvent).args.proposalId;

            await time.increase(61);
            await dao.connect(member1).castVote(proposalId, 1);
            await time.increase(121);
            await dao.connect(member1).queue(targets, values, calldatas, ethers.id(description));
            await time.increase(61);
            await dao.connect(member1).execute(targets, values, calldatas, ethers.id(description));

            expect(await dao.votingDelay()).to.equal(newVotingDelay);
        });

        it("should update proposal threshold via proposal", async function () {
            const newThreshold = ethers.parseEther("10");

            const targets = [await dao.getAddress()];
            const values = [0];
            const calldatas = [dao.interface.encodeFunctionData("setProposalThreshold", [newThreshold])];
            const description = "Update proposal threshold to 10 tokens";

            const proposeTx = await dao.connect(member1).propose(targets, values, calldatas, description);
            const proposeReceipt = await proposeTx.wait();
            const proposeEvent = proposeReceipt.logs.find(log => {
                try { return dao.interface.parseLog(log).name === "ProposalCreated"; }
                catch { return false; }
            });
            const proposalId = dao.interface.parseLog(proposeEvent).args.proposalId;

            await time.increase(61);
            await dao.connect(member1).castVote(proposalId, 1);
            await time.increase(121);
            await dao.connect(member1).queue(targets, values, calldatas, ethers.id(description));
            await time.increase(61);
            await dao.connect(member1).execute(targets, values, calldatas, ethers.id(description));

            expect(await dao.proposalThreshold()).to.equal(newThreshold);
        });

        it("should update quorum via proposal", async function () {
            const newQuorum = 10; // 10%

            const targets = [await dao.getAddress()];
            const values = [0];
            const calldatas = [dao.interface.encodeFunctionData("updateQuorumNumerator", [newQuorum])];
            const description = "Update quorum to 10%";

            const proposeTx = await dao.connect(member1).propose(targets, values, calldatas, description);
            const proposeReceipt = await proposeTx.wait();
            const proposeEvent = proposeReceipt.logs.find(log => {
                try { return dao.interface.parseLog(log).name === "ProposalCreated"; }
                catch { return false; }
            });
            const proposalId = dao.interface.parseLog(proposeEvent).args.proposalId;

            await time.increase(61);
            await dao.connect(member1).castVote(proposalId, 1);
            await time.increase(121);
            await dao.connect(member1).queue(targets, values, calldatas, ethers.id(description));
            await time.increase(61);
            await dao.connect(member1).execute(targets, values, calldatas, ethers.id(description));

            expect(await dao.quorumNumerator()).to.equal(newQuorum);
        });

        it("should update timelock minimum delay via proposal", async function () {
            const newMinDelay = 300; // 5 minutes

            const timelockAddress = await timelock.getAddress();
            const targets = [timelockAddress];
            const values = [0];
            const calldatas = [timelock.interface.encodeFunctionData("updateDelay", [newMinDelay])];
            const description = "Update timelock delay to 5 minutes";

            const proposeTx = await dao.connect(member1).propose(targets, values, calldatas, description);
            const proposeReceipt = await proposeTx.wait();
            const proposeEvent = proposeReceipt.logs.find(log => {
                try { return dao.interface.parseLog(log).name === "ProposalCreated"; }
                catch { return false; }
            });
            const proposalId = dao.interface.parseLog(proposeEvent).args.proposalId;

            await time.increase(61);
            await dao.connect(member1).castVote(proposalId, 1);
            await time.increase(121);
            await dao.connect(member1).queue(targets, values, calldatas, ethers.id(description));
            await time.increase(61);
            await dao.connect(member1).execute(targets, values, calldatas, ethers.id(description));

            expect(await timelock.getMinDelay()).to.equal(newMinDelay);
        });
    });
});
