const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { passCoolingOff } = require("./helpers/coolingOff");

// Regression tests for the factory hijack and zero-cost REP farming fixed in Oct 2026, carried over
// to JurisdictionFactory and the economy module.
describe("Security", function () {
    describe("JurisdictionFactory deployment binding", function () {
        let victim, attacker, member;
        const { suite, coreParams, prepare, createJurisdiction } = require("./helpers/jurisdiction");

        beforeEach(async function () {
            [victim, attacker, member] = await ethers.getSigners();
        });

        it("rejects finalizing someone else's core, or a core with a rogue governor", async function () {
            const f = (await suite()).jurisdictionFactory;
            const p = coreParams({ members: [member.address], amounts: [ethers.parseEther("100")] });
            const core = await f.connect(victim).deployCore.staticCall(p);
            await f.connect(victim).deployCore(p);
            const c = { registry: core.registry, timelock: core.timelock, token: core.token, governor: core.governor };
            const rogue = await f.connect(attacker).deployCore.staticCall(p);
            await f.connect(attacker).deployCore(p);

            await expect(f.connect(attacker).finalize(c, [], [], [])).to.be.revertedWithCustomError(f, "NotOriginator");
            await expect(f.connect(victim).finalize({ ...c, governor: rogue.governor }, [], [], []))
                .to.be.revertedWithCustomError(f, "WrongCore");

            await f.connect(victim).finalize(c, [], [], []);
            const tl = await ethers.getContractAt("TimelockController", c.timelock);
            expect(await tl.hasRole(await tl.PROPOSER_ROLE(), c.governor)).to.be.true;
            expect(await tl.hasRole(await tl.PROPOSER_ROLE(), rogue.governor)).to.be.false;
        });

        it("hands a prepared economy to the timelock in the same transaction", async function () {
            const s = await suite();
            const f = s.jurisdictionFactory;
            const core = await f.connect(victim).deployCore.staticCall(coreParams());
            await f.connect(victim).deployCore(coreParams());
            const c = { registry: core.registry, timelock: core.timelock, token: core.token, governor: core.governor };
            const { module } = await prepare(s, victim, c, "economy");
            const econ = await ethers.getContractAt("Economy", module);
            expect(await econ.timelockAddress()).to.equal(c.timelock);
            await expect(econ.connect(attacker).setImplementations(attacker.address, attacker.address))
                .to.be.revertedWith("Protected");
            await expect(econ.connect(attacker).setDaoAddresses(
                attacker.address, attacker.address, attacker.address, attacker.address
            )).to.be.revertedWith("DAO addresses can only be set once.");
        });

        it("keeps project cooling-off at least a full proposal lifecycle plus a day, even with parties set at creation", async function () {
            const j = await createJurisdiction(victim, {
                members: [member.address], amounts: [ethers.parseEther("100")],
                votingDelay: 1, votingPeriod: 5, proposalThreshold: ethers.parseEther("1"), executionDelay: 60,
                modules: [["economy", { params: { arbitrationFeeBps: 500, platformFeeBps: 100, authorFeeBps: 100,
                    coolingOffPeriod: 60, backersQuorumBps: 7000, projectThreshold: 0, appealPeriod: 120 } }]],
            });
            const econ = j.economy;
            const gov = j.dao;
            const tl = j.timelock;

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
        let economy, registry, repToken, testToken, claim;

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
            claim = await (await ethers.getContractFactory("EconomyRepClaim")).deploy(
                await economy.getAddress(), await repToken.getAddress(), await registry.getAddress());
            await repToken.connect(timelock).setMinter(await claim.getAddress(), true);
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

            await claim.connect(alice).claim();
            await claim.connect(aliceAlt).claim();
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
