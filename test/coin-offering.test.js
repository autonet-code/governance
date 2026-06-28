const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("CoinOffering (CO)", function () {
    let deployer, dao, executionDelegate, buyer, otherDelegate, attacker;
    let registry, atnb, usdc, co;

    const USDC_DECIMALS = 6;

    // Parity is an 18-decimal fixed-point multiplier (1e18 == 1:1), the SAME
    // convention RepToken uses. atnbOut = paymentAmount * parity / 1e18.
    // To price 1 USDC (6 dec) -> 2 ATNB (18 dec): parity = 2e18 * 1e12 = 2e30.
    //   1e6 (1 USDC) * 2e30 / 1e18 = 2e18 (2 ATNB). ✓
    const PARITY = ethers.parseEther("2") * (10n ** 12n); // 2e30

    function parityKey(tokenAddr) {
        return `jurisdiction.parity.${tokenAddr.toLowerCase()}`;
    }

    beforeEach(async function () {
        [deployer, dao, executionDelegate, buyer, otherDelegate, attacker] =
            await ethers.getSigners();

        // Registry: owner = dao (so dao can set parity via editRegistry).
        const Registry = await ethers.getContractFactory("Registry");
        registry = await Registry.deploy(dao.address, deployer.address);
        const registryAddr = await registry.getAddress();

        // ATNB: a transferable RepToken (the governance token).
        const RepToken = await ethers.getContractFactory("RepToken");
        atnb = await RepToken.deploy(
            "Autonet Bond", "ATNB",
            registryAddr,
            dao.address,          // timelock
            [], [],
            true                  // transferable
        );
        // admin starts as deployer; deployer mints inventory + sets defaultDelegate.

        // Payment token: a USDC-like 6-decimal ERC20.
        const TestERC20 = await ethers.getContractFactory("TestERC20");
        usdc = await TestERC20.deploy("USD Coin", "USDC", USDC_DECIMALS, 0);

        // Deploy the CoinOffering (no executionDelegate arg — delegation lives on the token).
        const CO = await ethers.getContractFactory("CoinOffering");
        co = await CO.deploy(
            await atnb.getAddress(),
            registryAddr,
            dao.address                 // admin (timelock in prod)
        );

        // DAO sets the registry parity for USDC.
        await registry.connect(dao).editRegistry(parityKey(await usdc.getAddress()), PARITY.toString());

        // Configure auto-delegation ON THE TOKEN: buyers receiving ATNB while
        // undelegated are auto-delegated to the execution team.
        await atnb.connect(deployer).setDefaultDelegate(executionDelegate.address);

        // The CO holds unsold inventory; that float must NOT accrue votes to the
        // execution delegate. Exempt the CO so only buyers auto-delegate.
        await atnb.connect(deployer).setAutoDelegateExempt(await co.getAddress(), true);

        // DAO "mints ATNB to the CO" (deployer is admin of the freshly deployed token).
        await atnb.connect(deployer).mint(await co.getAddress(), ethers.parseEther("1000000"));

        // Buyer funded with USDC and approves the CO.
        await usdc.mint(buyer.address, ethers.parseUnits("100000", USDC_DECIMALS));
        await usdc.connect(buyer).approve(await co.getAddress(), ethers.MaxUint256);
    });

    // =========================================================================
    // BUY + ROUTING + DELIVERY
    // =========================================================================

    describe("buy()", function () {
        it("delivers ATNB to the buyer and routes payment to the Registry treasury", async function () {
            const pay = ethers.parseUnits("500", USDC_DECIMALS); // 500 USDC
            const expectedAtnb = ethers.parseEther("1000");       // 500 * 2

            const registryAddr = await registry.getAddress();
            const treasuryUsdcBefore = await usdc.balanceOf(registryAddr);
            const coAtnbBefore = await atnb.balanceOf(await co.getAddress());

            await expect(co.connect(buyer).buy(await usdc.getAddress(), pay))
                .to.emit(co, "TokensPurchased")
                .withArgs(buyer.address, await usdc.getAddress(), pay, expectedAtnb, PARITY);

            // ATNB delivered from inventory.
            expect(await atnb.balanceOf(buyer.address)).to.equal(expectedAtnb);
            expect(await atnb.balanceOf(await co.getAddress())).to.equal(coAtnbBefore - expectedAtnb);

            // Payment routed straight to the treasury — CO holds no cash.
            expect(await usdc.balanceOf(registryAddr)).to.equal(treasuryUsdcBefore + pay);
            expect(await usdc.balanceOf(await co.getAddress())).to.equal(0n);

            // Accounting.
            expect(await co.totalSold()).to.equal(expectedAtnb);
            expect(await co.totalRaised(await usdc.getAddress())).to.equal(pay);
        });

        it("auto-delegates the buyer to the execution delegate via the token (no signature)", async function () {
            const pay = ethers.parseUnits("500", USDC_DECIMALS);
            const expectedAtnb = ethers.parseEther("1000");

            // Before: buyer undelegated, delegate has no votes.
            expect(await atnb.delegates(buyer.address)).to.equal(ethers.ZeroAddress);
            expect(await atnb.getVotes(executionDelegate.address)).to.equal(0n);

            await co.connect(buyer).buy(await usdc.getAddress(), pay);

            // The token auto-delegated the buyer on receipt — no CO signature dance.
            expect(await atnb.delegates(buyer.address)).to.equal(executionDelegate.address);
            expect(await atnb.getVotes(executionDelegate.address)).to.equal(expectedAtnb);
            expect(await atnb.getVotes(buyer.address)).to.equal(0n);
        });

        it("lets the buyer later reclaim and self-delegate (werule.io flow)", async function () {
            const pay = ethers.parseUnits("500", USDC_DECIMALS);
            const expectedAtnb = ethers.parseEther("1000");

            await co.connect(buyer).buy(await usdc.getAddress(), pay);
            expect(await atnb.getVotes(executionDelegate.address)).to.equal(expectedAtnb);

            // Buyer reclaims by self-delegating; never auto-reset afterwards.
            await atnb.connect(buyer).delegate(buyer.address);
            expect(await atnb.getVotes(executionDelegate.address)).to.equal(0n);
            expect(await atnb.getVotes(buyer.address)).to.equal(expectedAtnb);

            // A second purchase must NOT re-capture their vote.
            await co.connect(buyer).buy(await usdc.getAddress(), pay);
            expect(await atnb.delegates(buyer.address)).to.equal(buyer.address);
            expect(await atnb.getVotes(executionDelegate.address)).to.equal(0n);
        });

        it("computes parity math correctly across decimal mismatch (6 -> 18)", async function () {
            const pay = ethers.parseUnits("1", USDC_DECIMALS); // 1 USDC
            const quoted = await co.quote(await usdc.getAddress(), pay);
            expect(quoted).to.equal(ethers.parseEther("2"));

            await co.connect(buyer).buy(await usdc.getAddress(), pay);
            expect(await atnb.balanceOf(buyer.address)).to.equal(ethers.parseEther("2"));
        });

        it("reverts for an unregistered payment token", async function () {
            const TestERC20 = await ethers.getContractFactory("TestERC20");
            const rogue = await TestERC20.deploy("Rogue", "RGE", 18, 0);
            await rogue.mint(buyer.address, ethers.parseEther("100"));
            await rogue.connect(buyer).approve(await co.getAddress(), ethers.MaxUint256);

            await expect(
                co.connect(buyer).buy(await rogue.getAddress(), ethers.parseEther("10"))
            )
                .to.be.revertedWithCustomError(co, "TokenNotRegistered")
                .withArgs(await rogue.getAddress());
        });

        it("reverts on zero payment", async function () {
            await expect(
                co.connect(buyer).buy(await usdc.getAddress(), 0)
            ).to.be.revertedWithCustomError(co, "InvalidAmount");
        });

        it("reverts when payment is too small to yield any ATNB (dust)", async function () {
            // Set parity so small that 1 base unit of USDC floors to 0 ATNB.
            // parity = 1e6 -> 1 base USDC * 1e6 / 1e18 = 0 (floor) -> dust.
            await registry.connect(dao).editRegistry(parityKey(await usdc.getAddress()), (10n ** 6n).toString());
            await expect(
                co.connect(buyer).buy(await usdc.getAddress(), 1)
            ).to.be.revertedWithCustomError(co, "DustAmount");
        });

        it("reverts when CO has insufficient ATNB inventory", async function () {
            const inv = await co.inventory();
            await co.connect(dao).recoverInventory(dao.address, inv);

            await expect(
                co.connect(buyer).buy(await usdc.getAddress(), ethers.parseUnits("1", USDC_DECIMALS))
            ).to.be.revertedWithCustomError(co, "InsufficientInventory");
        });
    });

    // =========================================================================
    // PAUSE
    // =========================================================================

    describe("pause", function () {
        it("blocks buying while paused and resumes after unpause", async function () {
            await co.connect(dao).pause();
            await expect(
                co.connect(buyer).buy(await usdc.getAddress(), ethers.parseUnits("1", USDC_DECIMALS))
            ).to.be.revertedWithCustomError(co, "EnforcedPause");

            await co.connect(dao).unpause();
            await expect(
                co.connect(buyer).buy(await usdc.getAddress(), ethers.parseUnits("1", USDC_DECIMALS))
            ).to.not.be.reverted;
        });

        it("only admin can pause", async function () {
            await expect(co.connect(attacker).pause())
                .to.be.revertedWithCustomError(co, "NotAdmin");
        });
    });

    // =========================================================================
    // ADMIN
    // =========================================================================

    describe("admin", function () {
        it("only admin can recover inventory", async function () {
            await expect(co.connect(attacker).recoverInventory(attacker.address, 1n))
                .to.be.revertedWithCustomError(co, "NotAdmin");
        });

        it("only admin can transfer admin", async function () {
            await expect(co.connect(attacker).transferAdmin(attacker.address))
                .to.be.revertedWithCustomError(co, "NotAdmin");
            await co.connect(dao).transferAdmin(deployer.address);
            expect(await co.admin()).to.equal(deployer.address);
        });
    });

    // =========================================================================
    // REENTRANCY
    // =========================================================================

    describe("reentrancy guard", function () {
        it("buy is nonReentrant (guard present and effective)", async function () {
            const Reenter = await ethers.getContractFactory("ReentrantPaymentToken");
            const evil = await Reenter.deploy(await co.getAddress());
            const evilAddr = await evil.getAddress();

            await registry.connect(dao).editRegistry(parityKey(evilAddr), PARITY.toString());

            await evil.mintTo(buyer.address, ethers.parseUnits("100", USDC_DECIMALS));
            await evil.connect(buyer).approve(await co.getAddress(), ethers.MaxUint256);
            await evil.armReentrancy(await usdc.getAddress());

            // The reentrant call inside transferFrom must bubble up as a guard revert.
            await expect(
                co.connect(buyer).buy(evilAddr, ethers.parseUnits("10", USDC_DECIMALS))
            ).to.be.reverted;
        });
    });
});
