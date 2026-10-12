const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { autonet } = require("./helpers/autonet");

// ToolBond against the real Substrate. The deployer is the Substrate's vault minter so it can fund
// accounts with ATN; a plain signer stands in for the timelock; a standalone Economy supplies the
// appeal window (7 days: no governor, so the proposal-lifecycle floor is just the 2-day buffer).
describe("ToolBond", function () {
    let deployer, timelock, arbiter, author, accuser, outsider;
    let substrate, economy, bond;

    const ATN = (n) => ethers.parseUnits(String(n), 6);
    const DIGEST = ethers.id("tool manifest v1");
    const MIN_STAKE = ATN(100);
    const COUNTER = ATN(10);
    const ARBITER_WINDOW = 3 * 86400;
    const APPEAL = 7 * 86400;
    const UNBOND_DELAY = 14 * 86400;

    async function fund(signer, amount) {
        await substrate.mintFromVault(signer.address, amount);
        await substrate.connect(signer).approve(await bond.getAddress(), ethers.MaxUint256);
    }

    async function accused() {
        await bond.connect(author).bond(DIGEST, MIN_STAKE);
        await bond.connect(accuser).accuse(DIGEST, "ipfs://trace");
    }

    beforeEach(async function () {
        [deployer, timelock, arbiter, author, accuser, outsider] = await ethers.getSigners();
        substrate = await autonet("Substrate", deployer).deploy(ethers.ZeroAddress, deployer.address, ethers.ZeroAddress, ethers.ZeroAddress, 5000, [deployer.address], 1);
        economy = await (await ethers.getContractFactory("Economy")).deploy(250);
        bond = await (await ethers.getContractFactory("ToolBond")).deploy(
            await substrate.getAddress(), await economy.getAddress(), timelock.address,
            arbiter.address, MIN_STAKE, COUNTER, ARBITER_WINDOW, UNBOND_DELAY);

        await substrate.connect(author).registerAgent(ethers.id("author"), "0x01");
        await substrate.connect(accuser).registerAgent(ethers.id("accuser"), "0x02");
        await substrate.connect(author).registerTool(DIGEST);
        await fund(author, ATN(1000));
        await fund(accuser, ATN(1000));
        await fund(outsider, ATN(1000));
    });

    describe("bonding", function () {
        it("only the tool's Substrate author can bond, and the tool counts once the stake reaches the minimum", async function () {
            await expect(bond.connect(outsider).bond(DIGEST, MIN_STAKE)).to.be.revertedWithCustomError(bond, "NotAuthor");
            await bond.connect(author).bond(DIGEST, ATN(60));
            expect(await bond.isBonded(DIGEST)).to.equal(false);
            await bond.connect(author).bond(DIGEST, ATN(40));
            expect(await bond.isBonded(DIGEST)).to.equal(true);
            expect(await substrate.balanceOf(await bond.getAddress())).to.equal(MIN_STAKE);
        });

        it("stops counting at the unbond request but keeps the stake slashable until the delay passes", async function () {
            await bond.connect(author).bond(DIGEST, MIN_STAKE);
            await bond.connect(author).requestUnbond(DIGEST);
            expect(await bond.isBonded(DIGEST)).to.equal(false);
            await expect(bond.connect(author).withdraw(DIGEST)).to.be.revertedWithCustomError(bond, "TooEarly");

            // Still accusable while unbonding, and the dispute blocks the withdrawal
            await bond.connect(accuser).accuse(DIGEST, "ipfs://trace");
            await time.increase(UNBOND_DELAY + 1);
            await expect(bond.connect(author).withdraw(DIGEST)).to.be.revertedWithCustomError(bond, "DisputeOpen");

            await bond.connect(arbiter).rule(DIGEST, false);
            await time.increase(APPEAL + 1);
            await bond.finalize(DIGEST);
            await expect(bond.connect(author).withdraw(DIGEST))
                .to.changeTokenBalance(substrate, author, MIN_STAKE);
        });

        it("a top-up cancels a pending unbond", async function () {
            await bond.connect(author).bond(DIGEST, MIN_STAKE);
            await bond.connect(author).requestUnbond(DIGEST);
            await bond.connect(author).bond(DIGEST, ATN(1));
            expect(await bond.isBonded(DIGEST)).to.equal(true);
        });
    });

    describe("disputes", function () {
        it("only registered agents can accuse, with a counter-bond, one dispute at a time", async function () {
            await bond.connect(author).bond(DIGEST, MIN_STAKE);
            await expect(bond.connect(outsider).accuse(DIGEST, "x")).to.be.revertedWithCustomError(bond, "NotAgent");
            await expect(bond.connect(accuser).accuse(DIGEST, "ipfs://trace"))
                .to.changeTokenBalance(substrate, accuser, -COUNTER);
            await expect(bond.connect(accuser).accuse(DIGEST, "again")).to.be.revertedWithCustomError(bond, "DisputeOpen");
        });

        it("malicious: the stake pays the accuser as service earnings, the counter-bond returns, the digest is burned", async function () {
            await accused();
            await expect(bond.connect(outsider).rule(DIGEST, true)).to.be.revertedWithCustomError(bond, "NotArbiter");
            await bond.connect(arbiter).rule(DIGEST, true);
            await expect(bond.finalize(DIGEST)).to.be.revertedWithCustomError(bond, "TooEarly");
            await time.increase(APPEAL + 1);

            const before = await substrate.balanceOf(accuser.address);
            await bond.finalize(DIGEST);
            const net = MIN_STAKE - (MIN_STAKE * 250n) / 10000n; // 2.5% service fee
            expect(await substrate.balanceOf(accuser.address)).to.equal(before + COUNTER + net);
            expect(await substrate.serviceEarnings(accuser.address)).to.equal(net);
            expect(await bond.isBonded(DIGEST)).to.equal(false);
            await expect(bond.connect(author).bond(DIGEST, MIN_STAKE)).to.be.revertedWithCustomError(bond, "Slashed");
        });

        it("not malicious: the counter-bond goes to the author and the stake stays", async function () {
            await accused();
            await bond.connect(arbiter).rule(DIGEST, false);
            await time.increase(APPEAL + 1);
            await expect(bond.finalize(DIGEST)).to.changeTokenBalance(substrate, author, COUNTER);
            expect(await bond.isBonded(DIGEST)).to.equal(true);
        });

        it("the DAO can overrule a ruling within the appeal window, not after", async function () {
            await accused();
            await bond.connect(arbiter).rule(DIGEST, false);
            await expect(bond.connect(outsider).daoOverrule(DIGEST, true)).to.be.revertedWithCustomError(bond, "NotTimelock");
            await bond.connect(timelock).daoOverrule(DIGEST, true);
            expect((await bond.bonds(DIGEST)).slashed).to.equal(true);

            // A second tool, overrule attempted too late
            const d2 = ethers.id("tool manifest v2");
            await substrate.connect(author).registerTool(d2);
            await bond.connect(author).bond(d2, MIN_STAKE);
            await bond.connect(accuser).accuse(d2, "ipfs://trace");
            await bond.connect(arbiter).rule(d2, true);
            await time.increase(APPEAL + 1);
            await expect(bond.connect(timelock).daoOverrule(d2, false)).to.be.revertedWithCustomError(bond, "TooLate");
        });

        it("the DAO decides alone once the arbiter has been silent past its window", async function () {
            await accused();
            await expect(bond.connect(timelock).daoOverrule(DIGEST, true)).to.be.revertedWithCustomError(bond, "TooEarly");
            await time.increase(ARBITER_WINDOW + 1);
            await bond.connect(timelock).daoOverrule(DIGEST, true);
            expect((await bond.bonds(DIGEST)).slashed).to.equal(true);
        });

        it("a dispute nobody decides expires with both bonds returned", async function () {
            await accused();
            await expect(bond.expire(DIGEST)).to.be.revertedWithCustomError(bond, "TooEarly");
            await time.increase(150 * 86400 + 1);
            await expect(bond.expire(DIGEST)).to.changeTokenBalance(substrate, accuser, COUNTER);
            expect(await bond.isBonded(DIGEST)).to.equal(true);
        });
    });

    describe("governance", function () {
        it("only the timelock sets parameters, and a stake always outlives a ruling plus appeal", async function () {
            await expect(bond.connect(outsider).setParams(arbiter.address, 1, 1, ARBITER_WINDOW, UNBOND_DELAY))
                .to.be.revertedWithCustomError(bond, "NotTimelock");
            await expect(bond.connect(timelock).setParams(arbiter.address, 1, 1, ARBITER_WINDOW, ARBITER_WINDOW + APPEAL - 1))
                .to.be.revertedWithCustomError(bond, "UnbondDelayTooShort");
            await bond.connect(timelock).setParams(outsider.address, ATN(500), ATN(50), ARBITER_WINDOW, UNBOND_DELAY);
            expect(await bond.arbiter()).to.equal(outsider.address);
            expect(await bond.minStake()).to.equal(ATN(500));
        });
    });
});
