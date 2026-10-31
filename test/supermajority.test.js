const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { createJurisdiction, prepare, govern, REP } = require("./helpers/jurisdiction");

// Constitutional proposals (docs/governance.md): a proposal is protected when any action edits the
// Autonet charter or epoch rules, calls the timelock, hands over the token, or changes the rules
// protected votes run under. It then needs supermajorityBps of For+Against (abstain excluded).
describe("Supermajority for constitutional proposals", function () {
    let a, b, c, outsider;
    const ACTIVE = 1n, DEFEATED = 3n, SUCCEEDED = 4n;
    const CHARTER = "jurisdiction.autonet.charter";
    const RULES = "jurisdiction.autonet.epoch_rules";

    before(async function () {
        [, a, b, c, outsider] = await ethers.getSigners();
    });

    async function dao(amounts = [REP(1000)], o = {}) {
        const members = [a, b, c].slice(0, amounts.length);
        const j = await createJurisdiction(a, {
            members: members.map((m) => m.address), amounts, votingPeriod: 60 * 24 * 7, ...o,
        });
        for (const m of members) await j.rep.connect(m).delegate(m.address);
        await time.increase(1);
        return j;
    }

    async function propose(gov, [targets, values, calldatas], description, from = a) {
        const rc = await (await gov.connect(from).propose([...targets], [...values], [...calldatas], description)).wait();
        const events = rc.logs.map((l) => { try { return gov.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
        const id = events.find((e) => e.name === "ProposalCreated").args.proposalId;
        const announced = events.find((e) => e.name === "ProposalSupermajority");
        await time.increase(1);
        return { id, announced: announced ? announced.args.bps : 0n };
    }

    /// The supermajority a single action makes its proposal need (0: unprotected), checked against the event
    async function bpsOf(j, target, data, description) {
        const { id, announced } = await propose(j.dao, [[target], [0n], [data]], description);
        const bps = await j.dao.proposalSupermajority(id);
        expect(announced).to.equal(bps);
        return bps;
    }

    describe("threshold at creation", function () {
        it("defaults to two thirds, takes a custom value, and refuses 50% or less and over 100%", async function () {
            expect(await (await dao()).dao.supermajorityBps()).to.equal(6667n);
            expect(await (await dao([REP(1000)], { supermajorityBps: 8000 })).dao.supermajorityBps()).to.equal(8000n);
            expect(await (await dao([REP(1000)], { supermajorityBps: 10000 })).dao.supermajorityBps()).to.equal(10000n);
            await expect(dao([REP(1000)], { supermajorityBps: 5000 })).to.be.reverted;
            await expect(dao([REP(1000)], { supermajorityBps: 10001 })).to.be.reverted;
        });
    });

    describe("what is protected", function () {
        let j;
        before(async function () {
            j = await dao();
        });

        it("registry edits of the charter or the epoch rules, through either edit function", async function () {
            const r = j.registry.interface;
            expect(await bpsOf(j, j.core.registry, r.encodeFunctionData("editRegistry", [CHARTER, "{}"]), "c1")).to.equal(6667n);
            expect(await bpsOf(j, j.core.registry, r.encodeFunctionData("editRegistry", [RULES, "3"]), "r1")).to.equal(6667n);
            expect(await bpsOf(j, j.core.registry, r.encodeFunctionData("batchEditRegistry", [["a", RULES], ["1", "3"]]), "b1")).to.equal(6667n);
            // Other keys, including look-alikes, are ordinary edits
            expect(await bpsOf(j, j.core.registry, r.encodeFunctionData("editRegistry", ["description", "x"]), "d1")).to.equal(0n);
            expect(await bpsOf(j, j.core.registry, r.encodeFunctionData("batchEditRegistry", [["jurisdiction.autonet.charter2", "Jurisdiction.autonet.charter"], ["", ""]]), "l1")).to.equal(0n);
        });

        it("any call to the timelock", async function () {
            const t = j.timelock.interface;
            expect(await bpsOf(j, j.core.timelock, t.encodeFunctionData("updateDelay", [60]), "t1")).to.equal(6667n);
            expect(await bpsOf(j, j.core.timelock, t.encodeFunctionData("grantRole", [await j.timelock.PROPOSER_ROLE(), outsider.address]), "t2")).to.equal(6667n);
            expect(await bpsOf(j, j.core.timelock, "0x", "t3")).to.equal(6667n); // a plain transfer
        });

        it("the governor's relay, updateTimelock, threshold, voting period and quorum setters", async function () {
            const g = j.dao.interface;
            const inner = j.registry.interface.encodeFunctionData("editRegistry", ["k", "v"]);
            expect(await bpsOf(j, j.core.governor, g.encodeFunctionData("relay", [j.core.registry, 0, inner]), "g1")).to.equal(6667n);
            expect(await bpsOf(j, j.core.governor, g.encodeFunctionData("updateTimelock", [outsider.address]), "g2")).to.equal(6667n);
            expect(await bpsOf(j, j.core.governor, g.encodeFunctionData("setSupermajority", [7500]), "g3")).to.equal(6667n);
            expect(await bpsOf(j, j.core.governor, g.encodeFunctionData("setVotingPeriod", [60]), "g4")).to.equal(6667n);
            expect(await bpsOf(j, j.core.governor, g.encodeFunctionData("updateQuorumNumerator", [1]), "g5")).to.equal(6667n);
            // Settings that don't change how a protected vote is decided stay ordinary
            expect(await bpsOf(j, j.core.governor, g.encodeFunctionData("setVotingDelay", [60]), "g6")).to.equal(0n);
            expect(await bpsOf(j, j.core.governor, g.encodeFunctionData("setProposalThreshold", [1]), "g7")).to.equal(0n);
        });

        it("handing over the token, but not ordinary token operations", async function () {
            const rep = j.rep.interface;
            expect(await bpsOf(j, j.core.token, rep.encodeFunctionData("setAdmin", [outsider.address]), "k1")).to.equal(6667n);
            expect(await bpsOf(j, j.core.token, rep.encodeFunctionData("mint", [outsider.address, 1]), "k2")).to.equal(0n);
        });

        it("one protected action protects the whole proposal", async function () {
            const r = j.registry.interface;
            const { id } = await propose(j.dao, [[j.core.registry, j.core.registry], [0n, 0n],
                [r.encodeFunctionData("editRegistry", ["k", "v"]), r.encodeFunctionData("editRegistry", [CHARTER, "{}"])]], "mixed");
            expect(await j.dao.proposalSupermajority(id)).to.equal(6667n);
        });

        it("a charter edit aimed at another registry is protected too (costless, and no address to fake)", async function () {
            const other = await createJurisdiction(a, { members: [a.address], amounts: [REP(1)] });
            expect(await bpsOf(j, other.core.registry, j.registry.interface.encodeFunctionData("editRegistry", [CHARTER, "x"]), "f1")).to.equal(6667n);
        });
    });

    describe("modules", function () {
        const CHARTER_JSON = '{"axes":[{"id":"correctness","thesis":"Works."},{"id":"simplicity","thesis":"Small."}]}';

        it("attaching Autonet with a charter, and detaching it, are protected; attaching the Economy is not", async function () {
            const j = await dao();
            const s = j.s;
            const autonet = await prepare(s, a, j.core, "autonet", { substrate: { challengeWindow: 3600, charter: CHARTER_JSON, epochRules: "2", genesisRoot: ethers.ZeroHash } });
            const attach = await s.processor.installCalls(await autonet.setup.getAddress(), autonet.id);
            const { id: attachId } = await propose(j.dao, attach, "Attach Autonet");
            expect(await j.dao.proposalSupermajority(attachId)).to.equal(6667n);

            const economy = await prepare(s, a, j.core, "economy");
            const { id: ecoId } = await propose(j.dao, await s.processor.installCalls(await economy.setup.getAddress(), economy.id), "Attach Economy");
            expect(await j.dao.proposalSupermajority(ecoId)).to.equal(0n);
        });

        it("detaching an Autonet attached at creation is protected (it clears the charter)", async function () {
            const j = await createJurisdiction(a, {
                members: [a.address], amounts: [REP(1000)], votingPeriod: 60,
                modules: [["autonet", { substrate: { challengeWindow: 3600, charter: CHARTER_JSON, epochRules: "2", genesisRoot: ethers.ZeroHash } }]],
            });
            await j.rep.connect(a).delegate(a.address);
            await time.increase(1);
            const detach = await j.s.processor.uninstallCalls(await j.installs.autonet.setup.getAddress(), j.installs.autonet.id);
            const { id } = await propose(j.dao, detach, "Detach Autonet");
            expect(await j.dao.proposalSupermajority(id)).to.equal(6667n);
        });
    });

    describe("counting", function () {
        const edit = (j, value) => [[j.core.registry], [0n], [j.registry.interface.encodeFunctionData("editRegistry", [CHARTER, value])]];

        it("passes at exactly the threshold of For+Against, with abstain left out", async function () {
            // a For 6,667, b Against 3,333, c abstains 90,000: 6,667 of 10,000 cast For or Against
            const j = await dao([REP(6667), REP(3333), REP(90000)]);
            const { id } = await propose(j.dao, edit(j, "x"), "at");
            await j.dao.connect(a).castVote(id, 1);
            await j.dao.connect(b).castVote(id, 0);
            await j.dao.connect(c).castVote(id, 2);
            expect(await j.dao.state(id)).to.equal(ACTIVE);
            await time.increase(Number(await j.dao.votingPeriod()) + 1);
            expect(await j.dao.state(id)).to.equal(SUCCEEDED);
        });

        it("fails one basis point below it, though a simple majority would pass", async function () {
            const j = await dao([REP(6666), REP(3334), REP(90000)]);
            const { id } = await propose(j.dao, edit(j, "x"), "below");
            await j.dao.connect(a).castVote(id, 1);
            await j.dao.connect(b).castVote(id, 0);
            await j.dao.connect(c).castVote(id, 2);
            await time.increase(Number(await j.dao.votingPeriod()) + 1);
            expect(await j.dao.state(id)).to.equal(DEFEATED);
        });

        it("an ordinary proposal with the same votes still passes by simple majority", async function () {
            const j = await dao([REP(6666), REP(3334), REP(90000)]);
            const { id } = await propose(j.dao, [[j.core.registry], [0n], [j.registry.interface.encodeFunctionData("editRegistry", ["k", "v"])]], "plain");
            expect(await j.dao.proposalSupermajority(id)).to.equal(0n);
            await j.dao.connect(a).castVote(id, 1);
            await j.dao.connect(b).castVote(id, 0);
            await time.increase(Number(await j.dao.votingPeriod()) + 1);
            expect(await j.dao.state(id)).to.equal(SUCCEEDED);
        });

        it("no early pass on a simple majority of all REP; an early pass once For holds the supermajority of all REP", async function () {
            let j = await dao([REP(6000), REP(4000)]);
            let { id } = await propose(j.dao, edit(j, "x"), "early1");
            await j.dao.connect(a).castVote(id, 1); // 60% of all REP: an ordinary proposal would pass now
            expect(await j.dao.state(id)).to.equal(ACTIVE);
            await time.increase(Number(await j.dao.votingPeriod()) + 1);
            expect(await j.dao.state(id)).to.equal(SUCCEEDED); // b never voted: 100% of For+Against

            j = await dao([REP(7000), REP(3000)]);
            ({ id } = await propose(j.dao, edit(j, "x"), "early2"));
            await j.dao.connect(a).castVote(id, 1);
            expect(await j.dao.state(id)).to.equal(SUCCEEDED);
            const call = edit(j, "x");
            await j.dao.queue(...call, ethers.id("early2"));
            await j.dao.execute(...call, ethers.id("early2"));
            expect(await j.registry.getRegistryValue(CHARTER)).to.equal("x");
        });

        it("an early defeat once Against makes the supermajority unreachable, short of half of all REP", async function () {
            const j = await dao([REP(6000), REP(4000)]);
            const { id } = await propose(j.dao, edit(j, "x"), "defeat");
            await j.dao.connect(b).castVote(id, 0); // 40% Against: For can reach at most 60%
            expect(await j.dao.state(id)).to.equal(DEFEATED);
        });

        it("a unanimity threshold is defeated by a single Against vote", async function () {
            const j = await dao([REP(9999), REP(1)], { supermajorityBps: 10000 });
            const { id } = await propose(j.dao, edit(j, "x"), "unanimity");
            await j.dao.connect(a).castVote(id, 1);
            await j.dao.connect(b).castVote(id, 0);
            expect(await j.dao.state(id)).to.equal(DEFEATED);
        });
    });

    describe("the threshold setter", function () {
        it("changes only by a (protected) proposal, within range, without touching proposals already made", async function () {
            const j = await dao();
            await expect(j.dao.connect(a).setSupermajority(7500)).to.be.revertedWithCustomError(j.dao, "GovernorOnlyExecutor");
            const pending = await propose(j.dao, [[j.core.registry], [0n], [j.registry.interface.encodeFunctionData("editRegistry", [CHARTER, "y"])]], "pending");

            const set = [[j.core.governor], [0n], [j.dao.interface.encodeFunctionData("setSupermajority", [7500])]];
            await govern(j.dao, a, set, "Raise the bar");
            expect(await j.dao.supermajorityBps()).to.equal(7500n);
            const [setEvent] = (await j.dao.queryFilter(j.dao.filters.SupermajoritySet())).slice(-1);
            expect([setEvent.args.oldBps, setEvent.args.newBps]).to.deep.equal([6667n, 7500n]);
            expect(await j.dao.proposalSupermajority(pending.id)).to.equal(6667n);
            const later = await propose(j.dao, [[j.core.registry], [0n], [j.registry.interface.encodeFunctionData("editRegistry", [CHARTER, "z"])]], "later");
            expect(await j.dao.proposalSupermajority(later.id)).to.equal(7500n);

            const bad = [[j.core.governor], [0n], [j.dao.interface.encodeFunctionData("setSupermajority", [5000])]];
            await expect(govern(j.dao, a, bad, "Lower it to a majority")).to.be.reverted;
            expect(await j.dao.supermajorityBps()).to.equal(7500n);
        });
    });

    describe("the Registry's owner", function () {
        it("changes exactly once, the factory's handover to the timelock", async function () {
            const j = await dao();
            expect(await j.registry.owner()).to.equal(j.core.timelock);
            expect(await j.registry.ownershipHandedOver()).to.equal(true);
            const move = [[j.core.registry], [0n], [j.registry.interface.encodeFunctionData("transferOwnership", [outsider.address])]];
            await expect(govern(j.dao, a, move, "Move the registry")).to.be.reverted;
            expect(await j.registry.owner()).to.equal(j.core.timelock);

            const r = await (await ethers.getContractFactory("Registry")).deploy(a.address, ethers.ZeroAddress);
            await r.connect(a).transferOwnership(b.address);
            await expect(r.connect(b).transferOwnership(c.address)).to.be.revertedWith("Registry: ownership was already handed over");
        });
    });

    describe("bypasses", function () {
        it("an option source can't turn a protected proposal into a plurality election", async function () {
            const j = await dao();
            const approve = [[j.core.governor], [0n], [j.dao.interface.encodeFunctionData("setOptionSource", [j.core.timelock, true])]];
            await govern(j.dao, a, approve, "Approve the timelock as an option source");
            expect(await j.dao.optionSources(j.core.timelock)).to.equal(true);
            const { id } = await propose(j.dao, [[j.core.timelock], [0n], [j.timelock.interface.encodeFunctionData("updateDelay", [0])]], "Through a source");
            expect(await j.dao.optionSourceOf(id)).to.equal(ethers.ZeroAddress);
            expect(await j.dao.proposalSupermajority(id)).to.equal(6667n);
        });

        it("the charter can't be written by relaying through the governor on a simple majority", async function () {
            const j = await dao([REP(6000), REP(4000)]);
            const inner = j.registry.interface.encodeFunctionData("editRegistry", [CHARTER, "relayed"]);
            const call = [[j.core.governor], [0n], [j.dao.interface.encodeFunctionData("relay", [j.core.registry, 0, inner])]];
            const { id } = await propose(j.dao, call, "Relay");
            await j.dao.connect(a).castVote(id, 1);
            await j.dao.connect(b).castVote(id, 0);
            await time.increase(Number(await j.dao.votingPeriod()) + 1);
            expect(await j.dao.state(id)).to.equal(DEFEATED); // 60% For: a majority, not a supermajority
        });

        it("nothing but the timelock can edit the Registry or schedule on the timelock", async function () {
            const j = await dao();
            await expect(j.registry.connect(a).editRegistry(CHARTER, "x")).to.be.revertedWith("Only the DAO can edit registry");
            expect(await j.registry.wrapper()).to.equal(ethers.ZeroAddress);
            const proposer = await j.timelock.PROPOSER_ROLE();
            expect(await j.timelock.hasRole(proposer, j.core.governor)).to.equal(true);
            expect(await j.timelock.hasRole(await j.timelock.DEFAULT_ADMIN_ROLE(), await j.s.jurisdictionFactory.getAddress())).to.equal(false);
            await expect(j.timelock.connect(a).schedule(j.core.registry, 0, "0x", ethers.ZeroHash, ethers.ZeroHash, 0))
                .to.be.revertedWithCustomError(j.timelock, "AccessControlUnauthorizedAccount");
        });
    });
});
