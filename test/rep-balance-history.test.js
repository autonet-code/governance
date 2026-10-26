const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// getPastBalance: an account's own REP at a past time, on the getPastVotes clock and blind to delegation.
describe("RepToken balance history", function () {
    let rep, admin, timelock, x, y;
    const E = (n) => ethers.parseEther(String(n));

    beforeEach(async function () {
        [admin, timelock, x, y] = await ethers.getSigners();
        const registry = await (await ethers.getContractFactory("Registry")).deploy(timelock.address, admin.address);
        rep = await (await ethers.getContractFactory("RepToken")).deploy(
            "Rep", "REP", await registry.getAddress(), timelock.address, [], [], true);
    });

    async function at() {
        const t = await time.latest();
        await time.increase(1);
        return t;
    }

    it("follows mint, transfer and burn", async function () {
        await rep.mint(x.address, E(100));
        const t1 = await at();
        await rep.connect(x).transfer(y.address, E(30));
        const t2 = await at();
        await rep.burn(y.address, E(10));
        const t3 = await at();
        expect(await rep.getPastBalance(x.address, t1)).to.equal(E(100));
        expect(await rep.getPastBalance(x.address, t2)).to.equal(E(70));
        expect(await rep.getPastBalance(y.address, t2)).to.equal(E(30));
        expect(await rep.getPastBalance(y.address, t3)).to.equal(E(20));
        expect(await rep.getPastBalance(y.address, t1)).to.equal(0n);
    });

    it("ignores delegation, which only moves votes", async function () {
        await rep.mint(x.address, E(100));
        await rep.connect(x).delegate(y.address);
        const t = await at();
        expect(await rep.getPastVotes(x.address, t)).to.equal(0n);
        expect(await rep.getPastVotes(y.address, t)).to.equal(E(100));
        expect(await rep.getPastBalance(x.address, t)).to.equal(E(100));
        expect(await rep.getPastBalance(y.address, t)).to.equal(0n);
    });

    it("keeps the end-of-block balance across several transfers in one block", async function () {
        await rep.mint(x.address, E(100));
        const before = await at();
        await network.provider.send("evm_setAutomine", [false]);
        await network.provider.send("evm_setIntervalMining", [0]);
        try {
            const n = await x.getNonce();
            await rep.connect(x).transfer(y.address, E(10), { nonce: n, gasLimit: 300000 });
            await rep.connect(x).transfer(y.address, E(20), { nonce: n + 1, gasLimit: 300000 });
            await rep.connect(y).transfer(x.address, E(5), { gasLimit: 300000 });
            await network.provider.send("evm_mine");
            expect((await ethers.provider.getBlock("latest")).transactions.length).to.equal(3);
        } finally {
            await network.provider.send("evm_setAutomine", [true]);
            await network.provider.send("evm_setIntervalMining", [2000]);
        }
        const t = await at();
        expect(await rep.getPastBalance(x.address, before)).to.equal(E(100));
        expect(await rep.getPastBalance(x.address, t)).to.equal(E(75));
        expect(await rep.getPastBalance(y.address, t)).to.equal(E(25));
    });

    it("rejects the current or a future time, like getPastVotes", async function () {
        const now = await time.latest();
        await expect(rep.getPastBalance(x.address, now + 10)).to.be.revertedWithCustomError(rep, "ERC5805FutureLookup");
    });
});
