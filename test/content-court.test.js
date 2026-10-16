const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// ContentCourt against a real RepToken. The deployer is the RepToken's admin (to grant the court slasher
// rights); a plain signer stands in for the timelock and another for the treasury; a standalone Economy
// supplies the appeal window (7 days).
//
// REP: j1 300, j2 200, j3 100, member 400 (total 1000). Threshold 55% = 550, so all three jurors fit in
// a case and the third commit closes it. `member` labels off-chain through an extension key.
describe("ContentCourt", function () {
    let deployer, timelock, treasury, j1, j2, j3, member, outsider;
    let rep, economy, court, key, domain;

    const REP = (n) => ethers.parseEther(String(n));
    const DAY = 86400;
    const DEPOSIT = ethers.parseEther("1");
    const PARAMS = {
        caseDeposit: DEPOSIT, thresholdBps: 5500, reviewWindow: 3 * DAY, revealWindow: DAY,
        degradeBps: 1000, assertionSlashBps: 2000,
    };
    const SUBJECT = ethers.id("yt:dQw4w9WgXcQ");
    const SPAM = ethers.id("spam");
    const EVIDENCE = ethers.id("evidence");
    const FAR = 2n ** 47n;
    const salts = new Map();

    const KEY_GRANT = { KeyGrant: [{ name: "holder", type: "address" }, { name: "validUntil", type: "uint48" }] };
    const LABEL = { Label: [
        { name: "subject", type: "bytes32" }, { name: "label", type: "bytes32" },
        { name: "value", type: "uint16" }, { name: "issuedAt", type: "uint48" },
    ] };

    async function bindKey(holder, wallet, validUntil = FAR) {
        const sig = await wallet.signTypedData(domain, KEY_GRANT, { holder: holder.address, validUntil });
        return court.connect(holder).setLabelKey(wallet.address, validUntil, sig);
    }

    async function signLabel(wallet, value, issuedAt) {
        const l = { subject: SUBJECT, label: SPAM, value, issuedAt: issuedAt ?? await time.latest() };
        return { l, sig: await wallet.signTypedData(domain, LABEL, l) };
    }

    async function open(applies = true, signer = outsider) {
        await court.connect(signer).openCase(SUBJECT, SPAM, applies, { value: DEPOSIT });
        return court.caseCount();
    }

    async function commit(id, signer, applies) {
        const salt = ethers.hexlify(ethers.randomBytes(32));
        salts.set(`${id}:${signer.address}`, { applies, salt });
        await court.connect(signer).commitVote(id, await court.commitmentOf(id, signer.address, applies, EVIDENCE, salt));
    }

    async function reveal(id, signer) {
        const { applies, salt } = salts.get(`${id}:${signer.address}`);
        await court.connect(signer).revealVote(id, applies, EVIDENCE, salt);
    }

    // Commit all given, reveal all but the silent ones, settle
    async function verdict(id, sides, silent = []) {
        for (const [s, applies] of sides) await commit(id, s, applies);
        for (const [s] of sides) if (!silent.includes(s)) await reveal(id, s);
        await time.increase(PARAMS.revealWindow + 1);
        await court.settle(id);
    }

    async function finalizeAfterAppeal(id) {
        await time.increase(7 * DAY + 1);
        await court.finalize(id, 10);
    }

    beforeEach(async function () {
        [deployer, timelock, treasury, j1, j2, j3, member, outsider] = await ethers.getSigners();
        rep = await (await ethers.getContractFactory("RepToken")).deploy("Rep", "REP", deployer.address, timelock.address,
            [j1.address, j2.address, j3.address, member.address], [REP(300), REP(200), REP(100), REP(400)], false);
        economy = await (await ethers.getContractFactory("Economy")).deploy(250);
        court = await (await ethers.getContractFactory("ContentCourt")).deploy(
            await rep.getAddress(), await economy.getAddress(), timelock.address, treasury.address, PARAMS);
        await rep.setSlasher(await court.getAddress(), true);
        await court.connect(timelock).setLabel("spam", true);

        domain = { name: "ContentCourt", version: "1", chainId: (await ethers.provider.getNetwork()).chainId,
            verifyingContract: await court.getAddress() };
        key = ethers.Wallet.createRandom();
        await bindKey(member, key);
    });

    describe("label keys", function () {
        it("binds a key only with its consent, to one holder forever", async function () {
            const k = ethers.Wallet.createRandom();
            const forged = await ethers.Wallet.createRandom().signTypedData(domain, KEY_GRANT, { holder: outsider.address, validUntil: FAR });
            await expect(court.connect(outsider).setLabelKey(k.address, FAR, forged)).to.be.revertedWithCustomError(court, "BadSignature");
            // A grant signed for someone else doesn't work for the caller
            const forMember = await key.signTypedData(domain, KEY_GRANT, { holder: member.address, validUntil: FAR });
            await expect(court.connect(outsider).setLabelKey(key.address, FAR, forMember)).to.be.revertedWithCustomError(court, "BadSignature");
            await expect(bindKey(outsider, key)).to.be.revertedWithCustomError(court, "KeyTaken");
            await bindKey(member, key, FAR - 1n); // the holder can re-grant
        });

        it("holderOf covers the bound window, and revocation is permanent", async function () {
            const bound = (await court.labelKeys(key.address)).validFrom;
            expect(await court.holderOf(key.address, bound - 1n)).to.equal(ethers.ZeroAddress);
            expect(await court.holderOf(key.address, bound)).to.equal(member.address);
            await expect(court.connect(outsider).revokeLabelKey(key.address)).to.be.revertedWithCustomError(court, "NotHolder");
            await court.connect(member).revokeLabelKey(key.address);
            const t = BigInt(await time.latest());
            expect(await court.holderOf(key.address, t)).to.equal(member.address); // labels before now stay attributable
            expect(await court.holderOf(key.address, t + 1n)).to.equal(ethers.ZeroAddress);
            await expect(bindKey(member, key)).to.be.revertedWithCustomError(court, "KeyRevoked");
        });
    });

    describe("opening", function () {
        it("needs a taxonomy label, the exact deposit, and no live case on the pair", async function () {
            await expect(court.openCase(SUBJECT, ethers.id("nope"), true, { value: DEPOSIT })).to.be.revertedWithCustomError(court, "UnknownLabel");
            await expect(court.openCase(SUBJECT, SPAM, true, { value: 1 })).to.be.revertedWithCustomError(court, "BadDeposit");
            await open();
            await expect(open()).to.be.revertedWithCustomError(court, "CaseActive");
        });

        it("a stale case below threshold lapses into the treasury when a new one opens", async function () {
            const id = await open();
            await commit(id, j1, true);
            await time.increase(PARAMS.reviewWindow + 1);
            await expect(court.connect(outsider).openCase(SUBJECT, SPAM, false, { value: DEPOSIT })).to.changeEtherBalance(treasury, DEPOSIT);
            expect((await court.getCase(id)).verdict).to.equal(3n); // Void
            expect(await court.latestCase(SUBJECT, SPAM)).to.equal(id + 1n);
        });

        it("lapse closes a case nobody settled, with no slashing", async function () {
            const id = await open();
            await commit(id, j1, true);
            await expect(court.lapse(id)).to.be.revertedWithCustomError(court, "TooEarly");
            await time.increase(PARAMS.reviewWindow + 1);
            await expect(court.lapse(id)).to.changeEtherBalance(treasury, DEPOSIT);
            expect(await rep.balanceOf(j1.address)).to.equal(REP(300));
        });
    });

    describe("verdicts", function () {
        it("losing and silent jurors and losing asserters pay the winners; standing is set; no REP is created", async function () {
            const { l, sig } = await signLabel(key, 0); // member said: not spam
            const id = await open(true);
            await court.connect(outsider).submitAssertion(id, l, sig);
            await verdict(id, [[j1, true], [j2, false], [j3, true]], [j3]);
            expect((await court.getCase(id)).verdict).to.equal(1n); // Applies, 300 vs 200
            await expect(court.finalize(id, 10)).to.be.revertedWithCustomError(court, "TooEarly");
            await finalizeAfterAppeal(id);

            // j2 loses 10% of 200, silent j3 10% of 100, member 20% of 400
            expect(await rep.balanceOf(j2.address)).to.equal(REP(180));
            expect(await rep.balanceOf(j3.address)).to.equal(REP(90));
            expect(await rep.balanceOf(member.address)).to.equal(REP(320));
            await court.connect(j1).claim(id);
            expect(await rep.balanceOf(j1.address)).to.equal(REP(410));
            expect(await rep.totalSupply()).to.equal(REP(1000));
            await expect(court.connect(j1).claim(id)).to.be.revertedWithCustomError(court, "NothingToClaim");
            await expect(court.connect(j2).claim(id)).to.be.revertedWithCustomError(court, "NothingToClaim");

            expect(await court.standing(SUBJECT, SPAM)).to.equal(1n);
            await expect(court.connect(outsider).withdrawRefund()).to.changeEtherBalance(outsider, DEPOSIT);
        });

        it("an opener who loses forfeits the deposit to the treasury", async function () {
            const id = await open(false);
            await verdict(id, [[j1, true], [j2, true], [j3, false]]);
            await time.increase(7 * DAY + 1);
            await expect(court.finalize(id, 10)).to.changeEtherBalance(treasury, DEPOSIT);
            expect(await court.refunds(outsider.address)).to.equal(0);
        });

        it("a tie is void: nobody revealed is slashed, standing is untouched, the deposit returns", async function () {
            const id = await open();
            await verdict(id, [[j1, true], [j2, false], [j3, false]]); // 300 vs 300
            expect((await court.getCase(id)).verdict).to.equal(3n);
            await finalizeAfterAppeal(id);
            expect(await rep.balanceOf(j2.address)).to.equal(REP(200));
            expect(await court.standing(SUBJECT, SPAM)).to.equal(0n);
            expect(await court.refunds(outsider.address)).to.equal(DEPOSIT);
        });

        it("the DAO can overrule within the appeal window, and finalization follows at once", async function () {
            const id = await open(true);
            await verdict(id, [[j1, true], [j2, false], [j3, false]], [j3]); // 300 vs 200: Applies
            await expect(court.connect(outsider).daoOverrule(id, false)).to.be.revertedWithCustomError(court, "NotTimelock");
            await court.connect(timelock).daoOverrule(id, false);
            await expect(court.finalize(id, 10)).to.changeEtherBalance(treasury, DEPOSIT);
            expect(await court.standing(SUBJECT, SPAM)).to.equal(2n);
            expect(await rep.balanceOf(j1.address)).to.equal(REP(270));
            await court.connect(j2).claim(id);
            expect(await rep.balanceOf(j2.address)).to.equal(REP(240)); // 30 from j1 + 10 from silent j3
        });

        it("finalize works in batches", async function () {
            const { l, sig } = await signLabel(key, 0);
            const id = await open(true);
            await court.submitAssertion(id, l, sig);
            await verdict(id, [[j1, true], [j2, false], [j3, true]]);
            await time.increase(7 * DAY + 1);
            for (let i = 0; i < 3; i++) await court.finalize(id, 1);
            expect((await court.getCase(id)).stage).to.equal(4n); // still Finalizing
            await court.finalize(id, 1);
            expect((await court.getCase(id)).stage).to.equal(5n);
            expect(await rep.balanceOf(member.address)).to.equal(REP(320));
        });
    });

    describe("assertions", function () {
        it("only labels signed by a key bound at issuedAt, on the case's pair, count", async function () {
            const id = await open();
            const stranger = ethers.Wallet.createRandom();
            let s = await signLabel(stranger, 10000);
            await expect(court.submitAssertion(id, s.l, s.sig)).to.be.revertedWithCustomError(court, "BadSignature");
            const before = (await court.labelKeys(key.address)).validFrom - 1n;
            s = await signLabel(key, 10000, before);
            await expect(court.submitAssertion(id, s.l, s.sig)).to.be.revertedWithCustomError(court, "BadSignature");
            const wrong = { subject: ethers.id("yt:other"), label: SPAM, value: 10000, issuedAt: await time.latest() };
            await expect(court.submitAssertion(id, wrong, await key.signTypedData(domain, LABEL, wrong)))
                .to.be.revertedWithCustomError(court, "BadAssertion");
            s = await signLabel(key, 10000);
            await court.submitAssertion(id, s.l, s.sig);
            const again = await signLabel(key, 9000);
            await expect(court.submitAssertion(id, again.l, again.sig)).to.be.revertedWithCustomError(court, "BadAssertion");
        });

        it("a later label can't cancel a losing one; signing both sides is slashed once", async function () {
            const no = await signLabel(key, 0);
            const id = await open(true);
            await court.submitAssertion(id, no.l, no.sig);
            const yes = await signLabel(key, 10000); // member tries to switch sides mid-case
            await court.submitAssertion(id, yes.l, yes.sig);
            await verdict(id, [[j1, true], [j2, false], [j3, true]]);
            await finalizeAfterAppeal(id);
            expect(await rep.balanceOf(member.address)).to.equal(REP(320));
        });

        it("closes once the case finalizes", async function () {
            const id = await open();
            await verdict(id, [[j1, true], [j2, false], [j3, true]]);
            await finalizeAfterAppeal(id);
            const s = await signLabel(key, 0);
            await expect(court.submitAssertion(id, s.l, s.sig)).to.be.revertedWithCustomError(court, "WrongStage");
        });
    });

    describe("governance", function () {
        it("only the timelock sets labels and params, within bounds", async function () {
            await expect(court.connect(outsider).setLabel("misleading", true)).to.be.revertedWithCustomError(court, "NotTimelock");
            await expect(court.connect(outsider).setParams(PARAMS)).to.be.revertedWithCustomError(court, "NotTimelock");
            await expect(court.connect(timelock).setParams({ ...PARAMS, thresholdBps: 0 })).to.be.revertedWithCustomError(court, "BadParams");
            await court.connect(timelock).setParams({ ...PARAMS, caseDeposit: 5 });
            expect(await court.caseDeposit()).to.equal(5n);
        });
    });
});
