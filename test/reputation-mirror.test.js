const { expect } = require("chai");
const { ethers } = require("hardhat");

// ReputationMirror: mirror-don't-bridge (wiring map §B3). Issues RepToken to
// HUMAN OWNERS proportional to the soulbound reputation their owner-bound agents
// earned on the autonet Substrate, per period. Delta-based, cursor-gated,
// baseline-at-first-sync, timelock-only rate.
describe("ReputationMirror", function () {
    let mirror, substrate, repToken, registry;
    let deployer, timelock, ownerA, ownerB, agent1, agent2, agent3, stranger;

    const RATE_ONE = ethers.parseEther("1"); // 1e18 == 1:1

    async function deployRepToken() {
        // RepToken needs a Registry (for the parity reads it doesn't use here)
        // and a timelock. The mirror reads RepToken.timelockAddress() at ctor.
        const Registry = await ethers.getContractFactory("Registry");
        registry = await Registry.deploy(timelock.address, deployer.address);
        const RepToken = await ethers.getContractFactory("RepToken");
        // transferable=false (Economy-DAO convention). initial members empty.
        return RepToken.deploy(
            "Jurisdiction Token", "JUR",
            await registry.getAddress(), timelock.address,
            [], [], false
        );
    }

    beforeEach(async function () {
        [deployer, timelock, ownerA, ownerB, agent1, agent2, agent3, stranger] =
            await ethers.getSigners();

        const MockSubstrate = await ethers.getContractFactory("MockSubstrate");
        substrate = await MockSubstrate.deploy();

        repToken = await deployRepToken();

        const Mirror = await ethers.getContractFactory("ReputationMirror");
        // period 0 => single period 0, isolates the delta/cursor logic from time.
        mirror = await Mirror.deploy(
            await substrate.getAddress(),
            await repToken.getAddress(),
            0
        );

        // Grant the mirror minter rights on RepToken. In production this is a
        // timelock governance action (setMinter is admin||timelock-gated); here
        // the timelock signer performs it directly.
        await repToken.connect(timelock).setMinter(await mirror.getAddress(), true);
    });

    it("wires to the RepToken timelock as its rate governor", async function () {
        expect(await mirror.timelock()).to.equal(timelock.address);
        expect(await mirror.repPerReputation()).to.equal(RATE_ONE);
    });

    it("full accrue -> claim flow for a single owner-bound agent", async function () {
        await substrate.setOwner(agent1.address, ownerA.address);
        // Baseline sync: reputation 100 pre-mirror, mints nothing.
        await substrate.setReputation(agent1.address, 100);
        await mirror.sync([agent1.address]);
        expect(await mirror.pending(ownerA.address)).to.equal(0);
        expect(await mirror.syncedReputation(agent1.address)).to.equal(100);

        // Agent earns 40 more reputation on the substrate.
        await substrate.setReputation(agent1.address, 140);
        await mirror.sync([agent1.address]);
        expect(await mirror.pending(ownerA.address)).to.equal(40);

        // Claim mints the delta to the owner (1:1).
        await expect(mirror.claim(ownerA.address))
            .to.emit(mirror, "Claimed").withArgs(ownerA.address, 40);
        expect(await repToken.balanceOf(ownerA.address)).to.equal(40);
        expect(await mirror.pending(ownerA.address)).to.equal(0);
    });

    it("first sync sets baseline and mints nothing (pre-mirror reputation excluded)", async function () {
        await substrate.setOwner(agent1.address, ownerA.address);
        await substrate.setReputation(agent1.address, 500);
        await mirror.sync([agent1.address]);
        expect(await mirror.everSynced(agent1.address)).to.equal(true);
        expect(await mirror.syncedReputation(agent1.address)).to.equal(500);
        expect(await mirror.pending(ownerA.address)).to.equal(0);
        // Nothing to claim from a pure baseline.
        await expect(mirror.claim(ownerA.address))
            .to.be.revertedWithCustomError(mirror, "NothingToClaim");
    });

    it("aggregates multiple agents under a single owner", async function () {
        await substrate.setOwner(agent1.address, ownerA.address);
        await substrate.setOwner(agent2.address, ownerA.address);
        // Baselines.
        await substrate.setReputation(agent1.address, 10);
        await substrate.setReputation(agent2.address, 20);
        await mirror.sync([agent1.address, agent2.address]);
        expect(await mirror.pending(ownerA.address)).to.equal(0);

        // Both earn more.
        await substrate.setReputation(agent1.address, 35); // +25
        await substrate.setReputation(agent2.address, 50); // +30
        await mirror.sync([agent1.address, agent2.address]);
        expect(await mirror.pending(ownerA.address)).to.equal(55);

        await mirror.claim(ownerA.address);
        expect(await repToken.balanceOf(ownerA.address)).to.equal(55);
    });

    it("ownerless agents accrue nothing but advance their cursor", async function () {
        // No owner set => getAgentOwner == address(0).
        await substrate.setReputation(agent1.address, 5);
        await mirror.sync([agent1.address]); // baseline
        await substrate.setReputation(agent1.address, 105); // +100 while ownerless
        await mirror.sync([agent1.address]);

        // Cursor advanced past the earned reputation...
        expect(await mirror.syncedReputation(agent1.address)).to.equal(105);
        // ...but no owner accrued anything, and the address(0) owner has none.
        expect(await mirror.pending(ethers.ZeroAddress)).to.equal(0);

        // If an owner is bound AFTER the fact, the already-passed reputation is
        // NOT retroactively claimable (cursor already advanced). Only new
        // reputation from here accrues.
        await substrate.setOwner(agent1.address, ownerA.address);
        await substrate.setReputation(agent1.address, 115); // +10 now owned
        await mirror.sync([agent1.address]);
        expect(await mirror.pending(ownerA.address)).to.equal(10);
    });

    it("double-sync in one call and repeated syncs cannot double-count", async function () {
        await substrate.setOwner(agent1.address, ownerA.address);
        await substrate.setReputation(agent1.address, 0);
        await mirror.sync([agent1.address]); // baseline at 0

        await substrate.setReputation(agent1.address, 100);
        // Duplicate agent in the same array: first advances cursor, rest no-op.
        await mirror.sync([agent1.address, agent1.address, agent1.address]);
        expect(await mirror.pending(ownerA.address)).to.equal(100);

        // Re-sync with no new reputation: nothing added.
        await mirror.sync([agent1.address]);
        expect(await mirror.pending(ownerA.address)).to.equal(100);

        // Claim once, re-claim reverts.
        await mirror.claim(ownerA.address);
        expect(await repToken.balanceOf(ownerA.address)).to.equal(100);
        await expect(mirror.claim(ownerA.address))
            .to.be.revertedWithCustomError(mirror, "NothingToClaim");
    });

    it("anyone can sync and anyone can claim for an owner, tokens go to the owner", async function () {
        await substrate.setOwner(agent1.address, ownerA.address);
        await substrate.setReputation(agent1.address, 0);
        await mirror.connect(stranger).sync([agent1.address]);
        await substrate.setReputation(agent1.address, 70);
        await mirror.connect(stranger).sync([agent1.address]);

        // stranger claims FOR ownerA; tokens mint to ownerA, not stranger.
        await mirror.connect(stranger).claim(ownerA.address);
        expect(await repToken.balanceOf(ownerA.address)).to.equal(70);
        expect(await repToken.balanceOf(stranger.address)).to.equal(0);
    });

    it("rate scales accrual; only the timelock can change it", async function () {
        // Non-timelock cannot change the rate.
        await expect(mirror.connect(deployer).setRepPerReputation(RATE_ONE * 2n))
            .to.be.revertedWithCustomError(mirror, "NotTimelock");
        await expect(mirror.connect(ownerA).setRepPerReputation(RATE_ONE * 2n))
            .to.be.revertedWithCustomError(mirror, "NotTimelock");

        // Timelock sets rate to 2:1.
        await expect(mirror.connect(timelock).setRepPerReputation(RATE_ONE * 2n))
            .to.emit(mirror, "RateUpdated").withArgs(RATE_ONE, RATE_ONE * 2n);

        await substrate.setOwner(agent1.address, ownerA.address);
        await substrate.setReputation(agent1.address, 0);
        await mirror.sync([agent1.address]); // baseline
        await substrate.setReputation(agent1.address, 50); // +50 reputation
        await mirror.sync([agent1.address]);
        // 50 * 2 = 100 RepToken accrued.
        expect(await mirror.pending(ownerA.address)).to.equal(100);
    });

    it("rate change only affects future accrual, not already-pending balance", async function () {
        await substrate.setOwner(agent1.address, ownerA.address);
        await substrate.setReputation(agent1.address, 0);
        await mirror.sync([agent1.address]); // baseline at 1:1

        await substrate.setReputation(agent1.address, 30); // +30 at 1:1
        await mirror.sync([agent1.address]);
        expect(await mirror.pending(ownerA.address)).to.equal(30);

        // Rate doubles; already-pending 30 is untouched.
        await mirror.connect(timelock).setRepPerReputation(RATE_ONE * 2n);
        await substrate.setReputation(agent1.address, 40); // +10 at 2:1 => +20
        await mirror.sync([agent1.address]);
        expect(await mirror.pending(ownerA.address)).to.equal(50); // 30 + 20
    });

    it("separates owners: agents of different owners accrue independently", async function () {
        await substrate.setOwner(agent1.address, ownerA.address);
        await substrate.setOwner(agent2.address, ownerB.address);
        await substrate.setReputation(agent1.address, 0);
        await substrate.setReputation(agent2.address, 0);
        await mirror.sync([agent1.address, agent2.address]); // baselines

        await substrate.setReputation(agent1.address, 11);
        await substrate.setReputation(agent2.address, 22);
        await mirror.sync([agent1.address, agent2.address]);

        expect(await mirror.pending(ownerA.address)).to.equal(11);
        expect(await mirror.pending(ownerB.address)).to.equal(22);
        await mirror.claim(ownerA.address);
        await mirror.claim(ownerB.address);
        expect(await repToken.balanceOf(ownerA.address)).to.equal(11);
        expect(await repToken.balanceOf(ownerB.address)).to.equal(22);
    });

    it("reverts a claim for the zero owner and empty pending", async function () {
        await expect(mirror.claim(ethers.ZeroAddress))
            .to.be.revertedWithCustomError(mirror, "ZeroAddress");
        await expect(mirror.claim(ownerA.address))
            .to.be.revertedWithCustomError(mirror, "NothingToClaim");
    });
});
