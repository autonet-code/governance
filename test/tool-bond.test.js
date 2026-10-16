const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { autonet } = require("./helpers/autonet");

// ToolBond against the real Substrate and a RepToken. The deployer is the Substrate's vault minter
// (to fund accounts with ATN) and the RepToken's admin (to grant the bond slasher rights); a plain
// signer stands in for the governor and timelock, so the appeal window is the 7-day appealPeriod.
//
// REP: a1 300, a2 200, a3 100, author 400 (total 1000). Threshold 55% = 550, so all three
// auditors fit in a round and the third commit closes it.
describe("ToolBond", function () {
    let deployer, timelock, author, a1, a2, a3, outsider;
    let substrate, rep, bond;

    const ATN = (n) => ethers.parseUnits(String(n), 6);
    const REP = (n) => ethers.parseEther(String(n));
    const net = (x) => x - (x * 250n) / 10000n; // after the Substrate's 2.5% service fee
    const DIGEST = ethers.id("tool manifest v1");
    const MIN_STAKE = ATN(100);
    const DAY = 86400;
    const APPEAL = 7 * DAY;
    const PARAMS = {
        minStake: MIN_STAKE, thresholdBps: 5500, reviewWindow: 3 * DAY, revealWindow: DAY,
        finderBps: 5000, degradeBps: 1000, authorSlashBps: 10000, unbondDelay: 14 * DAY, auditorShareBps: 4000,
        appealPeriod: 7 * DAY,
    };
    const EVIDENCE = ethers.id("evidence");
    const salts = new Map();

    async function fund(signer, amount) {
        await substrate.mintFromVault(signer.address, amount);
        await substrate.connect(signer).approve(await bond.getAddress(), ethers.MaxUint256);
    }

    async function commit(signer, red, digest = DIGEST) {
        const round = (await bond.bonds(digest)).round;
        const r = await bond.getRound(digest, round);
        // A commit on a finished round opens the next one
        const next = r.stage === 5n ? round + 1n : round;
        const salt = ethers.hexlify(ethers.randomBytes(32));
        salts.set(`${digest}:${signer.address}`, { red, salt });
        await bond.connect(signer).commitFlag(digest,
            await bond.commitmentOf(digest, next, signer.address, red, EVIDENCE, salt));
    }

    async function reveal(signer, digest = DIGEST) {
        const { red, salt } = salts.get(`${digest}:${signer.address}`);
        await bond.connect(signer).revealFlag(digest, red, EVIDENCE, salt);
    }

    // Commit all three, reveal the given ones, settle
    async function verdict(colors, silent = []) {
        for (const [s, red] of colors) await commit(s, red);
        for (const [s] of colors) if (!silent.includes(s)) await reveal(s);
        await time.increase(PARAMS.revealWindow + 1);
        await bond.settle(DIGEST);
    }

    beforeEach(async function () {
        [deployer, timelock, author, a1, a2, a3, outsider] = await ethers.getSigners();
        substrate = await autonet("Substrate", deployer).deploy(ethers.ZeroAddress, deployer.address, ethers.ZeroAddress, ethers.ZeroAddress, 5000, [deployer.address], 1);
        rep = await (await ethers.getContractFactory("RepToken")).deploy("Rep", "REP", deployer.address, timelock.address,
            [a1.address, a2.address, a3.address, author.address], [REP(300), REP(200), REP(100), REP(400)], false);
        // Signers stand in for the governor and timelock, so the lifecycle floor is just the 2-day buffer
        bond = await (await ethers.getContractFactory("ToolBond")).deploy(
            await substrate.getAddress(), await rep.getAddress(), deployer.address, timelock.address, PARAMS);
        await rep.setSlasher(await bond.getAddress(), true);

        await substrate.connect(author).registerAgent(ethers.id("author"), "0x01");
        await substrate.connect(author).registerTool(DIGEST);
        await fund(author, ATN(1000));
        await bond.connect(author).bond(DIGEST, MIN_STAKE);
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
            expect(await bond.isVetted(d2)).to.equal(false);
        });

        it("an active round holds the stake past the unbond delay; no round opens after it", async function () {
            await bond.connect(author).requestUnbond(DIGEST);
            expect(await bond.isBonded(DIGEST)).to.equal(false);
            await commit(a1, true); // still reviewable while unbonding
            await time.increase(PARAMS.unbondDelay + 1);
            // The round was below threshold and has lapsed by now, so it no longer holds the stake,
            // and a fresh round can't open after the delay
            await expect(commit(a2, true)).to.be.revertedWithCustomError(bond, "TooLate");
            await expect(bond.connect(author).withdraw(DIGEST)).to.changeTokenBalance(substrate, author, MIN_STAKE);
        });

        it("a round past its threshold blocks the withdrawal until it is finished", async function () {
            await bond.connect(author).requestUnbond(DIGEST);
            await verdict([[a1, false], [a2, false], [a3, false]]);
            await time.increase(PARAMS.unbondDelay);
            await expect(bond.connect(author).withdraw(DIGEST)).to.be.revertedWithCustomError(bond, "RoundActive");
            await bond.finalize(DIGEST, 10);
            await expect(bond.connect(author).withdraw(DIGEST)).to.changeTokenBalance(substrate, author, MIN_STAKE);
        });
    });

    describe("flags", function () {
        it("the first commit opens a round on a REP snapshot; flaggers need REP, the author can't flag, one flag each", async function () {
            await expect(commit(outsider, true)).to.be.revertedWithCustomError(bond, "NoWeight");
            await expect(commit(author, true)).to.be.revertedWithCustomError(bond, "NotAuthor");
            await commit(a1, true);
            const r = await bond.getRound(DIGEST, 0);
            expect(r.stage).to.equal(1n); // Commit
            expect(r.threshold).to.equal(REP(550));
            expect(r.committed).to.equal(REP(300));
            await expect(commit(a1, false)).to.be.revertedWithCustomError(bond, "AlreadyFlagged");
        });

        it("REP gained after the snapshot doesn't count", async function () {
            await commit(a1, true);
            await rep.mint(outsider.address, REP(1000));
            await expect(commit(outsider, true)).to.be.revertedWithCustomError(bond, "NoWeight");
        });

        it("commits close at the threshold; reveals must match and come within the window", async function () {
            await commit(a1, true);
            await commit(a2, true);
            await commit(a3, false);
            expect((await bond.getRound(DIGEST, 0)).stage).to.equal(2n); // Reveal
            await expect(commit(outsider, true)).to.be.revertedWithCustomError(bond, "WrongStage");

            await expect(bond.connect(a1).revealFlag(DIGEST, false, EVIDENCE, salts.get(`${DIGEST}:${a1.address}`).salt))
                .to.be.revertedWithCustomError(bond, "BadReveal");
            await reveal(a1);
            await expect(bond.settle(DIGEST)).to.be.revertedWithCustomError(bond, "TooEarly");
            await time.increase(PARAMS.revealWindow + 1);
            await expect(reveal(a2)).to.be.revertedWithCustomError(bond, "TooLate");
        });
    });

    describe("verdicts", function () {
        it("malware: the finder takes half the stake, red flaggers split the rest and the slashed REP by weight", async function () {
            await verdict([[a1, true], [a2, true], [a3, false]]);
            await expect(bond.finalize(DIGEST, 10)).to.be.revertedWithCustomError(bond, "TooEarly");
            await time.increase(APPEAL + 1);

            const b1 = await substrate.balanceOf(a1.address);
            const b2 = await substrate.balanceOf(a2.address);
            await bond.finalize(DIGEST, 10);
            expect(await rep.balanceOf(author.address)).to.equal(0);   // fully slashed
            expect(await rep.balanceOf(a3.address)).to.equal(REP(90)); // wrong green: -10%
            expect(await bond.isBonded(DIGEST)).to.equal(false);
            await expect(bond.connect(author).bond(DIGEST, MIN_STAKE)).to.be.revertedWithCustomError(bond, "Slashed");

            await bond.connect(a1).claim(DIGEST, 0);
            await bond.connect(a2).claim(DIGEST, 0);
            await expect(bond.connect(a3).claim(DIGEST, 0)).to.be.revertedWithCustomError(bond, "NothingToClaim");
            await expect(bond.connect(a1).claim(DIGEST, 0)).to.be.revertedWithCustomError(bond, "NothingToClaim");

            // Stake 100: finder a1 gets 50, the other 50 splits 300:200
            expect(await substrate.balanceOf(a1.address)).to.equal(b1 + net(ATN(50)) + net(ATN(30)));
            expect(await substrate.balanceOf(a2.address)).to.equal(b2 + net(ATN(20)));
            // REP pool 400 + 10 = 410, split 300:200; supply is unchanged
            expect(await rep.balanceOf(a1.address)).to.equal(REP(300) + REP(246));
            expect(await rep.balanceOf(a2.address)).to.equal(REP(200) + REP(164));
            expect(await rep.totalSupply()).to.equal(REP(1000));
        });

        it("clean: the tool is vetted, wrong red flaggers lose REP to the green ones, the author keeps everything", async function () {
            await verdict([[a1, false], [a2, false], [a3, true]]);
            await time.increase(APPEAL + 1);
            await bond.finalize(DIGEST, 10);
            expect(await bond.isVetted(DIGEST)).to.equal(true);
            expect(await rep.balanceOf(author.address)).to.equal(REP(400));
            await bond.connect(a1).claim(DIGEST, 0);
            await bond.connect(a2).claim(DIGEST, 0);
            expect(await rep.balanceOf(a3.address)).to.equal(REP(90));
            expect(await rep.balanceOf(a1.address)).to.equal(REP(306));
            expect(await rep.balanceOf(a2.address)).to.equal(REP(204));

            // New evidence reopens it; a pending malware verdict unvets it before it is final
            for (const [s, red] of [[a1, true], [a2, true], [a3, false]]) await commit(s, red);
            for (const s of [a1, a2, a3]) await reveal(s);
            await time.increase(PARAMS.revealWindow + 1);
            await bond.settle(DIGEST);
            expect(await bond.isBonded(DIGEST)).to.equal(true);
            expect(await bond.isVetted(DIGEST)).to.equal(false);
        });

        it("silent committers lose REP even on the winning side", async function () {
            await verdict([[a1, true], [a2, false], [a3, true]], [a3]);
            // red 300 vs green 200 (a3 never revealed): malware, and a3 is degraded with the loser
            await time.increase(APPEAL + 1);
            await bond.finalize(DIGEST, 10);
            expect((await bond.getRound(DIGEST, 0)).verdict).to.equal(2n);
            expect(await rep.balanceOf(a3.address)).to.equal(REP(90));
            expect(await rep.balanceOf(a2.address)).to.equal(REP(180));
            await expect(bond.connect(a3).claim(DIGEST, 0)).to.be.revertedWithCustomError(bond, "NothingToClaim");
        });

        it("a tie is void: nobody who revealed is slashed, the tool stays unvetted and can be reviewed again", async function () {
            await verdict([[a1, true], [a2, false], [a3, false]]); // 300 red vs 300 green
            expect((await bond.getRound(DIGEST, 0)).verdict).to.equal(3n); // Void
            await time.increase(APPEAL + 1);
            await bond.finalize(DIGEST, 10);
            expect(await rep.totalSupply()).to.equal(REP(1000));
            expect(await bond.isBonded(DIGEST)).to.equal(true);
            expect(await bond.isVetted(DIGEST)).to.equal(false);
            await commit(a1, false); // opens round 1
            expect((await bond.bonds(DIGEST)).round).to.equal(1n);
        });

        it("the DAO overrules within the appeal window and its ruling finalizes at once", async function () {
            await verdict([[a1, false], [a2, false], [a3, true]]);
            await expect(bond.connect(outsider).daoOverrule(DIGEST, true)).to.be.revertedWithCustomError(bond, "NotTimelock");
            await bond.connect(timelock).daoOverrule(DIGEST, true);
            const b3 = await substrate.balanceOf(a3.address);
            await bond.finalize(DIGEST, 10);
            await bond.connect(a3).claim(DIGEST, 0);
            // a3 is finder (50) and sole red flagger (the other 50), plus all slashed REP: author 400, a1 30, a2 20
            expect(await substrate.balanceOf(a3.address)).to.equal(b3 + net(ATN(50)) + net(ATN(50)));
            expect(await rep.balanceOf(a3.address)).to.equal(REP(100) + REP(450));
        });

        it("too late to overrule once the appeal window has passed", async function () {
            await verdict([[a1, false], [a2, false], [a3, true]]);
            await time.increase(APPEAL + 1);
            await expect(bond.connect(timelock).daoOverrule(DIGEST, true)).to.be.revertedWithCustomError(bond, "TooLate");
        });

        it("finalize works in batches", async function () {
            await verdict([[a1, false], [a2, false], [a3, true]]);
            await time.increase(APPEAL + 1);
            await bond.finalize(DIGEST, 1);
            await bond.finalize(DIGEST, 1);
            expect((await bond.getRound(DIGEST, 0)).stage).to.equal(4n); // Finalizing
            await bond.finalize(DIGEST, 1);
            expect((await bond.getRound(DIGEST, 0)).stage).to.equal(5n); // Done
            await expect(bond.finalize(DIGEST, 1)).to.be.revertedWithCustomError(bond, "WrongStage");
        });

        it("a round below threshold lapses after the review window with nothing paid or slashed", async function () {
            await commit(a1, true);
            await expect(bond.lapse(DIGEST)).to.be.revertedWithCustomError(bond, "TooEarly");
            await time.increase(PARAMS.reviewWindow + 1);
            await bond.lapse(DIGEST);
            expect((await bond.getRound(DIGEST, 0)).verdict).to.equal(3n); // Void
            expect(await rep.balanceOf(a1.address)).to.equal(REP(300));
            await commit(a2, true); // opens round 1
            expect((await bond.bonds(DIGEST)).round).to.equal(1n);
        });
    });

    describe("governance", function () {
        it("only the timelock sets parameters, within bounds", async function () {
            await expect(bond.connect(outsider).setParams(PARAMS)).to.be.revertedWithCustomError(bond, "NotTimelock");
            await expect(bond.connect(timelock).setParams({ ...PARAMS, thresholdBps: 0 })).to.be.revertedWithCustomError(bond, "BadParams");
            await expect(bond.connect(timelock).setParams({ ...PARAMS, unbondDelay: PARAMS.reviewWindow - 1 })).to.be.revertedWithCustomError(bond, "BadParams");
            await bond.connect(timelock).setParams({ ...PARAMS, minStake: ATN(500) });
            expect(await bond.minStake()).to.equal(ATN(500));
            expect(await bond.isBonded(DIGEST)).to.equal(false); // stake now below the minimum
        });
    });
});
