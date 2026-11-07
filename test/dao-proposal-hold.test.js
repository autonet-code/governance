const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { suite, prepare, createJurisdiction, REP } = require("./helpers/jurisdiction");
const { passCoolingOff } = require("./helpers/coolingOff");

// A project waits for its DAO: a veto or overrule proposal registered inside a window (cooling-off,
// the arbitration deadline, the appeal window) holds signing, the timeout close or finalization until
// the proposal could last land. Cooling-off has a fixed minimum.
describe("DAO proposal holds", function () {
    let member, contractor, arbiter, outsider;

    before(async function () {
        [, member, contractor, arbiter, outsider] = await ethers.getSigners();
    });

    async function setup() {
        const j = await createJurisdiction(member, { members: [member.address], amounts: [REP(1000)], modules: ["economy"] });
        await j.rep.connect(member).delegate(member.address);
        const rc = await (await j.economy.connect(member).createProject(
            "p", contractor.address, arbiter.address, "t", "r", "d")).wait();
        const project = await ethers.getContractAt("NativeProject",
            rc.logs.find((l) => l.eventName === "NewProject").args.contractAddress);
        await project.connect(member).sendFunds({ value: ethers.parseEther("1") });
        const stake = (ethers.parseEther("1") * (await j.economy.arbitrationFeeBps())) / 10000n / 2n;
        return { ...j, project, stake };
    }

    async function propose(dao, call, description) {
        const p = [[call.target], [0n], [call.data], description];
        const rc = await (await dao.connect(member).propose(...p)).wait();
        const id = rc.logs.map((l) => { try { return dao.interface.parseLog(l); } catch { return null; } })
            .find((e) => e && e.name === "ProposalCreated").args.proposalId;
        return { id, args: [p[0], p[1], p[2], ethers.id(description)] };
    }

    const veto = async (project) => ({ target: await project.getAddress(), data: project.interface.encodeFunctionData("daoVeto") });
    const overrule = async (project, pct) => ({
        target: await project.getAddress(), data: project.interface.encodeFunctionData("daoOverrule", [pct, "dao"]),
    });

    // When a proposal not yet queued could last land: its deadline, a day to queue, the timelock delay, a day to execute
    async function lastLanding(dao, timelock, id) {
        return (await dao.proposalDeadline(id)) + 2n * 86400n + (await timelock.getMinDelay());
    }

    it("a veto registered during cooling-off holds signing until it could last land, even if defeated", async function () {
        const { dao, timelock, project, stake } = await setup();
        const p = await propose(dao, await veto(project), "Veto it");
        const until = await lastLanding(dao, timelock, p.id);
        await expect(project.connect(outsider).registerDaoProposal(...p.args))
            .to.emit(project, "DaoProposalRegistered").withArgs(p.id, false, until);
        expect(await project.heldUntil()).to.equal(until);

        await time.increase(1);
        await dao.connect(member).castVote(p.id, 0);
        await time.increase(Number(await dao.votingPeriod()) + 1);
        expect(await dao.state(p.id)).to.equal(3); // Defeated, and still held
        await time.increaseTo(until - 1n);
        await expect(project.connect(contractor).signContract({ value: stake }))
            .to.be.revertedWith("A DAO proposal about this project is pending");
        expect(await project.heldByDao()).to.equal(true); // the last second held
        await project.connect(contractor).signContract({ value: stake });
        expect(await project.stage()).to.equal(2); // Ongoing
    });

    it("an overrule registered in the appeal window holds finalization and lands after the window", async function () {
        const { dao, timelock, project, stake } = await setup();
        await passCoolingOff(project);
        await project.connect(contractor).signContract({ value: stake });
        await project.connect(member).voteToDispute();
        await project.connect(arbiter).arbitrate(30, "ruling");

        const p = await propose(dao, await overrule(project, 80), "Overrule");
        await expect(project.connect(outsider).registerDaoProposal(...p.args))
            .to.emit(project, "DaoProposalRegistered").withArgs(p.id, true, await lastLanding(dao, timelock, p.id));
        await time.increase(1);
        await dao.connect(member).castVote(p.id, 1);
        await time.increaseTo((await project.appealEnds()) + 1n);
        await expect(project.finalizeArbitration()).to.be.revertedWith("A DAO proposal about this project is pending");

        await time.increase(Number(await dao.votingPeriod()) + 1);
        await dao.queue(...p.args);
        await time.increase(Number(await timelock.getMinDelay()) + 1);
        await dao.execute(...p.args);
        expect(await project.stage()).to.equal(6); // Closed
        expect(await project.disputeResolution()).to.equal(80n);
    });

    it("a proposal registered before the arbitration deadline holds the timeout close", async function () {
        const { dao, economy, project, stake } = await setup();
        await passCoolingOff(project);
        await project.connect(contractor).signContract({ value: stake });
        await project.connect(member).voteToDispute();
        const deadline = await project.arbitrationDeadline();
        expect(await economy.arbitrationTimeout()).to.equal(30n * 86400n);
        expect(deadline).to.equal((await project.disputeStarted()) + (await economy.arbitrationTimeout()));

        await time.increaseTo(deadline - 10n);
        const p = await propose(dao, await overrule(project, 80), "The arbiter is silent");
        await project.registerDaoProposal(...p.args);
        await time.increaseTo(deadline + 1n);
        await expect(project.arbitrationPeriodExpired()).to.be.revertedWith("A DAO proposal about this project is pending");
        await time.increaseTo(await project.heldUntil());
        await project.arbitrationPeriodExpired();
        expect(await project.stage()).to.equal(6); // Closed
    });

    it("refuses registrations outside a window, about other projects or unknown; repeats change nothing", async function () {
        const { dao, project, stake } = await setup();
        const other = await propose(dao, { target: outsider.address, data: project.interface.encodeFunctionData("daoVeto") }, "Elsewhere");
        await expect(project.registerDaoProposal(...other.args)).to.be.revertedWith("Proposal doesn't veto or overrule this project");
        const unknown = [[await project.getAddress()], [0n], [(await veto(project)).data], ethers.id("never proposed")];
        await expect(project.registerDaoProposal(...unknown)).to.be.revertedWithCustomError(dao, "GovernorNonexistentProposal");
        const p = await propose(dao, await veto(project), "Veto once");
        await project.registerDaoProposal(...p.args);
        const held = await project.heldUntil();
        await project.registerDaoProposal(...p.args);
        expect(await project.heldUntil()).to.equal(held);

        // After cooling-off a veto still lands, but doesn't hold signing
        await passCoolingOff(project);
        const lateVeto = await propose(dao, await veto(project), "Veto after cooling-off");
        await expect(project.registerDaoProposal(...lateVeto.args)).to.be.revertedWith("The window to hold this project has closed");
        await time.increaseTo(held);
        await project.connect(contractor).signContract({ value: stake });
        await expect(project.registerDaoProposal(...lateVeto.args)).to.be.revertedWith("Nothing to hold in this stage");

        await project.connect(member).voteToDispute();
        await project.connect(arbiter).arbitrate(30, "ruling");
        await time.increaseTo((await project.appealEnds()) + 1n);
        const late = await propose(dao, await overrule(project, 80), "Too late");
        await expect(project.registerDaoProposal(...late.args)).to.be.revertedWith("The window to hold this project has closed");
        await project.finalizeArbitration();
        expect(await project.disputeResolution()).to.equal(30n);
    });

    it("the arbitration timeout is a DAO setting", async function () {
        const { economy } = await setup();
        await expect(economy.connect(outsider).setArbitrationTimeout(86400)).to.be.revertedWith("Protected");
    });

    it("keeps cooling-off at or above the minimum the setup fixed", async function () {
        const j = await setup();
        expect(await j.economy.minCoolingOffPeriod()).to.equal(60n); // a local chain's minimum
        await expect(j.economy.connect(member).setMinCoolingOffPeriod(0)).to.be.revertedWith("Protected");

        const s = await suite();
        await expect(prepare(s, member, j.core, "economy", { params: { arbitrationFeeBps: 250, platformFeeBps: 250,
            authorFeeBps: 500, coolingOffPeriod: 30, backersQuorumBps: 5100, projectThreshold: 0, appealPeriod: 120 } }))
            .to.be.revertedWith("Cooling-off below the minimum");

        const econ = await (await ethers.getContractFactory("Economy")).deploy(500);
        expect(await econ.minCoolingOffPeriod()).to.equal(86400n);
        await expect(econ.setCoolingOffPeriod(3600)).to.be.revertedWith("Cooling-off below the minimum");
    });
});
