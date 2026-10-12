const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { passCoolingOff } = require("./helpers/coolingOff");

// Regression tests for the factory hijack and zero-cost REP farming fixed in Oct 2026.
describe("Security", function () {
    describe("TrustlessFactory deployment binding", function () {
        let victim, attacker, member;
        let trustlessFactory, nativeProjectImpl, erc20ProjectImpl;

        const tokenParams = (member) => ({
            name: "Token", symbol: "TKN",
            initialMembers: [member.address],
            initialAmounts: [ethers.parseEther("100")],
        });
        const govParams = (name) => ({
            name, votingDelay: 1, votingPeriod: 5,
            proposalThreshold: ethers.parseEther("1"), quorumFraction: 4,
        });
        const economyParams = {
            arbitrationFeeBps: 500,
            initialPlatformFeeBps: 100,
            initialAuthorFeeBps: 100,
            initialCoolingOffPeriod: 60,
            initialBackersQuorumBps: 7000,
            initialProjectThreshold: 0,
            initialAppealPeriod: 120,
        };

        async function deployInfra(signer) {
            const receipt = await (await trustlessFactory.connect(signer).deployInfrastructure(1, 500)).wait();
            return receipt.logs.find(log => log.eventName === "InfrastructureDeployed").args;
        }

        async function deployDaoToken(signer, registry, timelock, name) {
            const receipt = await (await trustlessFactory.connect(signer)
                .deployDAOToken(registry, timelock, tokenParams(member), govParams(name))).wait();
            return receipt.logs.find(log => log.eventName === "DAOTokenDeployed").args;
        }

        async function addressParams(economy, registry, timelock, repToken, dao) {
            return {
                implAddresses: [await nativeProjectImpl.getAddress(), await erc20ProjectImpl.getAddress()],
                contractAddresses: [economy, registry, timelock, repToken, dao],
            };
        }

        beforeEach(async function () {
            [victim, attacker, member] = await ethers.getSigners();
            nativeProjectImpl = await (await ethers.getContractFactory("NativeProject")).deploy();
            erc20ProjectImpl = await (await ethers.getContractFactory("ERC20Project")).deploy();
            const infraFactory = await (await ethers.getContractFactory("InfrastructureFactory")).deploy();
            const daoFactory = await (await ethers.getContractFactory("DAOFactory")).deploy();
            const repTokenFactory = await (await ethers.getContractFactory("RepTokenFactory")).deploy();
            const economyFactory = await (await ethers.getContractFactory("EconomyFactory")).deploy();
            trustlessFactory = await (await ethers.getContractFactory("TrustlessFactory")).deploy(
                await infraFactory.getAddress(), await daoFactory.getAddress(),
                await economyFactory.getAddress(), await repTokenFactory.getAddress()
            );
        });

        it("rejects deployDAOToken against someone else's infrastructure", async function () {
            const { registry, timelock } = await deployInfra(victim);
            await expect(deployDaoToken(attacker, registry, timelock, "Evil"))
                .to.be.revertedWith("No infrastructure pending for caller");

            // Attacker with their own pending infra still can't point at the victim's
            await deployInfra(attacker);
            await expect(deployDaoToken(attacker, registry, timelock, "Evil"))
                .to.be.revertedWith("Not the caller's infrastructure");
        });

        it("rejects configureAndFinalize of someone else's deployment with a rogue governor", async function () {
            const { economy, registry, timelock } = await deployInfra(victim);
            const { repToken, dao } = await deployDaoToken(victim, registry, timelock, "Victim DAO");

            // Attacker builds their own governor and tries to finalize the victim's suite with it
            const mine = await deployInfra(attacker);
            const rogue = await deployDaoToken(attacker, mine.registry, mine.timelock, "Rogue");
            await expect(trustlessFactory.connect(attacker).configureAndFinalize(
                await addressParams(economy, registry, timelock, repToken, rogue.dao), economyParams, [], []
            )).to.be.revertedWith("Addresses do not match caller's deployment");

            // The victim can still finalize, and their governor holds the proposer role
            await trustlessFactory.connect(victim).configureAndFinalize(
                await addressParams(economy, registry, timelock, repToken, dao), economyParams, [], []
            );
            const tl = await ethers.getContractAt(
                "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController", timelock);
            expect(await tl.hasRole(await tl.PROPOSER_ROLE(), dao)).to.be.true;
            expect(await tl.hasRole(await tl.PROPOSER_ROLE(), rogue.dao)).to.be.false;
        });

        it("does not let outsiders configure a half-deployed economy", async function () {
            const { economy } = await deployInfra(victim);
            const econ = await ethers.getContractAt("Economy", economy);
            expect(await econ.admin()).to.equal(await trustlessFactory.getAddress());
            await expect(econ.connect(attacker).setImplementations(attacker.address, attacker.address))
                .to.be.revertedWith("Protected");
            await expect(econ.connect(attacker).setDaoAddresses(
                attacker.address, attacker.address, attacker.address, attacker.address
            )).to.be.revertedWith("Protected");
        });

        it("keeps project cooling-off at least a full proposal lifecycle plus a day, even with parties set at creation", async function () {
            const { economy, registry, timelock } = await deployInfra(victim);
            const { repToken, dao } = await deployDaoToken(victim, registry, timelock, "Victim DAO");
            await trustlessFactory.connect(victim).configureAndFinalize(
                await addressParams(economy, registry, timelock, repToken, dao), economyParams, [], []
            );
            const econ = await ethers.getContractAt("Economy", economy);
            const gov = await ethers.getContractAt("HomebaseDAO", dao);
            const tl = await ethers.getContractAt(
                "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController", timelock);

            const lifecycle = (await gov.votingDelay()) + (await gov.votingPeriod()) + (await tl.getMinDelay());
            expect(await econ.coolingOffPeriod()).to.equal(60n);
            expect(lifecycle).to.be.gt(60n);
            const floor = lifecycle + (await econ.COOLING_OFF_BUFFER());
            expect(await econ.effectiveCoolingOffPeriod()).to.equal(floor);
            // The DAO overrules by proposal, so the appeal window fits a lifecycle plus two days
            const appealFloor = lifecycle + (await econ.APPEAL_BUFFER());
            const appealPeriod = await econ.appealPeriod();
            expect(await econ.effectiveAppealPeriod()).to.equal(appealPeriod > appealFloor ? appealPeriod : appealFloor);

            // Parties named at creation: the contractor still has to wait out the full lifecycle
            const receipt = await (await econ.connect(member).createProject(
                "p", attacker.address, victim.address, "t", "r", "d")).wait();
            const addr = receipt.logs.find(l => l.eventName === "NewProject").args.contractAddress;
            const project = await ethers.getContractAt("NativeProject", addr);
            await project.connect(member).sendFunds({ value: ethers.parseEther("1") });
            await expect(project.connect(attacker).signContract({ value: ethers.parseEther("0.025") }))
                .to.be.revertedWith("Contract signing is blocked during the cooling-off period.");
            await time.increase(lifecycle);
            await expect(project.connect(attacker).signContract({ value: ethers.parseEther("0.025") }))
                .to.be.revertedWith("Contract signing is blocked during the cooling-off period.");
            await time.increase(floor - lifecycle);
            await passCoolingOff(project);
            await project.connect(attacker).signContract({ value: ethers.parseEther("0.025") });
        });

        it("bounds the author and arbitration fees", async function () {
            const econ = await (await ethers.getContractFactory("Economy")).deploy(500);
            await expect(econ.setAuthorFee(2501)).to.be.revertedWith("Author fee too high");
            await expect(econ.setArbitrationFee(2501)).to.be.revertedWith("Arbitration fee too high");
            await econ.setAuthorFee(2500);
            await econ.setArbitrationFee(2500);
            await expect((await ethers.getContractFactory("Economy")).deploy(2501)).to.be.revertedWith("Arbitration fee too high");
        });
    });

    describe("Reputation farming", function () {
        const PLATFORM_FEE_BPS = 100n; // the floor
        const AUTHOR_FEE_BPS = 100n;
        let deployer, timelock, alice, aliceAlt;
        let economy, registry, repToken, testToken;

        beforeEach(async function () {
            [deployer, timelock, alice, aliceAlt] = await ethers.getSigners();

            registry = await (await ethers.getContractFactory("Registry")).deploy(timelock.address, deployer.address);
            const nativeImpl = await (await ethers.getContractFactory("NativeProject")).deploy();
            const erc20Impl = await (await ethers.getContractFactory("ERC20Project")).deploy();
            economy = await (await ethers.getContractFactory("Economy")).deploy(500);
            await economy.setImplementations(await nativeImpl.getAddress(), await erc20Impl.getAddress());

            repToken = await (await ethers.getContractFactory("RepToken")).deploy(
                "Jurisdiction", "JUR", await registry.getAddress(), timelock.address, [], [], false);
            await repToken.setAdmin(timelock.address);
            await repToken.connect(timelock).setEconomyAddress(await economy.getAddress());
            await economy.setCoolingOffPeriod(0); // no governance lifecycle to wait for in this fixture
            await economy.setDaoAddresses(timelock.address, await registry.getAddress(), deployer.address, await repToken.getAddress());
            await economy.connect(timelock).setPlatformFee(PLATFORM_FEE_BPS);
            await economy.connect(timelock).setAuthorFee(AUTHOR_FEE_BPS);

            testToken = await (await ethers.getContractFactory("TestToken")).deploy();
            await testToken.transfer(alice.address, ethers.parseEther("10000"));
            await testToken.transfer(aliceAlt.address, ethers.parseEther("10000"));
            const parityKey = `jurisdiction.parity.${(await testToken.getAddress()).toLowerCase()}`;
            await registry.connect(timelock).editRegistry(parityKey, ethers.parseEther("1").toString());
        });

        it("rejects a platform fee below the floor", async function () {
            await expect(economy.connect(timelock).setPlatformFee(0)).to.be.revertedWith("Platform fee out of range");
            await expect(economy.connect(timelock).setPlatformFee(99)).to.be.revertedWith("Platform fee out of range");
        });

        it("wash trading via immediate release + reimburse pays the treasury for every REP minted", async function () {
            // Alice is author, backer and arbiter; her second wallet is the contractor.
            const amount = ethers.parseEther("1000");
            const tokenAddr = await testToken.getAddress();
            const registryAddr = await registry.getAddress();

            const startBalances = (await testToken.balanceOf(alice.address)) + (await testToken.balanceOf(aliceAlt.address));
            const treasuryBefore = await testToken.balanceOf(registryAddr);

            for (let i = 0; i < 3; i++) {
                const receipt = await (await economy.connect(alice).createERC20Project(
                    "wash", aliceAlt.address, alice.address, "t", "r", "d", tokenAddr)).wait();
                const addr = receipt.logs.find(log => log.eventName === "NewProject").args.contractAddress;
                const project = await ethers.getContractAt("ERC20Project", addr);

                await testToken.connect(alice).approve(addr, amount);
                await project.connect(alice).sendFundsWithImmediate(amount, 2000); // 20% immediate
                const stake = ((amount * 8000n / 10000n) * 500n / 10000n) / 2n;
                await testToken.connect(aliceAlt).approve(addr, stake);
                await passCoolingOff(project);
                await project.connect(aliceAlt).signContract();
                await project.connect(aliceAlt).reimburse();
                await project.connect(alice).withdrawAsContributor();
                await project.connect(aliceAlt).reclaimArbitrationStake();
            }

            await repToken.connect(alice).claimReputationFromEconomy();
            await repToken.connect(aliceAlt).claimReputationFromEconomy();
            const repMinted = (await repToken.balanceOf(alice.address)) + (await repToken.balanceOf(aliceAlt.address));
            const treasuryGain = (await testToken.balanceOf(registryAddr)) - treasuryBefore;
            const endBalances = (await testToken.balanceOf(alice.address)) + (await testToken.balanceOf(aliceAlt.address));

            expect(repMinted).to.be.gt(0n);
            expect(treasuryGain).to.be.gt(0n);
            // Everything the farmer lost went to the treasury
            expect(startBalances - endBalances).to.equal(treasuryGain);
            // Each fee-paid token buys at most 2 * 10000 / MIN_PLATFORM_FEE_BPS REP (earning + spending side)
            const minFee = await economy.MIN_PLATFORM_FEE_BPS();
            expect(repMinted * minFee).to.be.lte(treasuryGain * 2n * 10000n);
        });
    });
});
// security.test.js
