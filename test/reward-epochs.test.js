const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Reward epochs: a passive pool paid by REP balance and a delegate pool paid above a share bar.
describe("Reward epochs", function () {
    const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    let deployer, timelock, alice, aliceAlt, bob, carol, outsider;
    let registry, repToken, usdc;

    const REP = (n) => ethers.parseEther(String(n));

    async function startEpoch(budget, token) {
        await repToken.connect(timelock).startPassiveEpoch(budget, token ?? await usdc.getAddress());
        return repToken.currentRewardEpoch();
    }

    beforeEach(async function () {
        [deployer, timelock, alice, aliceAlt, bob, carol, outsider] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("Registry")).deploy(timelock.address, deployer.address);
        repToken = await (await ethers.getContractFactory("RepToken")).deploy(
            "Jurisdiction", "JUR", await registry.getAddress(), timelock.address,
            [alice.address, bob.address, carol.address], [REP(600), REP(300), REP(100)]);
        await registry.connect(timelock).setJurisdictionAddress(await repToken.getAddress());

        usdc = await (await ethers.getContractFactory("TestToken")).deploy();
        await usdc.transfer(await registry.getAddress(), REP(10000));
    });

    describe("passive pool", function () {
        it("pays each holder by REP balance, once", async function () {
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

        it("ignores delegation: a delegator keeps its share and its delegate gains nothing", async function () {
            await repToken.connect(carol).delegate(bob.address);
            const epoch = await startEpoch(REP(1000));
            expect(await repToken.rewardOf(epoch, carol.address)).to.equal(REP(100));
            expect(await repToken.rewardOf(epoch, bob.address)).to.equal(REP(300));
        });

        it("uses the balances at the start of the epoch", async function () {
            const epoch = await startEpoch(REP(1000));
            await repToken.connect(deployer).mint(carol.address, REP(1000));
            expect(await repToken.rewardOf(epoch, carol.address)).to.equal(REP(100));
        });
    });

    describe("delegate pool", function () {
        const startDelegates = async (budget) => {
            await repToken.connect(timelock).startDelegateEpoch(budget, await usdc.getAddress());
            return repToken.currentRewardEpoch();
        };

        it("pays by the weight received from others, at once, and the delegate's own REP doesn't count", async function () {
            await repToken.connect(alice).delegate(alice.address); // 600 of its own, nothing received
            await repToken.connect(bob).delegate(bob.address);     // 300 of its own
            await repToken.connect(carol).delegate(bob.address);   // 100 received
            const epoch = await startDelegates(REP(1000));

            expect(await repToken.receivedWeight(bob.address, (await time.latest()) - 1)).to.equal(REP(100));
            expect(await repToken.rewardOf(epoch, bob.address)).to.equal(REP(100)); // 10% of all REP
            expect(await repToken.rewardOf(epoch, alice.address)).to.equal(0n);
            await repToken.connect(bob).claimReward(epoch);
            expect(await usdc.balanceOf(bob.address)).to.equal(REP(100));
            await expect(repToken.connect(alice).claimReward(epoch)).to.be.revertedWith("RepToken: Reward amount is zero");
        });

        it("an Autonet operator gets no delegate pay on its own owner's REP", async function () {
            const { autonet, registerAgent } = require("./helpers/autonet");
            const substrate = await autonet("Substrate", deployer).deploy(ethers.ZeroAddress, deployer.address, timelock.address,
                ethers.ZeroAddress, ethers.ZeroHash, "Test ATN", "TSTATN", 250, 5000);
            await registerAgent(substrate, outsider, "0x01", alice); // outsider is alice's operator
            await repToken.connect(alice).delegate(outsider.address);  // 600, the household's own
            await repToken.connect(carol).delegate(outsider.address);  // 100 from someone else

            // Without Autonet installed nothing changes
            let epoch = await startDelegates(REP(1000));
            expect(await repToken.rewardOf(epoch, outsider.address)).to.equal(REP(700));

            await registry.connect(timelock).editRegistry("jurisdiction.autonet.substrate", await substrate.getAddress());
            epoch = await startDelegates(REP(1000));
            expect(await repToken.receivedWeight(outsider.address, (await time.latest()) - 1)).to.equal(REP(100));
            expect(await repToken.rewardOf(epoch, outsider.address)).to.equal(REP(100));
            await repToken.connect(outsider).claimReward(epoch); // paid to the operator
            expect(await usdc.balanceOf(outsider.address)).to.equal(REP(100));

            // An unbound delegate, or an operator whose owner delegates elsewhere, keeps all it received
            await repToken.connect(alice).delegate(bob.address);
            epoch = await startDelegates(REP(1000));
            expect(await repToken.rewardOf(epoch, bob.address)).to.equal(REP(600));
            expect(await repToken.rewardOf(epoch, outsider.address)).to.equal(REP(100));

            // A Registry value that isn't a contract address is no Autonet
            await registry.connect(timelock).editRegistry("jurisdiction.autonet.substrate", "not an address");
            await repToken.connect(alice).delegate(outsider.address);
            epoch = await startDelegates(REP(1000));
            expect(await repToken.rewardOf(epoch, outsider.address)).to.equal(REP(700));
        });

        it("a delegate need not delegate to itself or hold any REP", async function () {
            await repToken.connect(alice).delegate(outsider.address);
            const epoch = await startDelegates(REP(1000));
            expect(await repToken.rewardOf(epoch, outsider.address)).to.equal(REP(600));
        });

        it("pays at exactly the bar and nothing just below it", async function () {
            await repToken.connect(timelock).setDelegateBar(1000); // 10% of all REP
            await repToken.connect(carol).delegate(bob.address);   // exactly 10%
            let epoch = await startDelegates(REP(1000));
            expect(await repToken.rewardOf(epoch, bob.address)).to.equal(REP(100));

            await repToken.connect(timelock).setDelegateBar(1001);
            epoch = await startDelegates(REP(1000));
            expect(await repToken.rewardOf(epoch, bob.address)).to.equal(0n);
        });

        it("the budget is a ceiling: only weight above the bar is paid and the rest stays reclaimable", async function () {
            const usdcAddr = await usdc.getAddress();
            await registry.connect(timelock).editRegistry("benefits.claim.gracePeriod", "60");
            await repToken.connect(carol).delegate(bob.address);
            const epoch = await startDelegates(REP(1000));
            await repToken.connect(bob).claimReward(epoch); // 10% of the budget
            await startEpoch(REP(1));
            await time.increase(61);
            await registry.connect(timelock).reclaimEarmarkedFunds(epoch, usdcAddr);
            expect(await registry.totalEarmarked(usdcAddr)).to.equal(REP(1)); // only the second epoch
        });

        it("never pays more than the budget, even with all REP delegated", async function () {
            await repToken.connect(alice).delegate(bob.address);
            await repToken.connect(bob).delegate(carol.address);
            await repToken.connect(carol).delegate(alice.address);
            const epoch = await startDelegates(REP(999));
            let total = 0n;
            for (const a of [alice, bob, carol]) total += await repToken.rewardOf(epoch, a.address);
            expect(total).to.be.lte(REP(999));
        });

        it("uses the delegations and the bar in force when the epoch started", async function () {
            await repToken.connect(carol).delegate(bob.address);
            const epoch = await startDelegates(REP(1000));
            await repToken.connect(carol).delegate(carol.address);
            await repToken.connect(alice).delegate(bob.address);
            await repToken.connect(timelock).setDelegateBar(5000);
            expect(await repToken.rewardOf(epoch, bob.address)).to.equal(REP(100));
        });

        it("a delegate with the default 1% bar is paid, one below it is not", async function () {
            expect(await repToken.delegateBarBps()).to.equal(100);
            await repToken.connect(deployer).mint(outsider.address, REP(9));
            await repToken.connect(outsider).delegate(aliceAlt.address); // 9 of 1009: under 1%
            const epoch = await startDelegates(REP(1000));
            expect(await repToken.rewardOf(epoch, aliceAlt.address)).to.equal(0n);
        });

        it("only the timelock sets the bar, up to all REP", async function () {
            await expect(repToken.connect(timelock).setDelegateBar(10001)).to.be.revertedWith("RepToken: Delegate bar too high");
            await expect(repToken.connect(outsider).setDelegateBar(200)).to.be.revertedWith("RepToken: Only Timelock can set the delegate bar");
            await expect(repToken.connect(outsider).startDelegateEpoch(1, await usdc.getAddress())).to.be.revertedWith("RepToken: Only Timelock can start an epoch");
        });
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
