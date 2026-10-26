const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { createJurisdiction, REP } = require("./helpers/jurisdiction");

// A proposal whose only target is an approved option source is a single-choice election:
// support is the option index, the top tally wins, a tie goes to the lowest option hash.
describe("Option counting", function () {
    let a, b, c, d;
    const ACTIVE = 1n, DEFEATED = 3n, SUCCEEDED = 4n, EXECUTED = 7n;
    const H = (s) => ethers.id(s);

    before(async function () {
        [, a, b, c, d] = await ethers.getSigners();
    });

    function idOf(gov, rc) {
        return rc.logs.map((l) => { try { return gov.interface.parseLog(l); } catch { return null; } })
            .find((e) => e && e.name === "ProposalCreated").args.proposalId;
    }

    async function pass(gov, call, desc) {
        const id = idOf(gov, await (await gov.connect(a).propose(...call, desc)).wait());
        await time.increase(1);
        await gov.connect(a).castVote(id, 1);
        await gov.connect(b).castVote(id, 1);
        await gov.queue(...call, ethers.id(desc));
        await gov.execute(...call, ethers.id(desc));
    }

    // a 40%, b 35%, c 20%, d 5%
    async function setup({ quorumFraction = 4, allow = true, amounts = [REP(400), REP(350), REP(200), REP(50)] } = {}) {
        const j = await createJurisdiction(a, {
            members: [a.address, b.address, c.address, d.address], amounts,
            votingPeriod: 60 * 24 * 7, quorumFraction,
        });
        for (const s of [a, b, c, d]) await j.rep.connect(s).delegate(s.address);
        const source = await (await ethers.getContractFactory("MockOptionSource")).deploy();
        await source.setGovernor(await j.dao.getAddress());
        if (allow) await pass(j.dao, [[await j.dao.getAddress()], [0n], [j.dao.interface.encodeFunctionData("setOptionSource", [await source.getAddress(), true])]], "Allow source");
        const call = [[await source.getAddress()], [0n], [source.interface.encodeFunctionData("settle")]];
        const id = idOf(j.dao, await (await j.dao.connect(a).propose(...call, "Elect")).wait());
        await source.setOptions(id, [H("x"), H("y"), H("z")]);
        await time.increase(1);
        return { ...j, gov: j.dao, source, call, id };
    }

    it("only governance can approve a source", async function () {
        const { gov, source } = await setup({ allow: false });
        await expect(gov.connect(a).setOptionSource(await source.getAddress(), true))
            .to.be.revertedWithCustomError(gov, "GovernorOnlyExecutor");
    });

    it("an unapproved source's proposal counts as For/Against/Abstain", async function () {
        const { gov, id } = await setup({ allow: false });
        expect(await gov.optionSourceOf(id)).to.equal(ethers.ZeroAddress);
        await gov.connect(a).castVote(id, 1);
        await gov.connect(b).castVote(id, 1);
        expect(await gov.state(id)).to.equal(SUCCEEDED);
    });

    it("rejects an index past the options, and a second vote", async function () {
        const { gov, id } = await setup();
        await expect(gov.connect(a).castVote(id, 3)).to.be.revertedWithCustomError(gov, "GovernorInvalidVoteType");
        await gov.connect(a).castVote(id, 2);
        expect(await gov.hasVoted(id, a.address)).to.equal(true);
        await expect(gov.connect(a).castVote(id, 1)).to.be.revertedWithCustomError(gov, "GovernorAlreadyCastVote");
    });

    it("a split vote never passes early, even with a majority of REP cast", async function () {
        const { gov, id } = await setup();
        await gov.connect(a).castVote(id, 0);
        await gov.connect(b).castVote(id, 1);
        await gov.connect(c).castVote(id, 2);
        expect(await gov.state(id)).to.equal(ACTIVE); // 95% cast, leader holds 40%
        expect(await gov.proposalVotes(id)).to.deep.equal([0n, REP(400), 0n]);
        expect(await gov.optionVotes(id, 1)).to.equal(REP(350));
        await time.increase(Number(await gov.votingPeriod()));
        expect(await gov.state(id)).to.equal(SUCCEEDED);
        expect(await gov.winningOption(id)).to.deep.equal([true, 0n]);
    });

    it("passes early once one option holds the super quorum, and the source executes the winner", async function () {
        const { gov, source, call, id } = await setup();
        await gov.connect(a).castVote(id, 1);
        expect(await gov.winningOption(id)).to.deep.equal([false, 1n]);
        await gov.connect(c).castVote(id, 1);
        expect(await gov.state(id)).to.equal(SUCCEEDED); // 60% on option 1
        await gov.queue(...call, ethers.id("Elect"));
        await gov.execute(...call, ethers.id("Elect"));
        expect(await gov.state(id)).to.equal(EXECUTED);
        expect(await source.executedIndex()).to.equal(1n);
    });

    it("a tie goes to the lowest option hash, whichever came first", async function () {
        for (const lowFirst of [false, true]) {
            const { gov, id } = await setup({ amounts: [REP(300), REP(300), REP(300), REP(100)] });
            const hashes = [H("x"), H("y"), H("z")];
            const low = BigInt(hashes[0]) < BigInt(hashes[1]) ? 0 : 1;
            const high = 1 - low;
            await gov.connect(c).castVote(id, lowFirst ? low : high);
            await gov.connect(d).castVote(id, 2); // d's 100 on z, no effect on the tie
            await gov.connect(b).castVote(id, lowFirst ? high : low);
            expect(await gov.optionVotes(id, low)).to.equal(await gov.optionVotes(id, high));
            expect((await gov.winningOption(id))[1]).to.equal(BigInt(low));
        }
    });

    it("misses quorum when too few votes are cast", async function () {
        const { gov, id } = await setup({ quorumFraction: 50 });
        await gov.connect(c).castVote(id, 0);
        await time.increase(Number(await gov.votingPeriod()));
        expect(await gov.state(id)).to.equal(DEFEATED);
        expect((await gov.winningOption(id))[0]).to.equal(false);
    });
});
