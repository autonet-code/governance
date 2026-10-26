const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { autonet, registerAgent, anchorArgs } = require("./helpers/autonet");

// ToolBond against the real Substrate, a RepToken and a Registry holding the charter. The deployer is
// the Substrate's vault minter (to fund accounts with ATN), the RepToken's admin (to grant the bond
// slasher rights) and the Registry's owner; a plain signer stands in for the governor and timelock, so
// it anchors epochs directly and the appeal window is the 7-day appealPeriod.
//
// REP: a1 300, a2 200, a3 100, author 400 (total 1000). The charter has two axes.
describe("ToolBond", function () {
    let deployer, timelock, author, a1, a2, a3, outsider;
    let substrate, rep, registry, bond, treasury;

    const ATN = (n) => ethers.parseUnits(String(n), 6);
    const REP = (n) => ethers.parseEther(String(n));
    const DIGEST = ethers.id("tool manifest v1");
    const MIN_STAKE = ATN(100);
    const DAY = 86400;
    const PARAMS = {
        minStake: MIN_STAKE, revealWindow: DAY, degradeBps: 1000, authorSlashBps: 10000, unbondDelay: 14 * DAY,
        reviewerShareBps: 4000, appealPeriod: 7 * DAY, harmWeightBps: 20000,
    };
    const CHARTER = '{"axes":[{"id":"correctness","thesis":"Works."},{"id":"simplicity","thesis":"Small."}]}';
    const NO = -128;
    const NO_HARM = 255;
    const EVIDENCE = ethers.id("evidence");
    const batches = new Map();
    let anchors = 0;

    // One int8 per axis
    const scores = (...s) => ethers.hexlify(Uint8Array.from(s.map((x) => (x + 256) % 256)));
    const review = (s, harm, stake, digest = DIGEST) => ({ digest, scores: s, harm, stake, evidenceHash: EVIDENCE });

    async function fund(signer, amount) {
        await substrate.mintFromVault(signer.address, amount);
        await substrate.connect(signer).approve(await bond.getAddress(), ethers.MaxUint256);
    }

    // Commit a batch for the current epoch, staking the sum of its reviews' stakes
    async function commit(signer, reviews) {
        const epoch = await bond.currentEpoch();
        const salt = ethers.hexlify(ethers.randomBytes(32));
        batches.set(`${epoch}:${signer.address}`, { reviews, salt });
        const stake = reviews.reduce((t, r) => t + BigInt(r.stake), 0n);
        await bond.connect(signer).commit(await bond.commitmentOf(epoch, signer.address, reviews, salt), stake);
        return epoch;
    }

    async function reveal(signer, epoch, from = signer) {
        const { reviews, salt } = batches.get(`${epoch}:${signer.address}`);
        return bond.connect(from).reveal(epoch, signer.address, reviews, salt);
    }

    // The DAO anchors the epoch, closing it
    async function anchor() {
        await time.increase(60);
        await substrate.connect(timelock).anchor(...(await anchorArgs(substrate, `epoch-${anchors++}`)));
    }

    // Commit each batch, anchor, reveal them all, and wait out the reveal window
    async function epochWith(entries) {
        let epoch;
        for (const [s, reviews] of entries) epoch = await commit(s, reviews);
        await anchor();
        for (const [s] of entries) await reveal(s, epoch);
        await time.increase(PARAMS.revealWindow + 1);
        return epoch;
    }

    async function claimAll(epoch, signers, digest = DIGEST) {
        for (const s of signers) await bond.claim(digest, epoch, s.address);
    }

    beforeEach(async function () {
        [deployer, timelock, author, a1, a2, a3, outsider] = await ethers.getSigners();
        anchors = 0;
        rep = await (await ethers.getContractFactory("RepToken")).deploy("Rep", "REP", deployer.address, timelock.address,
            [a1.address, a2.address, a3.address, author.address], [REP(300), REP(200), REP(100), REP(400)], false);
        registry = await (await ethers.getContractFactory("Registry")).deploy(deployer.address, ethers.ZeroAddress);
        await registry.editRegistry("jurisdiction.autonet.charter", CHARTER);
        treasury = await registry.getAddress();
        substrate = await autonet("Substrate", deployer).deploy(ethers.ZeroAddress, deployer.address, timelock.address, ethers.ZeroAddress);
        // Signers stand in for the governor and timelock, so the lifecycle floor is just the 2-day buffer
        bond = await (await ethers.getContractFactory("ToolBond")).deploy(await substrate.getAddress(),
            await rep.getAddress(), treasury, deployer.address, timelock.address, PARAMS);
        await rep.setSlasher(await bond.getAddress(), true);

        await registerAgent(substrate, author, "0x01");
        await substrate.connect(author).registerTool(DIGEST);
        await fund(author, ATN(1000));
        await bond.connect(author).bond(DIGEST, MIN_STAKE);
        for (const s of [a1, a2, a3, outsider]) await fund(s, ATN(100));
        await time.increase(1);
    });

    describe("RepToken slashers", function () {
        it("only slashers burn, capped at the balance, and reassign no more than they burned", async function () {
            await expect(rep.connect(outsider).slash(a3.address, 1)).to.be.revertedWith("RepToken: Not a slasher");
            await rep.setSlasher(outsider.address, true);
            await rep.connect(outsider).slash(a3.address, REP(150));
            expect(await rep.balanceOf(a3.address)).to.equal(0);
            expect(await rep.slashedCredit(outsider.address)).to.equal(REP(100));

            await expect(rep.connect(outsider).reassign(a1.address, REP(101))).to.be.revertedWith("RepToken: Exceeds slashed credit");
            await rep.connect(outsider).reassign(a1.address, REP(100));
            expect(await rep.totalSupply()).to.equal(REP(1000));
            expect(await rep.delegates(a1.address)).to.equal(a1.address); // recipient votes for itself
        });
    });

    describe("bonding", function () {
        it("only the tool's Substrate author can bond, and the tool counts once the stake reaches the minimum", async function () {
            const d2 = ethers.id("tool manifest v2");
            await substrate.connect(author).registerTool(d2);
            await expect(bond.connect(outsider).bond(d2, MIN_STAKE)).to.be.revertedWithCustomError(bond, "NotAuthor");
            await bond.connect(author).bond(d2, ATN(60));
            expect(await bond.isBonded(d2)).to.equal(false);
            await bond.connect(author).bond(d2, ATN(40));
            expect(await bond.isBonded(d2)).to.equal(true);
        });

        it("a stake leaves only after the delay, the unbond epoch's reveals, and every round on the tool", async function () {
            await bond.connect(author).requestUnbond(DIGEST);
            expect(await bond.isBonded(DIGEST)).to.equal(false);
            // Still reviewable while unbonding
            const epoch = await commit(a1, [review(scores(50, 50), 0, ATN(10))]);
            await time.increase(PARAMS.unbondDelay + 1);
            await expect(bond.connect(author).withdraw(DIGEST)).to.be.revertedWithCustomError(bond, "TooEarly");
            await anchor();
            await reveal(a1, epoch);
            await expect(bond.connect(author).withdraw(DIGEST)).to.be.revertedWithCustomError(bond, "TooEarly");
            await time.increase(PARAMS.revealWindow + 1);
            await expect(bond.connect(author).withdraw(DIGEST)).to.be.revertedWithCustomError(bond, "RoundActive");
            await bond.finalize(DIGEST, epoch, 10);
            await expect(bond.connect(outsider).withdraw(DIGEST)).to.be.revertedWithCustomError(bond, "NotAuthor");
            const before = await substrate.balanceOf(author.address);
            await bond.connect(author).withdraw(DIGEST);
            expect(await substrate.balanceOf(author.address)).to.equal(before + MIN_STAKE);
        });
    });

    describe("commits and reveals", function () {
        it("epochs follow the anchors and record the charter's axes", async function () {
            expect(await bond.currentEpoch()).to.equal(0);
            await commit(a1, [review(scores(50, 50), 0, 0)]);
            const info = await bond.epochInfo(0);
            expect(info.charterHash).to.equal(ethers.sha256(ethers.toUtf8Bytes(CHARTER)));
            expect(info.axisIds).to.deep.equal([ethers.id("correctness"), ethers.id("simplicity")]);
            expect(info.supply).to.equal(REP(1000));
            expect(info.revealDeadline).to.equal(0);
            await anchor();
            expect(await bond.currentEpoch()).to.equal(1);
            expect((await bond.epochInfo(0)).revealDeadline).to.be.greaterThan(0);
        });

        it("a charter that isn't compact JSON with plain ids gives the epoch no axes", async function () {
            await registry.editRegistry("jurisdiction.autonet.charter", '{"axes":[{"id" : "correctness"}]}');
            await commit(a1, [review("0x", 0, 0)]);
            expect((await bond.epochInfo(0)).axisIds).to.deep.equal([]);
        });

        it("a commit needs REP at the epoch's start or a stake, once per epoch", async function () {
            await expect(commit(outsider, [review(scores(50, 50), 0, 0)])).to.be.revertedWithCustomError(bond, "NoWeight");
            await commit(outsider, [review(scores(50, 50), 0, ATN(5))]); // a newcomer stakes instead
            await commit(a1, [review(scores(50, 50), 0, 0)]);
            await expect(commit(a1, [review(scores(50, 50), 0, 0)])).to.be.revertedWithCustomError(bond, "AlreadyCommitted");
        });

        it("reveals come after the anchor, within the window, matching the commit; anyone can relay them", async function () {
            const epoch = await commit(a1, [review(scores(50, 50), 0, ATN(10))]);
            await expect(reveal(a1, epoch)).to.be.revertedWithCustomError(bond, "TooEarly");
            await anchor();
            const { reviews } = batches.get(`${epoch}:${a1.address}`);
            await expect(bond.reveal(epoch, a1.address, reviews, ethers.ZeroHash)).to.be.revertedWithCustomError(bond, "BadReveal");
            await reveal(a1, epoch, outsider); // relayed
            expect((await bond.reviewOf(DIGEST, epoch, a1.address)).reviewer).to.equal(a1.address);
            await expect(reveal(a1, epoch)).to.be.revertedWithCustomError(bond, "BadReveal");

            const late = await commit(a2, [review(scores(50, 50), 0, 0)]);
            await anchor();
            await time.increase(PARAMS.revealWindow + 1);
            await expect(reveal(a2, late)).to.be.revertedWithCustomError(bond, "TooLate");
        });

        it("reviews that can't count are refunded without voiding the batch", async function () {
            const d2 = ethers.id("unbonded tool");
            const epoch = await commit(a1, [
                review(scores(50, 50), 0, ATN(10)),
                review(scores(50, 50), 0, ATN(1), d2),          // no bond
                review(scores(50), 0, ATN(2)),                  // wrong axis count, and a repeat
                review(scores(101, 0), 0, ATN(3)),              // out of range
            ]);
            await commit(author, [review(scores(100, 100), 0, ATN(4))]); // the author's own tool
            await anchor();
            const before = await substrate.balanceOf(a1.address);
            await reveal(a1, epoch);
            expect(await substrate.balanceOf(a1.address)).to.equal(before + ATN(6));
            await reveal(author, epoch);
            expect((await bond.getRound(DIGEST, epoch)).reviewCount).to.equal(1);
        });

        it("a batch never revealed loses its whole stake to the treasury and degradeBps of its REP", async function () {
            const epoch = await commit(a1, [review(scores(50, 50), 0, ATN(10))]);
            await anchor();
            await expect(bond.forfeit(epoch, a1.address)).to.be.revertedWithCustomError(bond, "TooEarly");
            await time.increase(PARAMS.revealWindow + 1);
            await bond.connect(outsider).forfeit(epoch, a1.address);
            expect(await substrate.balanceOf(treasury)).to.equal(ATN(10));
            expect(await rep.balanceOf(a1.address)).to.equal(REP(270));
            await expect(bond.forfeit(epoch, a1.address)).to.be.revertedWithCustomError(bond, "WrongStage");
        });
    });

    describe("settlement", function () {
        it("rates by REP-weighted means: inaccurate stake and REP go to accurate reviews, nothing created", async function () {
            const epoch = await epochWith([
                [a1, [review(scores(50, 50), 0, ATN(10))]],
                [a2, [review(scores(50, 50), 0, ATN(10))]],
                [a3, [review(scores(-100, -100), 0, ATN(10))]],
            ]);
            await bond.finalize(DIGEST, epoch, 10);

            // Means: (300x50 + 200x50 - 100x100) / 600 = 25 on both axes; harm 0
            const axis = await bond.roundAxis(DIGEST, epoch, 0);
            expect(axis.sum / axis.mass).to.equal(25);
            // a1: axes 1 - 25/200 = 0.875, harm 1 (weight 2) -> 0.9375. a3: 0.375 -> 0.6875
            expect((await bond.reviewOf(DIGEST, epoch, a1.address)).accuracy).to.equal(ethers.parseEther("0.9375"));
            expect((await bond.reviewOf(DIGEST, epoch, a3.address)).accuracy).to.equal(ethers.parseEther("0.6875"));

            const balances = async () => Promise.all([a1, a2, a3].map((s) => substrate.balanceOf(s.address)));
            const before = await balances();
            await claimAll(epoch, [a1, a2, a3]);
            const gained = (await balances()).map((b, i) => b - before[i]);
            expect(gained[0]).to.be.greaterThan(ATN(10)); // accurate: back with winnings
            expect(gained[2]).to.be.lessThan(ATN(10));    // a3 lost part of its stake
            // Only the service fee on the winnings leaves the stakes; nothing else stays behind
            expect(await substrate.balanceOf(await bond.getAddress())).to.be.lessThan(MIN_STAKE + 10n);
            // No REP created; rounding leaves a few wei burned
            expect(await rep.totalSupply()).to.be.within(REP(1000) - 10n, REP(1000));
            expect(await rep.balanceOf(a3.address)).to.be.lessThan(REP(100));
            expect(await rep.balanceOf(a1.address)).to.be.greaterThan(REP(300));
            await expect(bond.claim(DIGEST, epoch, a1.address)).to.be.revertedWithCustomError(bond, "NothingToClaim");

            // The tool's ratings carry the round
            const rating = await bond.toolRating(DIGEST, ethers.id("correctness"));
            expect(rating.mass).to.equal(REP(600));
            expect(rating.sum).to.equal(axis.sum);
        });

        it("settled harm slashes that share of the bond and the author's REP after the appeal window", async function () {
            const epoch = await epochWith([
                [a1, [review(scores(0, 0), 100, ATN(10))]],
                [a2, [review(scores(0, 0), 100, ATN(10))]],
                [a3, [review(scores(0, 0), 0, ATN(10))]],
            ]);
            await bond.finalize(DIGEST, epoch, 10);
            // H = (300 + 200) x 100 / (600 x 100) = 5/6
            const r = await bond.getRound(DIGEST, epoch);
            expect(r.stage).to.equal(2n); // Cooling
            expect(r.settledHarm).to.equal(ethers.parseEther("1") * 5n / 6n);
            await expect(bond.finalize(DIGEST, epoch, 10)).to.be.revertedWithCustomError(bond, "TooEarly");
            await time.increase(PARAMS.appealPeriod + 1);
            await bond.finalize(DIGEST, epoch, 10);

            const slashed = MIN_STAKE * r.settledHarm / ethers.parseEther("1");
            expect((await bond.bonds(DIGEST)).stake).to.equal(MIN_STAKE - slashed);
            expect(await bond.isBonded(DIGEST)).to.equal(false);
            expect(await rep.balanceOf(author.address)).to.equal(REP(400) - REP(400) * r.settledHarm / ethers.parseEther("1"));

            // The slashed bond goes by REP x harm accuracy: the accusers take most of it
            const before = await substrate.balanceOf(a1.address);
            await claimAll(epoch, [a1, a2, a3]);
            expect(await substrate.balanceOf(a1.address) - before).to.be.greaterThan(ATN(10) + slashed / 3n);
            expect(await rep.totalSupply()).to.be.within(REP(1000) - 10n, REP(1000));
        });

        it("the DAO overrules the settled harm within the appeal window, and its ruling finalizes at once", async function () {
            const epoch = await epochWith([[a1, [review(scores(0, 0), 100, ATN(10))]]]);
            await bond.finalize(DIGEST, epoch, 10);
            await expect(bond.connect(outsider).daoOverrule(DIGEST, epoch, 0)).to.be.revertedWithCustomError(bond, "NotTimelock");
            await bond.connect(timelock).daoOverrule(DIGEST, epoch, 0);
            await bond.finalize(DIGEST, epoch, 10);
            expect((await bond.bonds(DIGEST)).stake).to.equal(MIN_STAKE);
            expect(await rep.balanceOf(author.address)).to.equal(REP(400));
            // a1 was wrong on harm by the DAO's ruling
            expect((await bond.reviewOf(DIGEST, epoch, a1.address)).harmAccuracy).to.equal(0);
            // The tool's harm keeps the DAO's ruling, not the reviewers'
            const h = await bond.toolHarm(DIGEST);
            expect(h.mass).to.equal(REP(300));
            expect(h.sum).to.equal(0);
        });

        it("too late to overrule once the appeal window has passed", async function () {
            const epoch = await epochWith([[a1, [review(scores(0, 0), 100, ATN(10))]]]);
            await bond.finalize(DIGEST, epoch, 10);
            await time.increase(PARAMS.appealPeriod + 1);
            await expect(bond.connect(timelock).daoOverrule(DIGEST, epoch, 0)).to.be.revertedWithCustomError(bond, "TooLate");
        });

        it("a round with no REP behind it refunds every stake and settles nothing", async function () {
            const epoch = await epochWith([[outsider, [review(scores(-100, -100), 100, ATN(10))]]]);
            await bond.finalize(DIGEST, epoch, 10);
            const before = await substrate.balanceOf(outsider.address);
            await bond.claim(DIGEST, epoch, outsider.address);
            expect(await substrate.balanceOf(outsider.address)).to.equal(before + ATN(10));
            expect((await bond.bonds(DIGEST)).stake).to.equal(MIN_STAKE);
        });

        it("a newcomer with stake but no REP earns when accurate", async function () {
            const epoch = await epochWith([
                [a1, [review(scores(50, 50), 0, ATN(10))]],
                [a3, [review(scores(-100, -100), 0, ATN(10))]],
                [outsider, [review(scores(50, 50), 0, ATN(10))]],
            ]);
            await bond.finalize(DIGEST, epoch, 10);
            const before = await substrate.balanceOf(outsider.address);
            await bond.claim(DIGEST, epoch, outsider.address);
            expect(await substrate.balanceOf(outsider.address) - before).to.be.greaterThan(ATN(10));
            // Weight 0: it moved no mean
            expect((await bond.roundAxis(DIGEST, epoch, 0)).mass).to.equal(REP(400));
        });

        it("finalize works in batches", async function () {
            const epoch = await epochWith([
                [a1, [review(scores(50, 50), 0, ATN(1))]],
                [a2, [review(scores(50, 50), 0, ATN(1))]],
                [a3, [review(scores(50, 50), 0, ATN(1))]],
            ]);
            await bond.finalize(DIGEST, epoch, 2);
            expect((await bond.getRound(DIGEST, epoch)).stage).to.equal(3n); // Finalizing
            await expect(bond.claim(DIGEST, epoch, a1.address)).to.be.revertedWithCustomError(bond, "WrongStage");
            await bond.finalize(DIGEST, epoch, 2);
            expect((await bond.getRound(DIGEST, epoch)).stage).to.equal(4n); // Done
        });

        it("ratings accumulate across epochs", async function () {
            const e0 = await epochWith([[a1, [review(scores(100, NO), NO_HARM, 0)]]]);
            await bond.finalize(DIGEST, e0, 10);
            const e1 = await epochWith([[a2, [review(scores(0, 0), NO_HARM, 0)]]]);
            await bond.finalize(DIGEST, e1, 10);
            const c = await bond.toolRating(DIGEST, ethers.id("correctness"));
            expect(c.mass).to.equal(REP(500));
            expect(c.sum).to.equal(REP(300) * 100n);
            expect((await bond.toolRating(DIGEST, ethers.id("simplicity"))).mass).to.equal(REP(200));
            expect((await bond.toolHarm(DIGEST)).mass).to.equal(0);
        });
    });

    describe("governance", function () {
        it("only the timelock sets parameters, within bounds", async function () {
            await expect(bond.connect(outsider).setParams(PARAMS)).to.be.revertedWithCustomError(bond, "NotTimelock");
            await expect(bond.connect(timelock).setParams({ ...PARAMS, degradeBps: 10001 })).to.be.revertedWithCustomError(bond, "BadParams");
            await expect(bond.connect(timelock).setParams({ ...PARAMS, revealWindow: 0 })).to.be.revertedWithCustomError(bond, "BadParams");
            await bond.connect(timelock).setParams({ ...PARAMS, harmWeightBps: 30000 });
            expect(await bond.harmWeightBps()).to.equal(30000);
        });
    });
});
