const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Tests for the rolling-window treasury-spend guard added to Registry.sol.
// Covers: under-cap passes, over-cap reverts, window resets after duration,
// disburseEarmarked is also metered, ETH path is metered, and the cap setter
// is owner-only. Default-open (cap == 0) behavior is also verified.
describe("Registry treasury-spend guard (rolling-window cap)", function () {
    let registry, token;
    let owner, wrapper, jurisdiction, recipient, attacker;

    const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    const WINDOW = 7 * 24 * 60 * 60; // default windowDuration = 7 days
    const CAP = ethers.parseUnits("100", 18); // 100 tokens per window
    const FUND = ethers.parseUnits("1000000", 18); // registry token balance

    beforeEach(async function () {
        [owner, wrapper, jurisdiction, recipient, attacker] = await ethers.getSigners();

        const RegistryFactory = await ethers.getContractFactory("Registry");
        // owner == DAO/Timelock stand-in; wrapper is the second arg.
        registry = await RegistryFactory.deploy(owner.address, wrapper.address);

        const TokenFactory = await ethers.getContractFactory("TestToken");
        token = await TokenFactory.deploy(); // mints 1,000,000 * 1e18 to deployer (owner)

        // Fund the treasury with ERC20 and ETH.
        await token.connect(owner).transfer(await registry.getAddress(), FUND);
        await owner.sendTransaction({
            to: await registry.getAddress(),
            value: ethers.parseEther("100"),
        });
    });

    describe("setters", function () {
        it("setSpendCap is owner-only and updates the cap", async function () {
            const tokenAddr = await token.getAddress();

            await expect(
                registry.connect(attacker).setSpendCap(tokenAddr, CAP)
            ).to.be.revertedWith("Only the DAO can make transfers");

            await expect(registry.connect(owner).setSpendCap(tokenAddr, CAP))
                .to.emit(registry, "SpendCapSet")
                .withArgs(tokenAddr, CAP);

            expect(await registry.maxPerWindow(tokenAddr)).to.equal(CAP);
        });

        it("setWindowDuration is owner-only and rejects zero", async function () {
            await expect(
                registry.connect(attacker).setWindowDuration(WINDOW)
            ).to.be.revertedWith("Only the DAO can make transfers");

            await expect(
                registry.connect(owner).setWindowDuration(0)
            ).to.be.revertedWith("Registry: window duration must be > 0");

            await registry.connect(owner).setWindowDuration(WINDOW * 2);
            expect(await registry.windowDuration()).to.equal(WINDOW * 2);
        });
    });

    describe("transferERC20 metering", function () {
        beforeEach(async function () {
            await registry.connect(owner).setSpendCap(await token.getAddress(), CAP);
        });

        it("unmetered when cap == 0 (default-open preserves prior behavior)", async function () {
            const TokenFactory = await ethers.getContractFactory("TestToken");
            const token2 = await TokenFactory.deploy();
            await token2.connect(owner).transfer(await registry.getAddress(), FUND);

            // No cap set on token2 -> should allow an arbitrarily large transfer.
            await expect(
                registry.connect(owner).transferERC20(
                    await token2.getAddress(),
                    recipient.address,
                    ethers.parseUnits("500000", 18)
                )
            ).to.not.be.reverted;
        });

        it("under-cap passes (including exactly at cap)", async function () {
            const tokenAddr = await token.getAddress();

            await registry.connect(owner).transferERC20(tokenAddr, recipient.address, ethers.parseUnits("60", 18));
            // brings the running total to exactly CAP (100)
            await registry.connect(owner).transferERC20(tokenAddr, recipient.address, ethers.parseUnits("40", 18));

            expect(await registry.spentInWindow(tokenAddr)).to.equal(CAP);
            expect(await registry.remainingInWindow(tokenAddr)).to.equal(0n);
            expect(await token.balanceOf(recipient.address)).to.equal(CAP);
        });

        it("over-cap reverts", async function () {
            const tokenAddr = await token.getAddress();

            await registry.connect(owner).transferERC20(tokenAddr, recipient.address, ethers.parseUnits("80", 18));

            // 80 + 21 = 101 > 100 -> revert
            await expect(
                registry.connect(owner).transferERC20(tokenAddr, recipient.address, ethers.parseUnits("21", 18))
            ).to.be.revertedWith("Registry: spend exceeds rolling-window cap");

            // single over-cap transfer also reverts
            await expect(
                registry.connect(owner).transferERC20(tokenAddr, recipient.address, ethers.parseUnits("101", 18))
            ).to.be.revertedWith("Registry: spend exceeds rolling-window cap");
        });

        it("window resets after duration elapses", async function () {
            const tokenAddr = await token.getAddress();

            // Spend the full cap in window 1.
            await registry.connect(owner).transferERC20(tokenAddr, recipient.address, CAP);
            await expect(
                registry.connect(owner).transferERC20(tokenAddr, recipient.address, 1n)
            ).to.be.revertedWith("Registry: spend exceeds rolling-window cap");

            // Advance time beyond the window.
            await time.increase(WINDOW + 1);

            // remainingInWindow view should now show the full cap again.
            expect(await registry.remainingInWindow(tokenAddr)).to.equal(CAP);

            // A fresh full-cap spend now succeeds (window rolled forward).
            await expect(
                registry.connect(owner).transferERC20(tokenAddr, recipient.address, CAP)
            ).to.emit(registry, "SpendWindowReset");

            expect(await registry.spentInWindow(tokenAddr)).to.equal(CAP);
            expect(await token.balanceOf(recipient.address)).to.equal(CAP * 2n);
        });
    });

    describe("transferETH metering", function () {
        it("meters native ETH under the NATIVE_TOKEN sentinel", async function () {
            const ethCap = ethers.parseEther("10");
            await registry.connect(owner).setSpendCap(NATIVE_TOKEN, ethCap);

            await registry.connect(owner).transferETH(recipient.address, ethers.parseEther("6"));

            // 6 + 5 = 11 > 10 -> revert
            await expect(
                registry.connect(owner).transferETH(recipient.address, ethers.parseEther("5"))
            ).to.be.revertedWith("Registry: spend exceeds rolling-window cap");

            // under remaining cap (4) passes
            await expect(
                registry.connect(owner).transferETH(recipient.address, ethers.parseEther("4"))
            ).to.not.be.reverted;

            expect(await registry.spentInWindow(NATIVE_TOKEN)).to.equal(ethCap);
        });
    });

    describe("disburseEarmarked metering (epoch-reward bypass path)", function () {
        beforeEach(async function () {
            // Point the jurisdiction at a signer so we can call disburseEarmarked.
            // setJurisdictionAddress is _regedit (owner or wrapper).
            await registry.connect(owner).setJurisdictionAddress(jurisdiction.address);
            await registry.connect(owner).setSpendCap(await token.getAddress(), CAP);
        });

        it("disburseEarmarked is also metered and reverts over-cap", async function () {
            const tokenAddr = await token.getAddress();
            const purpose = ethers.keccak256(ethers.toUtf8Bytes("EPOCH_REWARD_1"));

            // Earmark enough to attempt to overshoot the cap.
            await registry.connect(owner).earmarkFunds(purpose, ethers.parseUnits("200", 18), tokenAddr);

            // First disburse under cap.
            await registry.connect(jurisdiction).disburseEarmarked(
                recipient.address, ethers.parseUnits("70", 18), purpose, tokenAddr
            );
            expect(await registry.spentInWindow(tokenAddr)).to.equal(ethers.parseUnits("70", 18));

            // 70 + 40 = 110 > 100 -> capped even though funds are earmarked & available.
            await expect(
                registry.connect(jurisdiction).disburseEarmarked(
                    recipient.address, ethers.parseUnits("40", 18), purpose, tokenAddr
                )
            ).to.be.revertedWith("Registry: spend exceeds rolling-window cap");
        });

        it("transferERC20 and disburseEarmarked share the same per-token window", async function () {
            const tokenAddr = await token.getAddress();
            const purpose = ethers.keccak256(ethers.toUtf8Bytes("EPOCH_REWARD_2"));
            await registry.connect(owner).earmarkFunds(purpose, ethers.parseUnits("200", 18), tokenAddr);

            // Spend 80 via direct transfer.
            await registry.connect(owner).transferERC20(tokenAddr, recipient.address, ethers.parseUnits("80", 18));

            // Now only 20 remains in the shared window; a 30 disburse must revert.
            await expect(
                registry.connect(jurisdiction).disburseEarmarked(
                    recipient.address, ethers.parseUnits("30", 18), purpose, tokenAddr
                )
            ).to.be.revertedWith("Registry: spend exceeds rolling-window cap");

            // 20 disburse fits exactly.
            await registry.connect(jurisdiction).disburseEarmarked(
                recipient.address, ethers.parseUnits("20", 18), purpose, tokenAddr
            );
            expect(await registry.spentInWindow(tokenAddr)).to.equal(CAP);
        });
    });
});
