const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { autonet, registerAgent, anchorArgs } = require("./helpers/autonet");

// ToolBond against the real Substrate, a RepToken and a Registry holding the charter. The deployer is
// the Substrate's vault minter (to fund accounts with ATN), the RepToken's admin (to grant the bond
// slasher rights) and the Registry's owner; a mock governor and a plain signer as the timelock, so the
// timelock anchors epochs directly and the appeal window is the 7-day appealPeriod.
//
// REP: a1 300, a2 200, a3 100, author 400 (total 1000). The charter has two value axes.
describe("ToolBond", function () {
    let deployer, timelock, author, a1, a2, a3, outsider;
    let substrate, rep, registry, bond, treasury, governor;

    const ATN = (n) => ethers.parseUnits(String(n), 6);
    const REP = (n) => ethers.parseEther(String(n));
    const ONE = ethers.parseEther("1");
    const DIGEST = ethers.id("tool manifest v1");
    const MIN_STAKE = ATN(100);
    const DAY = 86400;
    const PARAMS = {
        minStake: MIN_STAKE, revealWindow: DAY, degradeBps: 1000, authorSlashBps: 10000, unbondDelay: 14 * DAY,
        reviewerShareBps: 4000, appealPeriod: 7 * DAY,
    };
    const CHARTER = '{"axes":[{"id":"care","thesis":"Kind."},{"id":"growth","thesis":"Grows."}]}';
    const NO = -128;
    const UNINFORMATIVE = 2n ** 64n - 1n;
    const EVIDENCE = ethers.id("evidence");
    const TAG = ethers.id("autonet.tool_concluded");
    const batches = new Map();
    let anchors = 0;

    // One int8 per charter axis
    const scores = (...s) => ethers.hexlify(Uint8Array.from(s.map((x) => (x + 256) % 256)));
    // A review: the four fixed fields, then the charter axes (50 on both by default)
    const review = ({ c = 50, s = 50, n = 50, m = 0, axes = scores(50, 50), digest = DIGEST } = {}) =>
        ({ digest, correctness: c, simplicity: s, novelty: n, malware: m, scores: axes, evidenceHash: EVIDENCE });
    const malware = (digest = DIGEST) => review({ m: 1, digest });
    const clean = (digest = DIGEST) => review({ digest });

    async function fund(signer, amount) {
        await substrate.mintFromVault(signer.address, amount);
        await substrate.connect(signer).approve(await bond.getAddress(), ethers.MaxUint256);
    }

    // Commit a batch for the current epoch
    async function commit(signer, reviews) {
        const epoch = await bond.currentEpoch();
        const salt = ethers.hexlify(ethers.randomBytes(32));
        batches.set(`${epoch}:${signer.address}`, { reviews, salt });
        await bond.connect(signer).commit(await bond.commitmentOf(epoch, signer.address, reviews, salt), reviews.length);
        return epoch;
    }

    async function reveal(signer, epoch, from = signer) {
        const { reviews, salt } = batches.get(`${epoch}:${signer.address}`);
        return bond.connect(from).reveal(epoch, signer.address, reviews, salt);
    }

    // The DAO anchors the epoch, closing it; `root` is the close's agentMintRoot. Returns the anchor's index.
    async function anchor(root = ethers.ZeroHash) {
        await time.increase(60);
        await substrate.connect(timelock).anchor(...(await anchorArgs(substrate, `epoch-${anchors++}`, root)));
        return (await substrate.anchorCount()) - 1n;
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

    // A concluded tool's leaf in the close's agentMintRoot, with the close's share of yes in bps
    const leaf = (digest, bps) => ethers.keccak256(ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32", "uint256"], [TAG, digest, bps])));
    const pair = (x, y) => ethers.keccak256(ethers.concat(x < y ? [x, y] : [y, x]));

    // The close names the tool concluded, by default with 5/6 of its REP saying malware; anyone records it
    async function concludeTool(digest = DIGEST, bps = 8333) {
        const index = await anchor(leaf(digest, bps));
        await bond.conclude(digest, index, bps, []);
        return bond.verdicts(digest);
    }

    beforeEach(async function () {
        [deployer, timelock, author, a1, a2, a3, outsider] = await ethers.getSigners();
        anchors = 0;
        rep = await (await ethers.getContractFactory("RepToken")).deploy("Rep", "REP", deployer.address, timelock.address,
            [a1.address, a2.address, a3.address, author.address], [REP(300), REP(200), REP(100), REP(400)]);
        registry = await (await ethers.getContractFactory("Registry")).deploy(deployer.address, ethers.ZeroAddress);
        await registry.editRegistry("jurisdiction.autonet.charter", CHARTER);
        treasury = await registry.getAddress();
        substrate = await autonet("Substrate", deployer).deploy(ethers.ZeroAddress, deployer.address, timelock.address, ethers.ZeroAddress, ethers.ZeroHash, "Test ATN", "TSTATN", 250, 5000);
        governor = await (await ethers.getContractFactory("MockProposalGovernor")).deploy();
        bond = await (await ethers.getContractFactory("ToolBond")).deploy(await substrate.getAddress(),
            await rep.getAddress(), treasury, await governor.getAddress(), timelock.address, PARAMS);
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

        it("a stake leaves only after the delay and once every round on the tool is finalized", async function () {
            await bond.connect(author).requestUnbond(DIGEST);
            expect(await bond.isBonded(DIGEST)).to.equal(false);
            // Still reviewable while unbonding
            const epoch = await commit(a1, [clean()]);
            await anchor();
            await reveal(a1, epoch);
            await expect(bond.connect(author).withdraw(DIGEST)).to.be.revertedWithCustomError(bond, "TooEarly");
            await time.increase(PARAMS.unbondDelay + 1);
            await expect(bond.connect(author).withdraw(DIGEST)).to.be.revertedWithCustomError(bond, "RoundActive");
            await bond.finalize(DIGEST, epoch, 10);
            await expect(bond.connect(outsider).withdraw(DIGEST)).to.be.revertedWithCustomError(bond, "NotAuthor");
            const before = await substrate.balanceOf(author.address);
            await bond.connect(author).withdraw(DIGEST);
            expect(await substrate.balanceOf(author.address)).to.equal(before + MIN_STAKE);
        });
    });

    describe("bounty", function () {
        const GATE = "jurisdiction.autonet.mint_gate_rep_bps";
        const sanctionKey = (a) => `sanction.${a.toLowerCase()}`;

        // a1 (300 REP) and a2 (200 REP) agree, so both are fully accurate
        async function agreeingRound() {
            return epochWith([[a1, [clean()]], [a2, [clean()]]]);
        }

        async function paid(epoch, signer) {
            const before = await substrate.balanceOf(signer.address);
            await bond.claim(DIGEST, epoch, signer.address);
            return await substrate.balanceOf(signer.address) - before;
        }

        it("anyone adds to a bonded tool's bounty", async function () {
            await expect(bond.connect(outsider).addBounty(ethers.id("no bond"), ATN(1))).to.be.revertedWithCustomError(bond, "NotBonded");
            await bond.connect(author).addBounty(DIGEST, ATN(30));
            await expect(bond.connect(outsider).addBounty(DIGEST, ATN(20)))
                .to.emit(bond, "BountyAdded").withArgs(DIGEST, outsider.address, ATN(20), ATN(50));
            expect((await bond.bonds(DIGEST)).bounty).to.equal(ATN(50));
        });

        it("a round pays each review bounty x its REP / the REP needed x its accuracy", async function () {
            await registry.editRegistry(GATE, "10000"); // a tool needs all 1000 REP
            await bond.connect(author).addBounty(DIGEST, ATN(100));
            const epoch = await agreeingRound();
            await bond.finalize(DIGEST, epoch, 10);
            const b = await bond.roundBounty(DIGEST, epoch);
            expect(b.base).to.equal(ATN(100));
            expect(b.need).to.equal(REP(1000));
            expect(b.pool).to.equal(ATN(50));
            expect((await bond.bonds(DIGEST)).bounty).to.equal(ATN(50));
            await expect(bond.claim(DIGEST, epoch, a1.address))
                .to.emit(bond, "BountyPaid").withArgs(DIGEST, epoch, a1.address, ATN(30));
            expect(await paid(epoch, a2)).to.equal(ATN(20));
        });

        it("parts that would overspend the bounty are scaled down together", async function () {
            // The default gate is 1% of REP (10): a1 alone covers it many times over
            await bond.connect(author).addBounty(DIGEST, ATN(100));
            const epoch = await agreeingRound();
            await bond.finalize(DIGEST, epoch, 10);
            expect((await bond.roundBounty(DIGEST, epoch)).need).to.equal(REP(10));
            expect((await bond.bonds(DIGEST)).bounty).to.equal(0n);
            expect(await paid(epoch, a1)).to.equal(ATN(60));
            expect(await paid(epoch, a2)).to.equal(ATN(40));
        });

        it("a malformed gate reads as the default", async function () {
            await registry.editRegistry(GATE, "50%");
            await bond.connect(author).addBounty(DIGEST, ATN(1));
            const epoch = await agreeingRound();
            await bond.finalize(DIGEST, epoch, 10);
            expect((await bond.roundBounty(DIGEST, epoch)).need).to.equal(REP(10));
        });

        it("a sanctioned reviewer or household takes nothing, and its part stays in the bounty", async function () {
            await registry.editRegistry(GATE, "10000");
            await registry.editRegistry(sanctionKey(a2.address), '{"until": 99999999999, "reason": "spam"}');
            await bond.connect(author).addBounty(DIGEST, ATN(100));
            const epoch = await agreeingRound();
            await bond.finalize(DIGEST, epoch, 10);
            expect((await bond.bonds(DIGEST)).bounty).to.equal(ATN(70));
            await expect(bond.claim(DIGEST, epoch, a2.address)).to.not.emit(bond, "BountyPaid");
            expect(await paid(epoch, a1)).to.equal(ATN(30));
        });

        it("reads a sanction as in force unless it is JSON with an integer until already past", async function () {
            const key = sanctionKey(outsider.address);
            expect(await bond.sanctioned(outsider.address)).to.equal(false);
            for (const [value, inForce] of [["yes", true], ['{"until": 1}', false], ['{"until":99999999999}', true],
                ['{"reason":"x"}', true], ['{"until":"soon"}', true]]) {
                await registry.editRegistry(key, value);
                expect(await bond.sanctioned(outsider.address), value).to.equal(inForce);
            }
        });

        it("what's left goes back to the author with the bond", async function () {
            await bond.connect(outsider).addBounty(DIGEST, ATN(7));
            await bond.connect(author).requestUnbond(DIGEST);
            await time.increase(PARAMS.unbondDelay + 1);
            const before = await substrate.balanceOf(author.address);
            await expect(bond.connect(author).withdraw(DIGEST))
                .to.emit(bond, "Unbonded").withArgs(DIGEST, author.address, MIN_STAKE, ATN(7));
            expect(await substrate.balanceOf(author.address) - before).to.equal(MIN_STAKE + ATN(7));
        });
    });

    describe("commits and reveals", function () {
        it("epochs follow the anchors and record the charter's axes and the unscored default", async function () {
            expect(await bond.currentEpoch()).to.equal(0);
            await commit(a1, [clean()]);
            const info = await bond.epochInfo(0);
            expect(info.charterHash).to.equal(ethers.sha256(ethers.toUtf8Bytes(CHARTER)));
            expect(info.axisIds).to.deep.equal([ethers.id("care"), ethers.id("growth")]);
            expect(info.supply).to.equal(REP(1000));
            expect(info.revealDeadline).to.equal(0);
            expect(info.unscoredBps).to.equal(5000);
            await anchor();
            expect(await bond.currentEpoch()).to.equal(1);
            expect((await bond.epochInfo(0)).revealDeadline).to.be.greaterThan(0);
        });

        it("the unscored default is a Registry value, fixed per epoch; malformed or above 100% reads as 50%", async function () {
            const KEY = "jurisdiction.autonet.unscored_axis_bps";
            for (const [value, bps] of [["2500", 2500], ["10000", 10000], ["10001", 5000], ["0.5", 5000], ["", 5000]]) {
                await registry.editRegistry(KEY, value);
                const epoch = await commit(a1, [clean()]);
                await registry.editRegistry(KEY, "1"); // later edits don't move a started epoch
                expect((await bond.epochInfo(epoch)).unscoredBps, value).to.equal(bps);
                await anchor();
            }
        });

        it("a charter that isn't compact JSON with plain ids gives the epoch no axes, and reviews only the fixed fields", async function () {
            await registry.editRegistry("jurisdiction.autonet.charter", '{"axes":[{"id" : "care"}]}');
            const epoch = await epochWith([[a1, [review({ axes: "0x" })]], [a2, [review({ axes: "0x" })]]]);
            expect((await bond.epochInfo(epoch)).axisIds).to.deep.equal([]);
            await bond.finalize(DIGEST, epoch, 10);
            expect((await bond.reviewOf(DIGEST, epoch, a1.address)).accuracy).to.equal(ONE);
        });

        it("a commit needs its household's REP at the epoch's start, once per epoch, and takes no ATN", async function () {
            await expect(commit(outsider, [clean()])).to.be.revertedWithCustomError(bond, "NoWeight");
            const before = await substrate.balanceOf(a1.address);
            await commit(a1, [clean()]);
            await expect(commit(a1, [clean()])).to.be.revertedWithCustomError(bond, "AlreadyCommitted");
            expect(await substrate.balanceOf(a1.address)).to.equal(before);
        });

        it("reveals come after the anchor, within the window, matching the commit; anyone can relay them", async function () {
            const epoch = await commit(a1, [clean()]);
            await expect(reveal(a1, epoch)).to.be.revertedWithCustomError(bond, "TooEarly");
            await anchor();
            const { reviews } = batches.get(`${epoch}:${a1.address}`);
            await expect(bond.reveal(epoch, a1.address, reviews, ethers.ZeroHash)).to.be.revertedWithCustomError(bond, "BadReveal");
            await expect(reveal(a1, epoch, outsider)).to.emit(bond, "Reviewed") // relayed
                .withArgs(DIGEST, epoch, a1.address, 50, 50, 50, 0, scores(50, 50), REP(300), EVIDENCE);
            expect((await bond.reviewOf(DIGEST, epoch, a1.address)).reviewer).to.equal(a1.address);
            await expect(reveal(a1, epoch)).to.be.revertedWithCustomError(bond, "BadReveal");

            const late = await commit(a2, [clean()]);
            await anchor();
            await time.increase(PARAMS.revealWindow + 1);
            await expect(reveal(a2, late)).to.be.revertedWithCustomError(bond, "TooLate");
        });

        it("reviews that can't count are skipped without voiding the batch", async function () {
            const d2 = ethers.id("unbonded tool");
            const epoch = await commit(a1, [
                review({ c: NO }),                       // a fixed field missing
                review({ s: 255 }),
                review({ n: 101 }),
                review({ m: 2 }),
                review({ c: 101 }),
                review({ digest: d2 }),                  // no bond
                review({ axes: scores(50) }),            // wrong axis count
                review({ axes: scores(101, 0) }),        // out of range
                clean(),
                clean(),                                 // a repeat
            ]);
            await commit(author, [clean()]); // the author's own tool
            await anchor();
            await expect(reveal(a1, epoch)).to.emit(bond, "Revealed").withArgs(epoch, a1.address, 1);
            await reveal(author, epoch);
            expect((await bond.getRound(DIGEST, epoch)).reviewCount).to.equal(1);
        });

        it("a batch never revealed loses degradeBps of its REP per declared review", async function () {
            const epoch = await commit(a1, [clean(), clean(), clean()]);
            expect(await bond.reviewCountOf(epoch, a1.address)).to.equal(3);
            await anchor();
            await expect(bond.forfeit(epoch, a1.address)).to.be.revertedWithCustomError(bond, "TooEarly");
            await time.increase(PARAMS.revealWindow + 1);
            await expect(bond.connect(outsider).forfeit(epoch, a1.address))
                .to.emit(bond, "Forfeited").withArgs(epoch, a1.address, REP(90));
            expect(await rep.balanceOf(a1.address)).to.equal(REP(210)); // 300 - 3 x 10% x 300
            await expect(bond.forfeit(epoch, a1.address)).to.be.revertedWithCustomError(bond, "WrongStage");
        });

        it("a reveal must hold as many reviews as its commit declared", async function () {
            const epoch = await bond.currentEpoch();
            const reviews = [clean()];
            const salt = ethers.ZeroHash;
            await bond.connect(a1).commit(await bond.commitmentOf(epoch, a1.address, reviews, salt), 2);
            await anchor();
            await expect(bond.reveal(epoch, a1.address, reviews, salt)).to.be.revertedWithCustomError(bond, "BadReveal");
        });
    });

    describe("settlement", function () {
        it("accuracy weighs every field and axis the same; REP moves from inaccurate to accurate reviews, no ATN", async function () {
            const epoch = await epochWith([
                [a1, [clean()]],
                [a2, [clean()]],
                [a3, [review({ c: -100, s: 0, n: 0, m: 1, axes: scores(-100, -100) })]],
            ]);
            await bond.finalize(DIGEST, epoch, 10);

            // Means: correctness and axes (300x50 + 200x50 - 100x100) / 600 = 25; malware yes 100/600
            const c = await bond.roundAxis(DIGEST, epoch, 0);
            expect(c.sum / c.mass).to.equal(25);
            const m = await bond.roundAxis(DIGEST, epoch, 3);
            expect(m.sum).to.equal(REP(100) * 100n);
            expect(m.mass).to.equal(REP(600));
            // a1 against the others (a2 200, a3 100): correctness and both axes 1 - 50/200 = 0.75, simplicity
            // and novelty 1 - 16.67/100, malware 1 - 1/3: 4.5833 / 6
            const a1Acc = (await bond.reviewOf(DIGEST, epoch, a1.address)).accuracy;
            expect(a1Acc).to.be.within(763888888888888880n, 763888888888888890n);
            // a3 against a1 and a2: 0.25 x 3, 0.5 x 2, malware 0: 1.75 / 6
            expect((await bond.reviewOf(DIGEST, epoch, a3.address)).accuracy).to.be.within(291666666666666660n, 291666666666666670n);

            const atn = await Promise.all([a1, a2, a3].map((s) => substrate.balanceOf(s.address)));
            await claimAll(epoch, [a1, a2, a3]);
            for (const [i, s] of [a1, a2, a3].entries()) expect(await substrate.balanceOf(s.address)).to.equal(atn[i]);
            // No REP created; rounding leaves a few wei burned
            expect(await rep.totalSupply()).to.be.within(REP(1000) - 10n, REP(1000));
            expect(await rep.balanceOf(a3.address)).to.be.lessThan(REP(100));
            expect(await rep.balanceOf(a1.address)).to.be.greaterThan(REP(300));
            await expect(bond.claim(DIGEST, epoch, a1.address)).to.be.revertedWithCustomError(bond, "NothingToClaim");

            // The tool's ratings carry the round: fixed fields keyed by index, axes by id
            const rating = await bond.toolRating(DIGEST, ethers.toBeHex(0, 32));
            expect(rating.mass).to.equal(REP(600));
            expect(rating.sum).to.equal(c.sum);
            expect((await bond.toolRating(DIGEST, ethers.toBeHex(3, 32))).sum).to.equal(m.sum);
            expect((await bond.toolRating(DIGEST, ethers.id("care"))).sum).to.equal(c.sum);
        });

        it("an unscored axis counts at the default with the review's weight, in the sums and in accuracy", async function () {
            // a1 leaves both axes unscored (50 at the default), a2 scores 50 and 100
            const epoch = await epochWith([
                [a1, [review({ axes: "0x" })]],
                [a2, [review({ axes: scores(50, NO) })]],
            ]);
            await bond.finalize(DIGEST, epoch, 10);
            expect((await bond.roundAxis(DIGEST, epoch, 4)).sum).to.equal(REP(500) * 50n);
            expect((await bond.roundAxis(DIGEST, epoch, 5)).mass).to.equal(REP(500));
            expect((await bond.reviewOf(DIGEST, epoch, a1.address)).accuracy).to.equal(ONE);

            await registry.editRegistry("jurisdiction.autonet.unscored_axis_bps", "10000"); // unscored is top
            const e1 = await epochWith([
                [a1, [review({ axes: scores(NO, 100) })]],
                [a2, [review({ axes: scores(100, 0) })]],
            ]);
            await bond.finalize(DIGEST, e1, 10);
            expect((await bond.roundAxis(DIGEST, e1, 4)).sum).to.equal(REP(500) * 100n);
            // Agree on correctness, simplicity, novelty, malware and care; growth 1 - 100/200
            expect((await bond.reviewOf(DIGEST, e1, a1.address)).accuracy).to.equal(ONE * 55n / 60n);
        });

        it("a lone reviewer is measured against no one, so it gains nothing and loses nothing", async function () {
            const epoch = await epochWith([[a3, [review({ c: 100, m: 1 })]]]);
            await bond.finalize(DIGEST, epoch, 10);
            expect((await bond.reviewOf(DIGEST, epoch, a3.address)).accuracy).to.equal(UNINFORMATIVE);
            await bond.claim(DIGEST, epoch, a3.address);
            expect(await rep.balanceOf(a3.address)).to.equal(REP(100));
        });

        it("finalize works in batches", async function () {
            const epoch = await epochWith([[a1, [clean()]], [a2, [clean()]], [a3, [clean()]]]);
            await bond.finalize(DIGEST, epoch, 2);
            expect((await bond.getRound(DIGEST, epoch)).stage).to.equal(2n); // Finalizing
            await expect(bond.claim(DIGEST, epoch, a1.address)).to.be.revertedWithCustomError(bond, "WrongStage");
            await bond.finalize(DIGEST, epoch, 2);
            expect((await bond.getRound(DIGEST, epoch)).stage).to.equal(3n); // Done
        });

        it("ratings accumulate across epochs", async function () {
            const e0 = await epochWith([[a1, [review({ c: 100 })]]]);
            await bond.finalize(DIGEST, e0, 10);
            const e1 = await epochWith([[a2, [review({ c: 0 })]]]);
            await bond.finalize(DIGEST, e1, 10);
            const c = await bond.toolRating(DIGEST, ethers.toBeHex(0, 32));
            expect(c.mass).to.equal(REP(500));
            expect(c.sum).to.equal(REP(300) * 100n);
            expect((await bond.toolRating(DIGEST, ethers.id("growth"))).mass).to.equal(REP(500));
        });
    });

    describe("malware", function () {
        // a1 and a2 say malware (500 of 600 REP), a3 doesn't
        async function malwareRound(digest = DIGEST) {
            const epoch = await epochWith([[a1, [malware(digest)]], [a2, [malware(digest)]], [a3, [clean(digest)]]]);
            await bond.finalize(digest, epoch, 10);
            return epoch;
        }
        const SHARE = 8333n * 10n ** 14n; // the close's 5/6, in bps

        it("is judged when the anchored close names the tool concluded: more than half yes opens the appeal window", async function () {
            const epoch = await malwareRound();
            expect((await bond.getRound(DIGEST, epoch)).beforeConclusion).to.equal(true);
            await expect(bond.conclude(DIGEST, 0, 8333, [])).to.be.revertedWithCustomError(bond, "BadProof");
            await expect(bond.conclude(ethers.id("no bond"), 0, 8333, [])).to.be.revertedWithCustomError(bond, "NotBonded");
            // A two-leaf close: the tool next to a mint leaf
            const mintLeaf = ethers.keccak256(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [a1.address, 5])));
            const index = await anchor(pair(leaf(DIGEST, 8333), mintLeaf));
            await expect(bond.conclude(DIGEST, index, 8333, [ethers.ZeroHash])).to.be.revertedWithCustomError(bond, "BadProof");
            // The share is the close's: another one doesn't prove
            await expect(bond.conclude(DIGEST, index, 4000, [mintLeaf])).to.be.revertedWithCustomError(bond, "BadProof");
            await expect(bond.conclude(DIGEST, index, 10001, [mintLeaf])).to.be.revertedWithCustomError(bond, "BadProof");
            const tx = bond.conclude(DIGEST, index, 8333, [mintLeaf]);
            await expect(tx).to.emit(bond, "Concluded");
            const v = await bond.verdicts(DIGEST);
            expect(v.share).to.equal(SHARE);
            expect(v.yesMass).to.equal(REP(500));
            expect(v.appealEnds).to.equal(BigInt(await time.latest()) + BigInt(PARAMS.appealPeriod));
            await expect(bond.conclude(DIGEST, index, 8333, [mintLeaf])).to.be.revertedWithCustomError(bond, "WrongStage");
        });

        it("after the window, the bond loses the share of yes and the author's REP burns that share, for the yes reviewers", async function () {
            await malwareRound();
            await concludeTool();
            await bond.connect(author).requestUnbond(DIGEST);
            await expect(bond.settleMalware(DIGEST)).to.be.revertedWithCustomError(bond, "TooEarly");
            await time.increase(PARAMS.unbondDelay + 1);
            await expect(bond.connect(author).withdraw(DIGEST)).to.be.revertedWithCustomError(bond, "RoundActive");

            const slashed = MIN_STAKE * SHARE / ONE;
            const burned = REP(400) * SHARE / ONE;
            await expect(bond.connect(outsider).settleMalware(DIGEST))
                .to.emit(bond, "MalwareSettled").withArgs(DIGEST, true, slashed, burned)
                .and.to.emit(bond, "AuthorRepBurned").withArgs(DIGEST, author.address, burned);
            expect(await rep.balanceOf(author.address)).to.equal(REP(400) - burned);
            await expect(bond.settleMalware(DIGEST)).to.be.revertedWithCustomError(bond, "WrongStage");

            // The slashed bond goes to the yes reviewers by REP, as earnings (less the service fee)
            const epoch = 0n;
            const before = await substrate.balanceOf(a1.address);
            await expect(bond.claimBondShare(DIGEST, epoch, a1.address))
                .to.emit(bond, "BondShareClaimed").withArgs(DIGEST, epoch, a1.address, slashed * 3n / 5n);
            const share = slashed * 3n / 5n;
            expect(await substrate.balanceOf(a1.address) - before).to.equal(share - share * 250n / 10000n);
            await bond.claimBondShare(DIGEST, epoch, a2.address);
            await expect(bond.claimBondShare(DIGEST, epoch, a1.address)).to.be.revertedWithCustomError(bond, "NothingToClaim");
            await expect(bond.claimBondShare(DIGEST, epoch, a3.address)).to.be.revertedWithCustomError(bond, "NothingToClaim");

            const left = await substrate.balanceOf(author.address);
            await bond.connect(author).withdraw(DIGEST);
            expect(await substrate.balanceOf(author.address) - left).to.equal(MIN_STAKE - slashed);
        });

        it("half or less saying yes concludes clean: nothing to appeal or slash", async function () {
            const epoch = await epochWith([[a1, [clean()]], [a2, [malware()]], [a3, [malware()]]]); // 300 of 600
            await bond.finalize(DIGEST, epoch, 10);
            const v = await concludeTool(DIGEST, 5000);
            expect(v.share).to.equal(ONE / 2n);
            expect(v.appealEnds).to.equal(0);
            expect(v.settled).to.equal(true);
            await expect(bond.settleMalware(DIGEST)).to.be.revertedWithCustomError(bond, "WrongStage");
            await expect(bond.connect(timelock).daoOverrule(DIGEST, true)).to.be.revertedWithCustomError(bond, "WrongStage");
            expect((await bond.bonds(DIGEST)).stake).to.equal(MIN_STAKE);
        });

        it("takes no more of the author's REP than the REP that said yes", async function () {
            const epoch = await epochWith([[a3, [malware()]]]);
            await bond.finalize(DIGEST, epoch, 10);
            await concludeTool(DIGEST, 10000);
            await time.increase(PARAMS.appealPeriod + 1);
            await bond.settleMalware(DIGEST);
            // share 1 and authorSlashBps 100% would take all 400, capped at a3's 100
            expect(await rep.balanceOf(author.address)).to.equal(REP(300));
            expect((await bond.bonds(DIGEST)).stake).to.equal(0);
        });

        it("rounds finalized after the conclusion still rate the tool but share no slashed bond", async function () {
            await malwareRound();
            await concludeTool();
            const later = await epochWith([[a1, [malware()]], [a2, [malware()]]]);
            await bond.finalize(DIGEST, later, 10);
            expect((await bond.getRound(DIGEST, later)).beforeConclusion).to.equal(false);
            expect((await bond.toolRating(DIGEST, ethers.toBeHex(3, 32))).mass).to.equal(REP(600) + (await bond.getRound(DIGEST, later)).weight);
            await time.increase(PARAMS.appealPeriod + 1);
            await bond.settleMalware(DIGEST);
            await expect(bond.claimBondShare(DIGEST, later, a1.address)).to.be.revertedWithCustomError(bond, "NothingToClaim");
            await bond.claimBondShare(DIGEST, 0, a1.address);
        });

        // A proposal calling daoOverrule on the tool, with its id and registerDaoProposal's arguments
        async function overruleProposal(state, deadline, eta = 0, digest = DIGEST, ruling = false) {
            const p = [[await bond.getAddress()], [0n], [bond.interface.encodeFunctionData("daoOverrule", [digest, ruling])],
                ethers.id(`overrule ${digest} ${deadline}`)];
            const id = await governor.hashProposal(...p);
            await governor.setProposal(id, state, deadline, eta);
            return { id, args: [DIGEST, ...p] };
        }

        it("only the author appeals, and an appeal registered in the window holds the slash until the DAO rules", async function () {
            await malwareRound();
            await concludeTool();
            const deadline = BigInt(await time.latest()) + BigInt(PARAMS.appealPeriod);
            const p = await overruleProposal(1, deadline); // Active
            await expect(bond.connect(outsider).registerDaoProposal(...p.args)).to.be.revertedWithCustomError(bond, "NotAuthor");
            const until = deadline + 2n * BigInt(DAY); // the timelock is a signer: no delay
            await expect(bond.connect(author).registerDaoProposal(...p.args))
                .to.emit(bond, "DaoProposalRegistered").withArgs(DIGEST, p.id, until);
            expect((await bond.verdicts(DIGEST)).heldUntil).to.equal(until);

            await time.increase(PARAMS.appealPeriod + 1);
            await expect(bond.settleMalware(DIGEST)).to.be.revertedWithCustomError(bond, "TooEarly");
            await expect(bond.connect(outsider).daoOverrule(DIGEST, false)).to.be.revertedWithCustomError(bond, "NotTimelock");
            await expect(bond.connect(timelock).daoOverrule(DIGEST, false)).to.emit(bond, "MalwareRuled").withArgs(DIGEST, false);
            await expect(bond.connect(timelock).daoOverrule(DIGEST, true)).to.be.revertedWithCustomError(bond, "WrongStage");
            await expect(bond.settleMalware(DIGEST)).to.emit(bond, "MalwareSettled").withArgs(DIGEST, false, 0, 0);
            expect((await bond.bonds(DIGEST)).stake).to.equal(MIN_STAKE);
            expect(await rep.balanceOf(author.address)).to.equal(REP(400));
            await expect(bond.claimBondShare(DIGEST, 0, a1.address)).to.be.revertedWithCustomError(bond, "NothingToClaim");
        });

        it("the DAO upholding the verdict settles it at once, in full: its ruling replaces the reviewers' share", async function () {
            await malwareRound();
            await concludeTool();
            await bond.connect(timelock).daoOverrule(DIGEST, true);
            await expect(bond.settleMalware(DIGEST)).to.emit(bond, "MalwareSettled").withArgs(DIGEST, true, MIN_STAKE, REP(400));
            expect((await bond.bonds(DIGEST)).stake).to.equal(0);
            expect(await rep.balanceOf(author.address)).to.equal(0); // 400, under the 500 that said yes
        });

        it("an author can't withdraw while more than half the REP of the tool's finalized rounds says malware and it hasn't concluded", async function () {
            await malwareRound();
            await bond.connect(author).requestUnbond(DIGEST);
            await time.increase(PARAMS.unbondDelay + 1);
            await expect(bond.connect(author).withdraw(DIGEST)).to.be.revertedWithCustomError(bond, "MalwareSuspected");
            // Once the verdict settles (here the DAO clears it), the bond can leave
            await concludeTool();
            await bond.connect(timelock).daoOverrule(DIGEST, false);
            await bond.settleMalware(DIGEST);
            await bond.connect(author).withdraw(DIGEST);
        });

        it("a slashed bond with no yes in a finalized round goes to the treasury", async function () {
            await concludeTool(DIGEST, 10000); // the close counted rounds not finalized here
            await time.increase(PARAMS.appealPeriod + 1);
            await expect(bond.settleMalware(DIGEST)).to.emit(bond, "MalwareSettled").withArgs(DIGEST, true, MIN_STAKE, 0);
            expect(await substrate.balanceOf(treasury)).to.equal(MIN_STAKE);
            expect((await bond.verdicts(DIGEST)).bondPool).to.equal(0);
        });

        it("a registered appeal that never lands holds only until it could have", async function () {
            await malwareRound();
            await concludeTool();
            const eta = BigInt(await time.latest()) + BigInt(PARAMS.appealPeriod) * 2n;
            const p = await overruleProposal(5, eta - 100n, eta); // Queued: held to eta plus the grace
            await bond.connect(author).registerDaoProposal(...p.args);
            expect((await bond.verdicts(DIGEST)).heldUntil).to.equal(eta + BigInt(DAY));
            await time.increaseTo(eta + BigInt(DAY) - 1n);
            await expect(bond.settleMalware(DIGEST)).to.be.revertedWithCustomError(bond, "TooEarly");
            await expect(bond.settleMalware(DIGEST)).to.emit(bond, "MalwareSettled");
        });

        it("refuses appeals about another tool, for a dead proposal, or after the window", async function () {
            await malwareRound();
            await concludeTool();
            const deadline = BigInt(await time.latest()) + 1000n;
            const other = await overruleProposal(1, deadline, 0, ethers.id("other tool"));
            await expect(bond.connect(author).registerDaoProposal(...other.args)).to.be.revertedWithCustomError(bond, "NotAboutTool");
            const defeated = await overruleProposal(3, deadline);
            await expect(bond.connect(author).registerDaoProposal(...defeated.args)).to.be.revertedWith("Proposal isn't live");
            await time.increase(PARAMS.appealPeriod + 1);
            const late = await overruleProposal(1, deadline + BigInt(PARAMS.appealPeriod));
            await expect(bond.connect(author).registerDaoProposal(...late.args)).to.be.revertedWithCustomError(bond, "TooLate");
            await expect(bond.connect(timelock).daoOverrule(DIGEST, false)).to.be.revertedWithCustomError(bond, "TooLate");
        });
    });

    // REP sits on owner wallets: a1 (300 REP) is a household whose agents h1 and h2 hold none
    describe("households", function () {
        let h1, h2, h3;
        beforeEach(async function () {
            [h1, h2, h3] = (await ethers.getSigners()).slice(7, 10);
            await registerAgent(substrate, h1, "0x11", a1);
            await registerAgent(substrate, h2, "0x12", a1);
            for (const s of [h1, h2, h3]) await fund(s, ATN(200));
        });

        it("an agent's review weighs its owner's REP at the epoch's start", async function () {
            const epoch = await commit(h1, [clean()]);
            expect((await bond.commits(epoch, h1.address)).weight).to.equal(REP(300));
            expect(await bond.householdOf(epoch, h1.address)).to.equal(a1.address);
            await anchor();
            await reveal(h1, epoch);
            expect((await bond.reviewOf(DIGEST, epoch, h1.address)).weight).to.equal(REP(300));
            expect((await bond.getRound(DIGEST, epoch)).weight).to.equal(REP(300));
        });

        it("a household weighs once per tool: its earliest commit carries it, whatever the reveal order", async function () {
            const epoch = await commit(h1, [clean()]);
            await commit(h2, [review({ c: -50, m: 1, axes: scores(-50, NO) })]);
            await commit(a2, [clean()]);
            await anchor();
            await reveal(h2, epoch); // weighs at first
            expect((await bond.reviewOf(DIGEST, epoch, h2.address)).weight).to.equal(REP(300));
            await expect(reveal(h1, epoch)).to.emit(bond, "ReviewUnweighted").withArgs(DIGEST, epoch, h2.address);
            await reveal(a2, epoch);

            expect((await bond.reviewOf(DIGEST, epoch, h1.address)).weight).to.equal(REP(300));
            expect((await bond.reviewOf(DIGEST, epoch, h2.address)).weight).to.equal(0);
            expect((await bond.getRound(DIGEST, epoch)).weight).to.equal(REP(500));
            // h2's values left with its weight, its unscored axis included
            for (const [i, sum] of [[0, 50n], [3, 0n], [4, 50n], [5, 50n]]) {
                const a = await bond.roundAxis(DIGEST, epoch, i);
                expect(a.sum, `field ${i}`).to.equal(REP(500) * sum);
                expect(a.mass).to.equal(REP(500));
            }
        });

        it("a later commit of the same household reviews at zero weight", async function () {
            const epoch = await commit(h1, [clean()]);
            await commit(h2, [clean()]);
            await anchor();
            await reveal(h1, epoch);
            await expect(reveal(h2, epoch)).to.not.emit(bond, "ReviewUnweighted");
            expect((await bond.reviewOf(DIGEST, epoch, h2.address)).weight).to.equal(0);
            expect((await bond.getRound(DIGEST, epoch)).weight).to.equal(REP(300));
        });

        it("REP a review loses or wins moves on its household, never on the agent key", async function () {
            const epoch = await epochWith([
                [h1, [review({ c: -100, axes: scores(-100, -100) })]],
                [a2, [review({ c: 100, axes: scores(100, 100) })]],
                [a3, [review({ c: 100, axes: scores(100, 100) })]],
            ]);
            await bond.finalize(DIGEST, epoch, 10);
            expect(await rep.balanceOf(a1.address)).to.be.lessThan(REP(300));
            await claimAll(epoch, [h1, a2, a3]);
            expect(await rep.balanceOf(h1.address)).to.equal(0);
            expect(await rep.totalSupply()).to.be.within(REP(1000) - 10n, REP(1000));
        });

        it("a withheld batch costs its household degradeBps of the REP it weighed", async function () {
            const epoch = await commit(h1, [clean()]);
            await anchor();
            await time.increase(PARAMS.revealWindow + 1);
            await bond.forfeit(epoch, h1.address);
            expect(await rep.balanceOf(a1.address)).to.equal(REP(270));
        });

        it("no household reviews its own tool, and malware slashes the household that bonded it, whoever owns the author later", async function () {
            const [h4, empty] = (await ethers.getSigners()).slice(10, 12);
            await registerAgent(substrate, h3, "0x13", a3);
            await registerAgent(substrate, h4, "0x14", a3);
            const tool = ethers.id("h3 tool");
            await substrate.connect(h3).registerTool(tool);
            await bond.connect(h3).bond(tool, MIN_STAKE);
            expect(await bond.bondHousehold(tool)).to.equal(a3.address);

            // The author agent moves to an empty wallet and tops up: the liability doesn't move
            const domain = { name: "AutonetSubstrate", version: "1",
                chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await substrate.getAddress() };
            const types = { OwnerBinding: [
                { name: "agent", type: "address" }, { name: "parent", type: "address" }, { name: "nonce", type: "uint256" }] };
            const sig = await empty.signTypedData(domain, types,
                { agent: h3.address, parent: ethers.ZeroAddress, nonce: await substrate.bindingNonce(h3.address) });
            await substrate.connect(h3).rotateOwner(empty.address, ethers.ZeroAddress, sig);
            await bond.connect(h3).bond(tool, ATN(1));
            expect(await bond.bondHousehold(tool)).to.equal(a3.address);

            const epoch = await epochWith([
                [h1, [malware(tool)]],
                [a2, [malware(tool)]],
                [h4, [clean(tool)]], // a3's own household: refused
            ]);
            expect((await bond.reviewOf(tool, epoch, h4.address)).reviewer).to.equal(ethers.ZeroAddress);
            await bond.finalize(tool, epoch, 10);
            await concludeTool(tool, 10000);
            await time.increase(PARAMS.appealPeriod + 1);
            await bond.settleMalware(tool);
            expect(await rep.balanceOf(a3.address)).to.equal(0); // share 1, authorSlashBps 100%
        });
    });

    describe("governance", function () {
        it("only the timelock sets parameters, within bounds", async function () {
            await expect(bond.connect(outsider).setParams(PARAMS)).to.be.revertedWithCustomError(bond, "NotTimelock");
            await expect(bond.connect(timelock).setParams({ ...PARAMS, degradeBps: 10001 })).to.be.revertedWithCustomError(bond, "BadParams");
            await expect(bond.connect(timelock).setParams({ ...PARAMS, revealWindow: 0 })).to.be.revertedWithCustomError(bond, "BadParams");
            await bond.connect(timelock).setParams({ ...PARAMS, appealPeriod: 3 * DAY });
            expect(await bond.appealPeriod()).to.equal(3 * DAY);
        });
    });
});
