const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Reward epochs: one pool per epoch, each REP earns once, delegates take a DAO-set cut.
describe("Reward epochs", function () {
    const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    let deployer, timelock, alice, aliceAlt, bob, carol, outsider;
    let registry, repToken, usdc;

    const REP = (n) => ethers.parseEther(String(n));

    async function startEpoch(budget, token) {
        await repToken.connect(timelock).startNewRewardEpoch(budget, token ?? await usdc.getAddress());
        return repToken.currentRewardEpoch();
    }

    beforeEach(async function () {
        [deployer, timelock, alice, aliceAlt, bob, carol, outsider] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("Registry")).deploy(timelock.address, deployer.address);
        repToken = await (await ethers.getContractFactory("RepToken")).deploy(
            "Jurisdiction", "JUR", await registry.getAddress(), timelock.address,
            [alice.address, bob.address, carol.address], [REP(600), REP(300), REP(100)], false);
        await registry.connect(timelock).setJurisdictionAddress(await repToken.getAddress());

        usdc = await (await ethers.getContractFactory("TestToken")).deploy();
        await usdc.transfer(await registry.getAddress(), REP(10000));
    });

    it("pays undelegated and self-delegated holders their full pro-rata share", async function () {
        await repToken.connect(alice).delegate(alice.address); // self-delegated
        // bob and carol never delegate
        const epoch = await startEpoch(REP(1000));

        expect(await repToken.rewardOf(epoch, alice.address)).to.equal(REP(600));
        expect(await repToken.rewardOf(epoch, bob.address)).to.equal(REP(300));
        expect(await repToken.rewardOf(epoch, carol.address)).to.equal(REP(100));

        const before = await usdc.balanceOf(alice.address);
        await repToken.connect(alice).claimReward(epoch);
        expect((await usdc.balanceOf(alice.address)) - before).to.equal(REP(600));
        await expect(repToken.connect(alice).claimReward(epoch)).to.be.revertedWith("RepToken: Already claimed for this epoch");
    });

    it("gives the delegate its cut (1% by default) and the holder the rest", async function () {
        expect(await repToken.delegateShareBps()).to.equal(100);
        await repToken.connect(carol).delegate(bob.address); // bob is not self-delegated
        const epoch = await startEpoch(REP(1000));

        expect(await repToken.rewardOf(epoch, carol.address)).to.equal(REP(99));
        expect(await repToken.rewardOf(epoch, bob.address)).to.equal(REP(301));
        expect(await repToken.rewardOf(epoch, alice.address)).to.equal(REP(600));
    });

    it("makes delegating to one's own second wallet pointless", async function () {
        await repToken.connect(alice).delegate(aliceAlt.address);
        const epoch = await startEpoch(REP(1000));

        const combined = (await repToken.rewardOf(epoch, alice.address)) + (await repToken.rewardOf(epoch, aliceAlt.address));
        expect(combined).to.equal(REP(600));
    });

    it("never pays out more than the budget", async function () {
        await repToken.connect(timelock).setDelegateShareBps(2500);
        await repToken.connect(alice).delegate(bob.address);
        await repToken.connect(bob).delegate(bob.address);
        await repToken.connect(carol).delegate(alice.address);
        const epoch = await startEpoch(REP(999));

        let total = 0n;
        for (const s of [alice, bob, carol]) total += await repToken.rewardOf(epoch, s.address);
        expect(total).to.be.lte(REP(999));
        expect(REP(999) - total).to.be.lte(3n);
    });

    it("uses the delegation and split in force when the epoch started", async function () {
        await repToken.connect(carol).delegate(bob.address);
        const epoch = await startEpoch(REP(1000));
        await repToken.connect(carol).delegate(carol.address);
        await repToken.connect(timelock).setDelegateShareBps(2500);

        expect(await repToken.rewardOf(epoch, carol.address)).to.equal(REP(99));
        expect(await repToken.rewardOf(epoch, bob.address)).to.equal(REP(301));
    });

    it("caps the delegate share at 25% and only lets the timelock set it", async function () {
        await expect(repToken.connect(timelock).setDelegateShareBps(2501)).to.be.revertedWith("RepToken: Delegate share too high");
        await expect(repToken.connect(outsider).setDelegateShareBps(500)).to.be.revertedWith("RepToken: Only Timelock can set the delegate share");
    });

    describe("treasury reservations", function () {
        it("earmarks the budget at epoch start and blocks spending it", async function () {
            const usdcAddr = await usdc.getAddress();
            await startEpoch(REP(9000));
            expect(await registry.totalEarmarked(usdcAddr)).to.equal(REP(9000));
            await expect(registry.connect(timelock).transferERC20(usdcAddr, outsider.address, REP(1001)))
                .to.be.revertedWith("Registry: Funds are earmarked");
            await registry.connect(timelock).transferERC20(usdcAddr, outsider.address, REP(1000));
        });

        it("refuses to promise the same funds to two epochs", async function () {
            await startEpoch(REP(6000));
            await expect(startEpoch(REP(6000))).to.be.revertedWith("Cannot earmark more than available balance");
        });

        it("does not let outsiders earmark or disburse", async function () {
            const purpose = ethers.keccak256(ethers.toUtf8Bytes("x"));
            await expect(registry.connect(outsider).earmarkFunds(purpose, 1, await usdc.getAddress()))
                .to.be.revertedWith("Only the DAO can earmark funds");
            await expect(registry.connect(outsider).disburseEarmarked(outsider.address, 1, purpose, await usdc.getAddress()))
                .to.be.revertedWith("Registry: Caller is not the Jurisdiction");
        });

        it("pays rewards in native currency", async function () {
            await deployer.sendTransaction({ to: await registry.getAddress(), value: REP(10) });
            const epoch = await startEpoch(REP(10), NATIVE);
            const before = await ethers.provider.getBalance(bob.address);
            const r = await (await repToken.connect(bob).claimReward(epoch)).wait();
            const after = await ethers.provider.getBalance(bob.address);
            expect(after - before + r.gasUsed * r.gasPrice).to.equal(REP(3));
            await expect(registry.connect(timelock).transferETH(outsider.address, REP(1))) // the remaining 7 are all reserved
                .to.be.revertedWith("Registry: Funds are earmarked");
        });

        it("releases the unclaimed rest after the grace period", async function () {
            const usdcAddr = await usdc.getAddress();
            await registry.connect(timelock).editRegistry("benefits.claim.gracePeriod", "86400");
            const epoch = await startEpoch(REP(1000));
            await repToken.connect(alice).claimReward(epoch);
            await expect(registry.connect(timelock).reclaimEarmarkedFunds(epoch, usdcAddr))
                .to.be.revertedWith("Registry: The subsequent epoch has not started yet");
            await startEpoch(REP(1000));
            await time.increase(86401);
            await registry.connect(timelock).reclaimEarmarkedFunds(epoch, usdcAddr);
            expect(await registry.totalEarmarked(usdcAddr)).to.equal(REP(1000)); // only epoch 2 left
            await expect(repToken.connect(bob).claimReward(epoch)).to.be.revertedWith("Registry: Insufficient earmarked funds");
        });
    });
});
// reward-epochs.test.js
