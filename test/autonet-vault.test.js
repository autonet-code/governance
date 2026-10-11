const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AutonetVault", function () {
    let deployer, dao, buyer, attacker;
    let registry, atn, usdc, vault;

    const USDC_DECIMALS = 6;
    const ATN_DECIMALS = 6; // Substrate ATN is 1e6-scaled.

    // Parity is an 18-decimal fixed-point multiplier (1e18 == 1:1), the SAME
    // convention CoinOffering / RepToken use. atnOut = paymentAmount * parity / 1e18.
    //
    // TARGET IS 6-DECIMAL. To price 1 USDC (6 dec) -> 2 ATN (6 dec):
    //   atnOut base must be 2e6 for paymentAmount base 1e6.
    //   1e6 * parity / 1e18 = 2e6  =>  parity = 2e18.
    const PARITY = ethers.parseEther("2"); // 2e18  (1 USDC -> 2 ATN, both 6-dec)

    function parityKey(tokenAddr) {
        return `jurisdiction.parity.${tokenAddr.toLowerCase()}`;
    }

    // Helper: ATN base units for a human ATN amount (6 decimals).
    function atnUnits(human) {
        return ethers.parseUnits(String(human), ATN_DECIMALS);
    }

    beforeEach(async function () {
        [deployer, dao, buyer, attacker] = await ethers.getSigners();

        // Registry: owner = dao (so dao can set parity via editRegistry),
        // wrapper = deployer (unused here).
        const Registry = await ethers.getContractFactory("Registry");
        registry = await Registry.deploy(dao.address, deployer.address);
        const registryAddr = await registry.getAddress();

        // ATN: the EXTERNAL Autonet network token (mock Substrate, 6-dec).
        const MockAutonetATN = await ethers.getContractFactory("MockAutonetATN");
        atn = await MockAutonetATN.deploy();
        const atnAddr = await atn.getAddress();

        // Payment token: a USDC-like 6-decimal ERC20.
        const TestERC20 = await ethers.getContractFactory("TestERC20");
        usdc = await TestERC20.deploy("USD Coin", "USDC", USDC_DECIMALS, 0);

        // Deploy the AutonetVault.
        const Vault = await ethers.getContractFactory("AutonetVault");
        vault = await Vault.deploy(
            atnAddr,
            registryAddr,
            dao.address // admin (timelock in prod)
        );

        // DAO sets the registry parity (whitelist) for USDC.
        await registry
            .connect(dao)
            .editRegistry(parityKey(await usdc.getAddress()), PARITY.toString());

        // Buyer funded with USDC and approves the vault.
        await usdc.mint(buyer.address, ethers.parseUnits("100000", USDC_DECIMALS));
        await usdc.connect(buyer).approve(await vault.getAddress(), ethers.MaxUint256);
    });

    // =========================================================================
    // BUY + ROUTING + DELIVERY
    // =========================================================================

    describe("buy()", function () {
        it("mints ATN to the buyer and routes payment to the Registry treasury", async function () {
            const pay = ethers.parseUnits("500", USDC_DECIMALS); // 500 USDC
            const expectedAtn = atnUnits("1000"); // 500 * 2, 6-dec base units

            const registryAddr = await registry.getAddress();
            const treasuryUsdcBefore = await usdc.balanceOf(registryAddr);

            await expect(vault.connect(buyer).buy(await usdc.getAddress(), pay))
                .to.emit(vault, "AtnPurchased")
                .withArgs(
                    buyer.address,
                    await usdc.getAddress(),
                    pay,
                    expectedAtn,
                    PARITY
                );

            // ATN minted to the buyer on the external Substrate mock.
            expect(await atn.balanceOf(buyer.address)).to.equal(expectedAtn);
            // Vault never holds ATN.
            expect(await atn.balanceOf(await vault.getAddress())).to.equal(0n);
            // The vault is the minter recorded by Substrate.
            expect(await atn.lastMinter()).to.equal(await vault.getAddress());

            // Payment routed straight to the treasury — vault holds no cash.
            expect(await usdc.balanceOf(registryAddr)).to.equal(
                treasuryUsdcBefore + pay
            );
            expect(await usdc.balanceOf(await vault.getAddress())).to.equal(0n);

            // Accounting.
            expect(await vault.totalMinted()).to.equal(expectedAtn);
            expect(await vault.totalRaised(await usdc.getAddress())).to.equal(pay);
        });

        it("computes parity math correctly for a 6-dec -> 6-dec target", async function () {
            const pay = ethers.parseUnits("1", USDC_DECIMALS); // 1 USDC
            const quoted = await vault.quote(await usdc.getAddress(), pay);
            expect(quoted).to.equal(atnUnits("2")); // 2 ATN in base units (2e6)

            await (await vault.connect(buyer).buy(await usdc.getAddress(), pay)).wait();
            expect(await atn.balanceOf(buyer.address)).to.equal(atnUnits("2"));
        });

        it("computes parity math correctly for an 18-dec payment -> 6-dec ATN", async function () {
            // DAI-like 18-dec payment token, priced 1 DAI -> 1 ATN.
            // atnOut base 1e6 for paymentAmount base 1e18 => parity = 1e6.
            const TestERC20 = await ethers.getContractFactory("TestERC20");
            const dai = await TestERC20.deploy("Dai", "DAI", 18, 0);
            const daiAddr = await dai.getAddress();
            const daiParity = 10n ** 6n; // 1e6
            await registry
                .connect(dao)
                .editRegistry(parityKey(daiAddr), daiParity.toString());

            await dai.mint(buyer.address, ethers.parseEther("100"));
            await dai.connect(buyer).approve(await vault.getAddress(), ethers.MaxUint256);

            const pay = ethers.parseEther("3"); // 3 DAI
            expect(await vault.quote(daiAddr, pay)).to.equal(atnUnits("3"));

            await (await vault.connect(buyer).buy(daiAddr, pay)).wait();
            expect(await atn.balanceOf(buyer.address)).to.equal(atnUnits("3"));
        });

        it("is uncapped (no sale cap): a very large buy succeeds", async function () {
            // 50,000 USDC -> 100,000 ATN. CoinOffering would need a cap raise;
            // the vault has none.
            const pay = ethers.parseUnits("50000", USDC_DECIMALS);
            await (await vault.connect(buyer).buy(await usdc.getAddress(), pay)).wait();
            expect(await atn.balanceOf(buyer.address)).to.equal(atnUnits("100000"));
            expect(await vault.totalMinted()).to.equal(atnUnits("100000"));
        });

        it("accumulates totalMinted / totalRaised across buys", async function () {
            const pay = ethers.parseUnits("10", USDC_DECIMALS);
            await (await vault.connect(buyer).buy(await usdc.getAddress(), pay)).wait();
            await (await vault.connect(buyer).buy(await usdc.getAddress(), pay)).wait();
            expect(await vault.totalMinted()).to.equal(atnUnits("40")); // 2 * (10*2)
            expect(await vault.totalRaised(await usdc.getAddress())).to.equal(pay * 2n);
        });

        it("reverts for a non-whitelisted payment token", async function () {
            const TestERC20 = await ethers.getContractFactory("TestERC20");
            const rogue = await TestERC20.deploy("Rogue", "RGE", 18, 0);
            await rogue.mint(buyer.address, ethers.parseEther("100"));
            await rogue.connect(buyer).approve(await vault.getAddress(), ethers.MaxUint256);

            await expect(
                vault.connect(buyer).buy(await rogue.getAddress(), ethers.parseEther("10"))
            )
                .to.be.revertedWithCustomError(vault, "TokenNotRegistered")
                .withArgs(await rogue.getAddress());
        });

        it("reverts when parity is explicitly set to 0 (de-whitelisted)", async function () {
            await registry
                .connect(dao)
                .editRegistry(parityKey(await usdc.getAddress()), "0");
            await expect(
                vault.connect(buyer).buy(await usdc.getAddress(), ethers.parseUnits("1", USDC_DECIMALS))
            )
                .to.be.revertedWithCustomError(vault, "TokenNotRegistered")
                .withArgs(await usdc.getAddress());
        });

        it("reverts on zero payment", async function () {
            await expect(
                vault.connect(buyer).buy(await usdc.getAddress(), 0)
            ).to.be.revertedWithCustomError(vault, "InvalidAmount");
        });

        it("reverts when payment is too small to yield any ATN base unit (dust)", async function () {
            // Set parity so small that 1 base unit of USDC floors to 0 ATN.
            // parity = 1e6 -> 1 base USDC * 1e6 / 1e18 = 0 (floor) -> dust.
            await registry
                .connect(dao)
                .editRegistry(parityKey(await usdc.getAddress()), (10n ** 6n).toString());
            await expect(
                vault.connect(buyer).buy(await usdc.getAddress(), 1)
            ).to.be.revertedWithCustomError(vault, "DustAmount");
        });

        it("payment always lands at the Registry, never in the vault", async function () {
            const registryAddr = await registry.getAddress();
            const vaultAddr = await vault.getAddress();
            const pay = ethers.parseUnits("123", USDC_DECIMALS);

            await (await vault.connect(buyer).buy(await usdc.getAddress(), pay)).wait();

            expect(await usdc.balanceOf(vaultAddr)).to.equal(0n);
            expect(await usdc.balanceOf(registryAddr)).to.equal(pay);
        });

        // FEE-ON-TRANSFER CAVEAT (documented, mirrors CoinOffering):
        // Payment tokens are governance-whitelisted via the parity key, so the
        // standard-ERC20 (no fee-on-transfer) invariant is enforced socially at
        // registration time. If a fee-on-transfer token WERE whitelisted, the
        // treasury would receive less than `paymentAmount` while the buyer is
        // credited (and minted ATN for) the full `paymentAmount` — the vault does
        // not measure received balances. Do not whitelist fee-on-transfer tokens.
        it("documents the fee-on-transfer caveat: credited amount == requested amount", async function () {
            // With a well-behaved token the treasury receives exactly what was
            // credited; this asserts the no-fee invariant the whitelist relies on.
            const registryAddr = await registry.getAddress();
            const pay = ethers.parseUnits("77", USDC_DECIMALS);
            await (await vault.connect(buyer).buy(await usdc.getAddress(), pay)).wait();
            expect(await usdc.balanceOf(registryAddr)).to.equal(pay);
            expect(await vault.totalRaised(await usdc.getAddress())).to.equal(pay);
        });
    });

    // =========================================================================
    // QUOTE / PARITY VIEWS
    // =========================================================================

    describe("views", function () {
        it("getParity returns the registry value and 0 for unknown tokens", async function () {
            expect(await vault.getParity(await usdc.getAddress())).to.equal(PARITY);
            expect(await vault.getParity(attacker.address)).to.equal(0n);
        });

        it("quote returns 0 for unwhitelisted token or zero amount", async function () {
            expect(await vault.quote(attacker.address, 100n)).to.equal(0n);
            expect(await vault.quote(await usdc.getAddress(), 0)).to.equal(0n);
        });
    });

    // =========================================================================
    // PAUSE
    // =========================================================================

    describe("pause", function () {
        it("blocks buying while paused and resumes after unpause", async function () {
            await vault.connect(dao).pause();
            await expect(
                vault.connect(buyer).buy(await usdc.getAddress(), ethers.parseUnits("1", USDC_DECIMALS))
            ).to.be.revertedWithCustomError(vault, "EnforcedPause");

            await vault.connect(dao).unpause();
            await expect(
                vault.connect(buyer).buy(await usdc.getAddress(), ethers.parseUnits("1", USDC_DECIMALS))
            ).to.not.be.reverted;
        });

        it("only admin can pause", async function () {
            await expect(vault.connect(attacker).pause())
                .to.be.revertedWithCustomError(vault, "NotAdmin");
        });
    });

    // =========================================================================
    // ADMIN
    // =========================================================================

    describe("admin", function () {
        it("only admin can transfer admin", async function () {
            await expect(vault.connect(attacker).transferAdmin(attacker.address))
                .to.be.revertedWithCustomError(vault, "NotAdmin");
            await vault.connect(dao).transferAdmin(deployer.address);
            expect(await vault.admin()).to.equal(deployer.address);
        });

        it("rejects zero-address admin transfer", async function () {
            await expect(vault.connect(dao).transferAdmin(ethers.ZeroAddress))
                .to.be.revertedWithCustomError(vault, "ZeroAddress");
        });

        it("has NO sale-cap knob (uncapped by design)", async function () {
            // AutonetVault deliberately omits CoinOffering's setSaleCap/saleCap.
            expect(vault.setSaleCap).to.equal(undefined);
            expect(vault.saleCap).to.equal(undefined);
        });
    });

    // =========================================================================
    // CONSTRUCTOR GUARDS
    // =========================================================================

    describe("constructor", function () {
        it("reverts on zero addresses", async function () {
            const Vault = await ethers.getContractFactory("AutonetVault");
            const registryAddr = await registry.getAddress();
            const atnAddr = await atn.getAddress();

            await expect(
                Vault.deploy(ethers.ZeroAddress, registryAddr, dao.address)
            ).to.be.revertedWithCustomError(Vault, "ZeroAddress");
            await expect(
                Vault.deploy(atnAddr, ethers.ZeroAddress, dao.address)
            ).to.be.revertedWithCustomError(Vault, "ZeroAddress");
            await expect(
                Vault.deploy(atnAddr, registryAddr, ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(Vault, "ZeroAddress");
        });
    });

    // =========================================================================
    // REENTRANCY
    // =========================================================================

    describe("reentrancy guard", function () {
        it("buy is nonReentrant (guard present and effective)", async function () {
            const Reenter = await ethers.getContractFactory("ReentrantPaymentToken");
            const evil = await Reenter.deploy(await vault.getAddress());
            const evilAddr = await evil.getAddress();

            await registry.connect(dao).editRegistry(parityKey(evilAddr), PARITY.toString());

            await evil.mintTo(buyer.address, ethers.parseUnits("100", USDC_DECIMALS));
            await evil.connect(buyer).approve(await vault.getAddress(), ethers.MaxUint256);
            await evil.armReentrancy(await usdc.getAddress());

            // The reentrant call inside transferFrom must bubble up as a guard revert.
            await expect(
                vault.connect(buyer).buy(evilAddr, ethers.parseUnits("10", USDC_DECIMALS))
            ).to.be.reverted;
        });
    });
});
