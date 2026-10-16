const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { createJurisdiction, REP } = require("./helpers/jurisdiction");

// A proposal is decided as soon as its outcome can't change: early success once For holds more than
// half of all REP and meets the quorum, early defeat once Against holds half.
describe("Early decision", function () {
    let a, b, c;
    const ACTIVE = 1n, DEFEATED = 3n, SUCCEEDED = 4n, EXECUTED = 7n;

    before(async function () {
        [, a, b, c] = await ethers.getSigners();
    });

    // a 40%, b 35%, c 25%; quorumFraction in percent
    async function dao(quorumFraction = 4) {
        const j = await createJurisdiction(a, {
            members: [a.address, b.address, c.address], amounts: [REP(400), REP(350), REP(250)],
            votingPeriod: 60 * 24 * 7, quorumFraction,
        });
        for (const s of [a, b, c]) await j.rep.connect(s).delegate(s.address);
        const call = [[j.core.registry], [0n], [j.registry.interface.encodeFunctionData("editRegistry", ["k", "v"])]];
        const rc = await (await j.dao.connect(a).propose(...call, "Set k")).wait();
        const id = rc.logs.map((l) => { try { return j.dao.interface.parseLog(l); } catch { return null; } })
            .find((e) => e && e.name === "ProposalCreated").args.proposalId;
        await time.increase(1);
        return { ...j, id, call };
    }

    it("succeeds the moment For holds a majority of all REP, and executes without waiting out the vote", async function () {
        const { dao: gov, registry, id, call } = await dao();
        await gov.connect(a).castVote(id, 1);
        expect(await gov.state(id)).to.equal(ACTIVE); // 40% For: not decided
        await gov.connect(b).castVote(id, 1);
        expect(await gov.state(id)).to.equal(SUCCEEDED); // 75% For
        await gov.queue(...call, ethers.id("Set k"));
        await gov.execute(...call, ethers.id("Set k"));
        expect(await gov.state(id)).to.equal(EXECUTED);
        expect(await registry.getRegistryValue("k")).to.equal("v");
    });

    it("is defeated the moment Against holds half of all REP", async function () {
        const { dao: gov, id } = await dao();
        await gov.connect(b).castVote(id, 0);
        expect(await gov.state(id)).to.equal(ACTIVE); // 35% Against
        await gov.connect(c).castVote(id, 0);
        expect(await gov.state(id)).to.equal(DEFEATED); // 60% Against
        await expect(gov.connect(a).castVote(id, 1)).to.be.revertedWithCustomError(gov, "GovernorUnexpectedProposalState");
    });

    it("never passes early below the quorum, however lopsided", async function () {
        const { dao: gov, id } = await dao(90);
        await gov.connect(a).castVote(id, 1);
        await gov.connect(b).castVote(id, 1);
        expect(await gov.state(id)).to.equal(ACTIVE); // 75% For, quorum 90%
        await gov.connect(c).castVote(id, 1);
        expect(await gov.state(id)).to.equal(SUCCEEDED);
        expect(await gov.superQuorum(await gov.proposalSnapshot(id))).to.equal(REP(900));
    });

    it("otherwise resolves at the deadline as before", async function () {
        const { dao: gov, id } = await dao();
        await gov.connect(c).castVote(id, 1); // 25% For, above the 4% quorum
        expect(await gov.state(id)).to.equal(ACTIVE);
        await time.increase(Number(await gov.votingPeriod()));
        expect(await gov.state(id)).to.equal(SUCCEEDED);
    });
});
