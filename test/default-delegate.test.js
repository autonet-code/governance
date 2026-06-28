const { expect } = require("chai");
const { ethers } = require("hardhat");

// Tests the suite-level defaultDelegate feature on RepToken:
//   - auto-delegates on first receipt when a default is set and the recipient
//     has no delegate of their own,
//   - a holder's own delegate() call wins and is never auto-reset on later receipts,
//   - disabled (no-op) when defaultDelegate == address(0),
//   - only admin/timelock can set it,
//   - the default delegate itself is not redundantly self-delegated.
describe("RepToken defaultDelegate", function () {
    let registry, repToken, timelock;
    let deployer, execDelegate, buyer, other;

    beforeEach(async function () {
        [deployer, timelock, execDelegate, buyer, other] = await ethers.getSigners();

        const RegistryFactory = await ethers.getContractFactory("Registry");
        registry = await RegistryFactory.deploy(timelock.address, deployer.address);

        const RepTokenFactory = await ethers.getContractFactory("RepToken");
        // transferable = true so we can exercise both mint-receipt and transfer-receipt paths.
        repToken = await RepTokenFactory.deploy(
            "Autonet Boats", "ATNB",
            await registry.getAddress(), timelock.address,
            [], [], true
        );
        // admin -> timelock, matching the production wiring.
        await repToken.connect(deployer).setAdmin(timelock.address);
    });

    it("starts disabled (defaultDelegate == address(0)) and does not auto-delegate", async function () {
        await repToken.connect(timelock).mint(buyer.address, ethers.parseEther("100"));
        expect(await repToken.delegates(buyer.address)).to.equal(ethers.ZeroAddress);
        // No delegate => no active voting power despite holding balance.
        expect(await repToken.getVotes(execDelegate.address)).to.equal(0n);
    });

    it("only admin/timelock can set the default delegate", async function () {
        await expect(
            repToken.connect(other).setDefaultDelegate(execDelegate.address)
        ).to.be.revertedWith("RepToken: Caller is not the admin or Timelock");

        await expect(repToken.connect(timelock).setDefaultDelegate(execDelegate.address))
            .to.emit(repToken, "DefaultDelegateUpdated")
            .withArgs(ethers.ZeroAddress, execDelegate.address);
        expect(await repToken.defaultDelegate()).to.equal(execDelegate.address);
    });

    it("auto-delegates a buyer to the default delegate on first receipt (mint)", async function () {
        await repToken.connect(timelock).setDefaultDelegate(execDelegate.address);

        await expect(repToken.connect(timelock).mint(buyer.address, ethers.parseEther("100")))
            .to.emit(repToken, "AutoDelegated")
            .withArgs(buyer.address, execDelegate.address);

        expect(await repToken.delegates(buyer.address)).to.equal(execDelegate.address);
        // The execution delegate now controls the buyer's voting weight.
        expect(await repToken.getVotes(execDelegate.address)).to.equal(ethers.parseEther("100"));
        expect(await repToken.getVotes(buyer.address)).to.equal(0n);
    });

    it("auto-delegates on a transfer receipt too, not only on mint", async function () {
        await repToken.connect(timelock).setDefaultDelegate(execDelegate.address);
        // Seed `other` first (also auto-delegated), then transfer to a fresh buyer.
        await repToken.connect(timelock).mint(other.address, ethers.parseEther("50"));
        await repToken.connect(other).transfer(buyer.address, ethers.parseEther("20"));

        expect(await repToken.delegates(buyer.address)).to.equal(execDelegate.address);
        expect(await repToken.getVotes(execDelegate.address)).to.equal(ethers.parseEther("50"));
    });

    it("a holder who self-delegates is never auto-reset on later receipts", async function () {
        await repToken.connect(timelock).setDefaultDelegate(execDelegate.address);

        // Buyer reclaims their vote (the werule.io flow) BEFORE holding anything.
        await repToken.connect(buyer).delegate(buyer.address);
        expect(await repToken.delegates(buyer.address)).to.equal(buyer.address);

        // A subsequent receipt must NOT override their explicit choice.
        await expect(repToken.connect(timelock).mint(buyer.address, ethers.parseEther("100")))
            .to.not.emit(repToken, "AutoDelegated");
        expect(await repToken.delegates(buyer.address)).to.equal(buyer.address);
        expect(await repToken.getVotes(buyer.address)).to.equal(ethers.parseEther("100"));
        expect(await repToken.getVotes(execDelegate.address)).to.equal(0n);
    });

    it("buyer can reclaim their vote AFTER being auto-delegated", async function () {
        await repToken.connect(timelock).setDefaultDelegate(execDelegate.address);
        await repToken.connect(timelock).mint(buyer.address, ethers.parseEther("100"));
        expect(await repToken.delegates(buyer.address)).to.equal(execDelegate.address);

        // werule.io: holder takes their vote back.
        await repToken.connect(buyer).delegate(buyer.address);
        expect(await repToken.delegates(buyer.address)).to.equal(buyer.address);
        expect(await repToken.getVotes(buyer.address)).to.equal(ethers.parseEther("100"));
        expect(await repToken.getVotes(execDelegate.address)).to.equal(0n);
    });

    it("does not redundantly self-delegate the default delegate itself", async function () {
        await repToken.connect(timelock).setDefaultDelegate(execDelegate.address);
        // Minting to the default delegate must not emit AutoDelegated (skipped by design).
        await expect(repToken.connect(timelock).mint(execDelegate.address, ethers.parseEther("10")))
            .to.not.emit(repToken, "AutoDelegated");
        // Its delegate remains unset unless it self-delegates explicitly.
        expect(await repToken.delegates(execDelegate.address)).to.equal(ethers.ZeroAddress);
    });

    it("does not auto-delegate an exempt account (inventory-holding contract)", async function () {
        await repToken.connect(timelock).setDefaultDelegate(execDelegate.address);
        // Mark `other` exempt (stands in for a CO/treasury holding unsold float).
        await expect(repToken.connect(timelock).setAutoDelegateExempt(other.address, true))
            .to.emit(repToken, "AutoDelegateExemptSet")
            .withArgs(other.address, true);

        await expect(repToken.connect(timelock).mint(other.address, ethers.parseEther("1000000")))
            .to.not.emit(repToken, "AutoDelegated");
        // Exempt holder's float carries no votes for the default delegate.
        expect(await repToken.delegates(other.address)).to.equal(ethers.ZeroAddress);
        expect(await repToken.getVotes(execDelegate.address)).to.equal(0n);

        // But tokens it SENDS to a normal buyer DO auto-delegate that buyer.
        await repToken.connect(other).transfer(buyer.address, ethers.parseEther("100"));
        expect(await repToken.delegates(buyer.address)).to.equal(execDelegate.address);
        expect(await repToken.getVotes(execDelegate.address)).to.equal(ethers.parseEther("100"));
    });

    it("only admin/timelock can set auto-delegate exemption", async function () {
        await expect(
            repToken.connect(other).setAutoDelegateExempt(other.address, true)
        ).to.be.revertedWith("RepToken: Caller is not the admin or Timelock");
    });

    it("turning the feature off (address(0)) stops future auto-delegation", async function () {
        await repToken.connect(timelock).setDefaultDelegate(execDelegate.address);
        await repToken.connect(timelock).setDefaultDelegate(ethers.ZeroAddress);

        await expect(repToken.connect(timelock).mint(buyer.address, ethers.parseEther("100")))
            .to.not.emit(repToken, "AutoDelegated");
        expect(await repToken.delegates(buyer.address)).to.equal(ethers.ZeroAddress);
    });
});
