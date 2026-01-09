const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Debates (Per-Network Model)", function () {
    let deployer, member1, member2, member3;
    let repToken, repToken2, debatesFactory;
    let debate;

    const INITIAL_TOKENS = ethers.parseEther("100");
    const ROOT_WEIGHT = ethers.parseEther("10");

    beforeEach(async function () {
        [deployer, member1, member2, member3] = await ethers.getSigners();

        // Deploy a minimal RepToken for testing (DAO 1)
        const RepTokenFactory = await ethers.getContractFactory("RepToken");
        repToken = await RepTokenFactory.deploy(
            "Test Token",
            "TEST",
            deployer.address, // registry (not used in debates)
            deployer.address, // admin
            [member1.address, member2.address, member3.address],
            [INITIAL_TOKENS, INITIAL_TOKENS, INITIAL_TOKENS],
            false // non-transferable
        );
        await repToken.waitForDeployment();

        // Deploy a second RepToken (DAO 2) for multi-DAO tests
        repToken2 = await RepTokenFactory.deploy(
            "Second Token",
            "TEST2",
            deployer.address,
            deployer.address,
            [member1.address, member2.address],
            [INITIAL_TOKENS, INITIAL_TOKENS],
            false
        );
        await repToken2.waitForDeployment();

        // Members must delegate to themselves to have voting power
        await repToken.connect(member1).delegate(member1.address);
        await repToken.connect(member2).delegate(member2.address);
        await repToken.connect(member3).delegate(member3.address);
        await repToken2.connect(member1).delegate(member1.address);
        await repToken2.connect(member2).delegate(member2.address);

        // Deploy DebatesFactory (per-network: no constructor params)
        const DebatesFactory = await ethers.getContractFactory("DebatesFactory");
        debatesFactory = await DebatesFactory.deploy();
        await debatesFactory.waitForDeployment();
    });

    describe("DebatesFactory", function () {
        it("should create a debate for a DAO", async function () {
            const tokenAddr = await repToken.getAddress();
            const tx = await debatesFactory.connect(member1).createDebate(
                tokenAddr,
                "Test Debate",
                "This is the root thesis",
                ROOT_WEIGHT
            );
            const receipt = await tx.wait();

            // Check event
            const event = receipt.logs.find(
                log => log.fragment && log.fragment.name === "DebateCreated"
            );
            expect(event).to.not.be.undefined;
            expect(event.args.token).to.equal(tokenAddr);

            // Check debate count
            expect(await debatesFactory.getDebateCount()).to.equal(1);
            expect(await debatesFactory.getDebateCountByToken(tokenAddr)).to.equal(1);
        });

        it("should reject zero address token", async function () {
            await expect(
                debatesFactory.connect(member1).createDebate(
                    ethers.ZeroAddress,
                    "Test",
                    "Thesis",
                    ROOT_WEIGHT
                )
            ).to.be.revertedWith("Invalid token address");
        });

        it("should track debates per token", async function () {
            const token1 = await repToken.getAddress();
            const token2 = await repToken2.getAddress();

            // Create 2 debates for DAO 1
            await debatesFactory.connect(member1).createDebate(token1, "DAO1 Debate 1", "Thesis", ROOT_WEIGHT);
            await debatesFactory.connect(member2).createDebate(token1, "DAO1 Debate 2", "Thesis", ROOT_WEIGHT);

            // Create 1 debate for DAO 2
            await debatesFactory.connect(member1).createDebate(token2, "DAO2 Debate 1", "Thesis", ROOT_WEIGHT);

            // Check global count
            expect(await debatesFactory.getDebateCount()).to.equal(3);

            // Check per-token counts
            expect(await debatesFactory.getDebateCountByToken(token1)).to.equal(2);
            expect(await debatesFactory.getDebateCountByToken(token2)).to.equal(1);

            // Check per-token lists
            const dao1Debates = await debatesFactory.getDebatesByToken(token1);
            const dao2Debates = await debatesFactory.getDebatesByToken(token2);
            expect(dao1Debates.length).to.equal(2);
            expect(dao2Debates.length).to.equal(1);
        });

        it("should return debate list with token info", async function () {
            const token1 = await repToken.getAddress();
            const token2 = await repToken2.getAddress();

            await debatesFactory.connect(member1).createDebate(token1, "Debate 1", "Thesis 1", ROOT_WEIGHT);
            await debatesFactory.connect(member2).createDebate(token2, "Debate 2", "Thesis 2", ROOT_WEIGHT);

            const list = await debatesFactory.getDebateList();
            expect(list.length).to.equal(2);
            expect(list[0].title).to.equal("Debate 1");
            expect(list[0].token).to.equal(token1);
            expect(list[1].title).to.equal("Debate 2");
            expect(list[1].token).to.equal(token2);
        });

        it("should return filtered list by token", async function () {
            const token1 = await repToken.getAddress();
            const token2 = await repToken2.getAddress();

            await debatesFactory.connect(member1).createDebate(token1, "DAO1 Debate", "Thesis", ROOT_WEIGHT);
            await debatesFactory.connect(member2).createDebate(token2, "DAO2 Debate", "Thesis", ROOT_WEIGHT);

            const dao1List = await debatesFactory.getDebateListByToken(token1);
            const dao2List = await debatesFactory.getDebateListByToken(token2);

            expect(dao1List.length).to.equal(1);
            expect(dao1List[0].title).to.equal("DAO1 Debate");
            expect(dao2List.length).to.equal(1);
            expect(dao2List[0].title).to.equal("DAO2 Debate");
        });

        it("should return empty arrays for unknown token", async function () {
            const unknownToken = "0x1234567890123456789012345678901234567890";

            const debates = await debatesFactory.getDebatesByToken(unknownToken);
            const count = await debatesFactory.getDebateCountByToken(unknownToken);
            const list = await debatesFactory.getDebateListByToken(unknownToken);

            expect(debates.length).to.equal(0);
            expect(count).to.equal(0);
            expect(list.length).to.equal(0);
        });
    });

    describe("Debate Contract", function () {
        beforeEach(async function () {
            // Create a debate for testing
            const tokenAddr = await repToken.getAddress();
            const tx = await debatesFactory.connect(member1).createDebate(
                tokenAddr,
                "Test Debate",
                "Should we implement feature X?",
                ROOT_WEIGHT
            );
            const receipt = await tx.wait();
            const event = receipt.logs.find(
                log => log.fragment && log.fragment.name === "DebateCreated"
            );
            const debateAddress = event.args.debateAddress;

            debate = await ethers.getContractAt("Debate", debateAddress);
        });

        it("should have correct initial state", async function () {
            expect(await debate.title()).to.equal("Test Debate");
            expect(await debate.token()).to.equal(await repToken.getAddress());
            expect(await debate.creator()).to.equal(member1.address);
            expect(await debate.isOpen()).to.equal(true);
            expect(await debate.totalStakedWeight()).to.equal(ROOT_WEIGHT);
        });

        it("should return full debate with root argument", async function () {
            const fullDebate = await debate.getFullDebate();

            expect(fullDebate.title).to.equal("Test Debate");
            expect(fullDebate.isOpen).to.equal(true);
            expect(fullDebate.argumentCount).to.equal(1);
            expect(fullDebate.arguments.length).to.equal(1);

            // Check root argument
            const root = fullDebate.arguments[0];
            expect(root.id).to.equal(1);
            expect(root.parentId).to.equal(0); // Root has no parent
            expect(root.content).to.equal("Should we implement feature X?");
            expect(root.directWeight).to.equal(ROOT_WEIGHT);
            expect(root.netScore).to.equal(ROOT_WEIGHT);
            expect(root.author).to.equal(member1.address);
        });

        it("should track remaining voting power", async function () {
            const remaining = await debate.getRemainingVotingPower(member1.address);
            expect(remaining).to.equal(INITIAL_TOKENS - ROOT_WEIGHT);

            // member2 hasn't participated yet
            const member2Remaining = await debate.getRemainingVotingPower(member2.address);
            expect(member2Remaining).to.equal(INITIAL_TOKENS);
        });

        describe("Adding Arguments", function () {
            it("should add a PRO argument", async function () {
                const weight = ethers.parseEther("5");

                const tx = await debate.connect(member2).addArgument(
                    1, // parentId (root)
                    0, // ArgumentType.PRO
                    weight,
                    "I support this because..."
                );
                await tx.wait();

                const fullDebate = await debate.getFullDebate();
                expect(fullDebate.argumentCount).to.equal(2);

                // Check the new argument
                const proArg = fullDebate.arguments[1];
                expect(proArg.id).to.equal(2);
                expect(proArg.parentId).to.equal(1);
                expect(proArg.argType).to.equal(0); // PRO
                expect(proArg.directWeight).to.equal(weight);
                expect(proArg.author).to.equal(member2.address);

                // Root should have this as a pro child
                const root = fullDebate.arguments[0];
                expect(root.proChildIds.length).to.equal(1);
                expect(root.proChildIds[0]).to.equal(2);
            });

            it("should add a CON argument", async function () {
                const weight = ethers.parseEther("5");

                await debate.connect(member2).addArgument(
                    1, // parentId (root)
                    1, // ArgumentType.CON
                    weight,
                    "I oppose this because..."
                );

                const fullDebate = await debate.getFullDebate();
                const root = fullDebate.arguments[0];
                expect(root.conChildIds.length).to.equal(1);
                expect(root.conChildIds[0]).to.equal(2);
            });

            it("should fail without sufficient voting power", async function () {
                const tooMuchWeight = ethers.parseEther("200"); // More than member has

                await expect(
                    debate.connect(member2).addArgument(1, 0, tooMuchWeight, "Content")
                ).to.be.revertedWith("Insufficient voting power");
            });

            it("should fail with invalid parent ID", async function () {
                await expect(
                    debate.connect(member2).addArgument(999, 0, ethers.parseEther("1"), "Content")
                ).to.be.revertedWith("Invalid parent ID");
            });

            it("should fail with zero weight", async function () {
                await expect(
                    debate.connect(member2).addArgument(1, 0, 0, "Content")
                ).to.be.revertedWith("Weight must be positive");
            });

            it("should fail with empty content", async function () {
                await expect(
                    debate.connect(member2).addArgument(1, 0, ethers.parseEther("1"), "")
                ).to.be.revertedWith("Content required");
            });
        });

        describe("Net Score Calculation", function () {
            it("should calculate net score with PRO children", async function () {
                const proWeight = ethers.parseEther("5");

                await debate.connect(member2).addArgument(1, 0, proWeight, "Pro argument");

                const fullDebate = await debate.getFullDebate();
                const root = fullDebate.arguments[0];

                // Root netScore = directWeight + proChild.netScore
                // = 10 + 5 = 15
                expect(root.netScore).to.equal(ROOT_WEIGHT + proWeight);
            });

            it("should calculate net score with CON children", async function () {
                const conWeight = ethers.parseEther("3");

                await debate.connect(member2).addArgument(1, 1, conWeight, "Con argument");

                const fullDebate = await debate.getFullDebate();
                const root = fullDebate.arguments[0];

                // Root netScore = directWeight - conChild.netScore
                // = 10 - 3 = 7
                expect(root.netScore).to.equal(ROOT_WEIGHT - conWeight);
            });

            it("should calculate net score with mixed children", async function () {
                const proWeight = ethers.parseEther("8");
                const conWeight = ethers.parseEther("5");

                await debate.connect(member2).addArgument(1, 0, proWeight, "Pro");
                await debate.connect(member3).addArgument(1, 1, conWeight, "Con");

                const fullDebate = await debate.getFullDebate();
                const root = fullDebate.arguments[0];

                // Root netScore = directWeight + pro - con
                // = 10 + 8 - 5 = 13
                expect(root.netScore).to.equal(ROOT_WEIGHT + proWeight - conWeight);
            });

            it("should propagate scores up the tree", async function () {
                // Create: Root <- Pro <- ConOfPro
                const proWeight = ethers.parseEther("6");
                const conOfProWeight = ethers.parseEther("2");

                // Add pro to root
                await debate.connect(member2).addArgument(1, 0, proWeight, "Pro argument");
                // Add con to the pro (argument id 2)
                await debate.connect(member3).addArgument(2, 1, conOfProWeight, "Counter to pro");

                const fullDebate = await debate.getFullDebate();
                const root = fullDebate.arguments[0];
                const pro = fullDebate.arguments[1];
                const conOfPro = fullDebate.arguments[2];

                // ConOfPro netScore = 2 (no children)
                expect(conOfPro.netScore).to.equal(conOfProWeight);

                // Pro netScore = 6 - 2 = 4
                expect(pro.netScore).to.equal(proWeight - conOfProWeight);

                // Root netScore = 10 + 4 = 14
                expect(root.netScore).to.equal(ROOT_WEIGHT + (proWeight - conOfProWeight));
            });

            it("should update debate sentiment", async function () {
                // Initially sentiment = root netScore = 10
                expect(await debate.getDebateSentiment()).to.equal(ROOT_WEIGHT);

                // Add a con argument
                await debate.connect(member2).addArgument(1, 1, ethers.parseEther("15"), "Strong opposition");

                // Sentiment = 10 - 15 = -5
                expect(await debate.getDebateSentiment()).to.equal(ROOT_WEIGHT - ethers.parseEther("15"));
            });
        });

        describe("Adding Weight", function () {
            it("should add weight to existing argument", async function () {
                const additionalWeight = ethers.parseEther("5");

                await debate.connect(member2).addWeight(1, additionalWeight);

                const fullDebate = await debate.getFullDebate();
                const root = fullDebate.arguments[0];

                expect(root.directWeight).to.equal(ROOT_WEIGHT + additionalWeight);
                expect(root.netScore).to.equal(ROOT_WEIGHT + additionalWeight);
            });

            it("should update parent scores when adding weight to child", async function () {
                // Add a pro argument
                await debate.connect(member2).addArgument(1, 0, ethers.parseEther("5"), "Pro");

                // Add weight to the pro argument
                await debate.connect(member3).addWeight(2, ethers.parseEther("3"));

                const fullDebate = await debate.getFullDebate();
                const root = fullDebate.arguments[0];
                const pro = fullDebate.arguments[1];

                // Pro netScore = 5 + 3 = 8
                expect(pro.netScore).to.equal(ethers.parseEther("8"));

                // Root netScore = 10 + 8 = 18
                expect(root.netScore).to.equal(ROOT_WEIGHT + ethers.parseEther("8"));
            });

            it("should track voting power used across addWeight", async function () {
                await debate.connect(member2).addWeight(1, ethers.parseEther("30"));

                const remaining = await debate.getRemainingVotingPower(member2.address);
                expect(remaining).to.equal(INITIAL_TOKENS - ethers.parseEther("30"));
            });

            it("should fail without sufficient voting power", async function () {
                await expect(
                    debate.connect(member2).addWeight(1, ethers.parseEther("200"))
                ).to.be.revertedWith("Insufficient voting power");
            });
        });

        describe("Closing Debate", function () {
            it("should allow creator to close debate", async function () {
                await debate.connect(member1).closeDebate();
                expect(await debate.isOpen()).to.equal(false);
            });

            it("should not allow non-creator to close", async function () {
                await expect(
                    debate.connect(member2).closeDebate()
                ).to.be.revertedWith("Only creator can close");
            });

            it("should not allow adding arguments to closed debate", async function () {
                await debate.connect(member1).closeDebate();

                await expect(
                    debate.connect(member2).addArgument(1, 0, ethers.parseEther("1"), "Too late")
                ).to.be.revertedWith("Debate is closed");
            });

            it("should not allow adding weight to closed debate", async function () {
                await debate.connect(member1).closeDebate();

                await expect(
                    debate.connect(member2).addWeight(1, ethers.parseEther("1"))
                ).to.be.revertedWith("Debate is closed");
            });
        });

        describe("getArgument", function () {
            it("should return individual argument", async function () {
                const arg = await debate.getArgument(1);
                expect(arg.id).to.equal(1);
                expect(arg.content).to.equal("Should we implement feature X?");
            });

            it("should fail for invalid ID", async function () {
                await expect(debate.getArgument(999)).to.be.revertedWith("Invalid argument ID");
                await expect(debate.getArgument(0)).to.be.revertedWith("Invalid argument ID");
            });
        });
    });

    describe("Multi-DAO Scenario", function () {
        it("should isolate voting power between DAOs", async function () {
            const token1 = await repToken.getAddress();
            const token2 = await repToken2.getAddress();

            // Create debate for DAO 1
            let tx = await debatesFactory.connect(member1).createDebate(
                token1, "DAO1 Debate", "Thesis", ROOT_WEIGHT
            );
            let receipt = await tx.wait();
            let event = receipt.logs.find(log => log.fragment?.name === "DebateCreated");
            const debate1 = await ethers.getContractAt("Debate", event.args.debateAddress);

            // Create debate for DAO 2
            tx = await debatesFactory.connect(member1).createDebate(
                token2, "DAO2 Debate", "Thesis", ROOT_WEIGHT
            );
            receipt = await tx.wait();
            event = receipt.logs.find(log => log.fragment?.name === "DebateCreated");
            const debate2 = await ethers.getContractAt("Debate", event.args.debateAddress);

            // Voting power in DAO1 debate uses DAO1 token
            const remaining1 = await debate1.getRemainingVotingPower(member1.address);
            expect(remaining1).to.equal(INITIAL_TOKENS - ROOT_WEIGHT);

            // Voting power in DAO2 debate uses DAO2 token (separate)
            const remaining2 = await debate2.getRemainingVotingPower(member1.address);
            expect(remaining2).to.equal(INITIAL_TOKENS - ROOT_WEIGHT);
        });

        it("should allow same user to participate in multiple DAO debates", async function () {
            const token1 = await repToken.getAddress();
            const token2 = await repToken2.getAddress();

            // Create debates for both DAOs
            let tx = await debatesFactory.connect(member1).createDebate(
                token1, "DAO1 Debate", "Thesis", ROOT_WEIGHT
            );
            let receipt = await tx.wait();
            let event = receipt.logs.find(log => log.fragment?.name === "DebateCreated");
            const debate1 = await ethers.getContractAt("Debate", event.args.debateAddress);

            tx = await debatesFactory.connect(member1).createDebate(
                token2, "DAO2 Debate", "Thesis", ROOT_WEIGHT
            );
            receipt = await tx.wait();
            event = receipt.logs.find(log => log.fragment?.name === "DebateCreated");
            const debate2 = await ethers.getContractAt("Debate", event.args.debateAddress);

            // Member2 adds arguments to both debates
            await debate1.connect(member2).addArgument(1, 0, ethers.parseEther("20"), "Support in DAO1");
            await debate2.connect(member2).addArgument(1, 1, ethers.parseEther("30"), "Oppose in DAO2");

            // Check both debates have the arguments
            const fullDebate1 = await debate1.getFullDebate();
            const fullDebate2 = await debate2.getFullDebate();

            expect(fullDebate1.argumentCount).to.equal(2);
            expect(fullDebate2.argumentCount).to.equal(2);

            // Remaining power is independent per debate (per token)
            const remaining1 = await debate1.getRemainingVotingPower(member2.address);
            const remaining2 = await debate2.getRemainingVotingPower(member2.address);

            expect(remaining1).to.equal(INITIAL_TOKENS - ethers.parseEther("20"));
            expect(remaining2).to.equal(INITIAL_TOKENS - ethers.parseEther("30"));
        });
    });
});
