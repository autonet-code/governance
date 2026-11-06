const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Reward epochs: a passive pool paid by REP balance and a delegate pool paid to the top delegates.
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
        const closeSignup = () => time.increase(Number(3 * 86400) + 1);

        it("pays by the weight received from others, not the delegate's own REP", async function () {
            await repToken.connect(alice).delegate(alice.address); // 600 of its own, nothing received
            await repToken.connect(bob).delegate(bob.address);     // 300 of its own
            await repToken.connect(carol).delegate(bob.address);   // 100 received
            const epoch = await startDelegates(REP(1000));

            expect(await repToken.receivedWeight(bob.address, (await time.latest()) - 1)).to.equal(REP(100));
            await expect(repToken.enterDelegatePool(epoch, alice.address)).to.be.revertedWith("RepToken: No delegated weight");
            await repToken.enterDelegatePool(epoch, bob.address);
            await closeSignup();
            expect(await repToken.rewardOf(epoch, bob.address)).to.equal(REP(1000));
            await expect(repToken.connect(alice).claimReward(epoch)).to.be.revertedWith("RepToken: Reward amount is zero");
        });

        it("splits the budget in proportion to the weight, and a delegate need not delegate to itself", async function () {
            await repToken.connect(alice).delegate(outsider.address); // 600 to an account with no REP
            await repToken.connect(bob).delegate(aliceAlt.address);   // 300
            const epoch = await startDelegates(REP(900));
            await repToken.connect(carol).enterDelegatePool(epoch, outsider.address); // anyone can enter anyone
            await repToken.enterDelegatePool(epoch, aliceAlt.address);
            await closeSignup();
            expect(await repToken.rewardOf(epoch, outsider.address)).to.equal(REP(600));
            expect(await repToken.rewardOf(epoch, aliceAlt.address)).to.equal(REP(300));
            await repToken.connect(outsider).claimReward(epoch);
            expect(await usdc.balanceOf(outsider.address)).to.equal(REP(600));
        });

        it("keeps only the top N: a heavier entry displaces the lowest, a lighter one is refused", async function () {
            await repToken.connect(timelock).setDelegateRewards(2, 3 * 86400);
            await repToken.connect(alice).delegate(outsider.address); // 600
            await repToken.connect(bob).delegate(aliceAlt.address);   // 300
            await repToken.connect(carol).delegate(deployer.address); // 100
            const epoch = await startDelegates(REP(900));
            await repToken.enterDelegatePool(epoch, deployer.address);
            await repToken.enterDelegatePool(epoch, aliceAlt.address);
            await expect(repToken.enterDelegatePool(epoch, outsider.address))
                .to.emit(repToken, "DelegatePoolDisplaced").withArgs(epoch, deployer.address);
            await expect(repToken.enterDelegatePool(epoch, deployer.address)).to.be.revertedWith("RepToken: Below the top list");
            expect(await repToken.delegatePoolTotal(epoch)).to.equal(REP(900));
            expect([...await repToken.topDelegates(epoch)]).to.have.members([outsider.address, aliceAlt.address]);
            await closeSignup();
            expect(await repToken.rewardOf(epoch, deployer.address)).to.equal(0n);
        });

        it("refuses a second entry, late entries and early claims", async function () {
            await repToken.connect(carol).delegate(bob.address);
            const epoch = await startDelegates(REP(100));
            await repToken.enterDelegatePool(epoch, bob.address);
            await expect(repToken.enterDelegatePool(epoch, bob.address)).to.be.revertedWith("RepToken: Already in the top list");
            await expect(repToken.connect(bob).claimReward(epoch)).to.be.revertedWith("RepToken: Sign-up is still open");
            await repToken.connect(alice).delegate(aliceAlt.address);
            await closeSignup();
            await expect(repToken.enterDelegatePool(epoch, bob.address)).to.be.revertedWith("RepToken: Sign-up has closed");
            await repToken.connect(bob).claimReward(epoch);
        });

        it("ranks by the delegations at the start of the epoch", async function () {
            await repToken.connect(carol).delegate(bob.address);
            const epoch = await startDelegates(REP(100));
            await repToken.connect(carol).delegate(carol.address);
            await repToken.connect(alice).delegate(aliceAlt.address);
            await repToken.enterDelegatePool(epoch, bob.address);
            await expect(repToken.enterDelegatePool(epoch, aliceAlt.address)).to.be.revertedWith("RepToken: No delegated weight");
        });

        it("keeps the settings in force when the epoch started", async function () {
            await repToken.connect(alice).delegate(outsider.address);
            await repToken.connect(bob).delegate(aliceAlt.address);
            await repToken.connect(timelock).setDelegateRewards(1, 3600);
            const epoch = await startDelegates(REP(100));
            await repToken.connect(timelock).setDelegateRewards(5, 86400);
            await repToken.enterDelegatePool(epoch, aliceAlt.address);
            await repToken.enterDelegatePool(epoch, outsider.address);
            expect([...await repToken.topDelegates(epoch)]).to.deep.equal([outsider.address]);
        });

        it("rejects entries in a passive pool, and out-of-range settings or callers", async function () {
            const epoch = await startEpoch(REP(10));
            await expect(repToken.enterDelegatePool(epoch, bob.address)).to.be.revertedWith("RepToken: Not a delegate pool");
            await expect(repToken.enterDelegatePool(99, bob.address)).to.be.revertedWith("RepToken: Not a delegate pool");
            await expect(repToken.connect(timelock).setDelegateRewards(0, 3600)).to.be.revertedWith("RepToken: Invalid top N");
            await expect(repToken.connect(timelock).setDelegateRewards(101, 3600)).to.be.revertedWith("RepToken: Invalid top N");
            await expect(repToken.connect(timelock).setDelegateRewards(5, 0)).to.be.revertedWith("RepToken: Invalid sign-up period");
            await expect(repToken.connect(outsider).setDelegateRewards(5, 3600)).to.be.revertedWith("RepToken: Only Timelock can set delegate rewards");
            await expect(repToken.connect(outsider).startDelegateEpoch(1, await usdc.getAddress())).to.be.revertedWith("RepToken: Only Timelock can start an epoch");
        });

        it("displacing from a full list at the largest N stays affordable", async function () {
            await repToken.connect(timelock).setDelegateRewards(100, 3 * 86400);
            const delegatees = [];
            for (let i = 0; i < 100; i++) {
                const holder = ethers.Wallet.createRandom().connect(ethers.provider);
                await deployer.sendTransaction({ to: holder.address, value: REP(0.01) });
                await repToken.connect(deployer).mint(holder.address, REP(1));
                delegatees.push(ethers.Wallet.createRandom().address);
                await repToken.connect(holder).delegate(delegatees[i]);
            }
            await repToken.connect(alice).delegate(outsider.address);
            const epoch = await startDelegates(REP(100));
            for (const d of delegatees) await repToken.enterDelegatePool(epoch, d);
            const tx = await repToken.enterDelegatePool(epoch, outsider.address);
            expect((await tx.wait()).gasUsed).to.be.lessThan(700000n);
        });
    });

    it("a pool's reservation stays until a delegate pool's sign-up has passed the grace period", async function () {
        const usdcAddr = await usdc.getAddress();
        await registry.connect(timelock).editRegistry("benefits.claim.gracePeriod", "60");
        await repToken.connect(carol).delegate(bob.address);
        await repToken.connect(timelock).startDelegateEpoch(REP(100), usdcAddr);
        const epoch = await repToken.currentRewardEpoch();
        await startEpoch(REP(100)); // the next epoch starts during the sign-up
        await time.increase(120);
        await expect(registry.connect(timelock).reclaimEarmarkedFunds(epoch, usdcAddr))
            .to.be.revertedWith("Registry: Claim grace period has not passed");
        await time.increase(3 * 86400);
        await registry.connect(timelock).reclaimEarmarkedFunds(epoch, usdcAddr);
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
