const { expect } = require("chai");
const { ethers } = require("hardhat");

// AutonetRepClaim: REP as pull claims on autonet earnings (docs/tool_substrate.md
// "Decision (2026-07-10): fees-only emission + REP-from-earnings"). Reads the two
// cumulative ATN-base earnings ledgers on Substrate (agentMintTotal +
// serviceEarnings), mints the watermarked delta to the AGENT 1:1 in whole-token
// terms (ATN base 1e6 -> REP 1e18, so x1e12). Hardcoded rate, no knob, no admin.
describe("AutonetRepClaim", function () {
    let claim, substrate, repToken, registry;
    let deployer, timelock, agentA, agentB, stranger, gen1, gen2;

    // ATN base unit -> REP scaling: 1 ATN (1e6 base) == 1 whole REP (1e18).
    const REP_PER_ATN_BASE = 10n ** 12n;
    const ONE_ATN = 1_000_000n; // 1e6 base units

    async function deployRepToken() {
        const Registry = await ethers.getContractFactory("Registry");
        registry = await Registry.deploy(timelock.address, deployer.address);
        const RepToken = await ethers.getContractFactory("RepToken");
        // transferable=false (Economy-DAO convention), no initial members.
        return RepToken.deploy(
            "Jurisdiction Token", "JUR",
            await registry.getAddress(), timelock.address,
            [], [], false
        );
    }

    // Deploy an AutonetRepClaim, granting it minter rights BEFORE construction so
    // any genesis mint in its constructor can succeed. We predict the create
    // address from the deployer nonce and setMinter it first.
    async function deployClaim(genesisHolders, genesisAmounts) {
        const nonce = await ethers.provider.getTransactionCount(deployer.address);
        const predicted = ethers.getCreateAddress({ from: deployer.address, nonce });
        // Grant minter to the predicted address first (timelock-gated in prod;
        // here the timelock signer performs it directly).
        await repToken.connect(timelock).setMinter(predicted, true);
        const Claim = await ethers.getContractFactory("AutonetRepClaim");
        const c = await Claim.connect(deployer).deploy(
            await substrate.getAddress(),
            await repToken.getAddress(),
            genesisHolders,
            genesisAmounts
        );
        expect(await c.getAddress()).to.equal(predicted);
        return c;
    }

    beforeEach(async function () {
        [deployer, timelock, agentA, agentB, stranger, gen1, gen2] =
            await ethers.getSigners();

        const MockSubstrate = await ethers.getContractFactory("MockSubstrateEarnings");
        substrate = await MockSubstrate.deploy();

        repToken = await deployRepToken();

        // Default: no genesis seed. setMinter happens inside deployClaim.
        claim = await deployClaim([], []);
    });

    it("wires immutables and exposes the decimal-scaling constant", async function () {
        expect(await claim.substrate()).to.equal(await substrate.getAddress());
        expect(await claim.repToken()).to.equal(await repToken.getAddress());
        expect(await claim.REP_PER_ATN_BASE()).to.equal(REP_PER_ATN_BASE);
        expect(await repToken.decimals()).to.equal(18n);
    });

    it("claims tool-pool earnings, scaling ATN base 1e6 -> REP 1e18 (x1e12)", async function () {
        // Agent earned 5 ATN of tool-pool distributions.
        await substrate.setAgentMintTotal(agentA.address, 5n * ONE_ATN);

        const expectedRep = 5n * ONE_ATN * REP_PER_ATN_BASE; // == 5e18
        expect(await claim.claimable(agentA.address)).to.equal(expectedRep);

        await expect(claim.claim(agentA.address))
            .to.emit(claim, "RepClaimed")
            .withArgs(agentA.address, 5n * ONE_ATN, expectedRep);

        expect(await repToken.balanceOf(agentA.address)).to.equal(expectedRep);
        expect(await repToken.balanceOf(agentA.address)).to.equal(ethers.parseEther("5"));
        expect(await claim.claimedEarnings(agentA.address)).to.equal(5n * ONE_ATN);
    });

    it("sums tool-pool and service earnings as the claim base", async function () {
        await substrate.setAgentMintTotal(agentA.address, 3n * ONE_ATN);
        await substrate.setServiceEarnings(agentA.address, 7n * ONE_ATN);

        const expectedRep = 10n * ONE_ATN * REP_PER_ATN_BASE; // 10 ATN -> 10 REP
        expect(await claim.earningsBase(agentA.address)).to.equal(10n * ONE_ATN);
        await claim.claim(agentA.address);
        expect(await repToken.balanceOf(agentA.address)).to.equal(expectedRep);
    });

    it("scales sub-ATN earnings exactly (no truncation)", async function () {
        // 0.5 ATN = 500_000 base -> 0.5e18 REP.
        await substrate.setServiceEarnings(agentA.address, 500_000n);
        await claim.claim(agentA.address);
        expect(await repToken.balanceOf(agentA.address)).to.equal(ethers.parseEther("0.5"));
    });

    it("watermark idempotency: a second claim with no new earnings mints nothing", async function () {
        await substrate.setAgentMintTotal(agentA.address, 4n * ONE_ATN);
        await claim.claim(agentA.address);
        expect(await repToken.balanceOf(agentA.address)).to.equal(ethers.parseEther("4"));

        // No new earnings -> claimable zero, claim reverts.
        expect(await claim.claimable(agentA.address)).to.equal(0);
        await expect(claim.claim(agentA.address))
            .to.be.revertedWithCustomError(claim, "NothingToClaim");
        // Balance unchanged.
        expect(await repToken.balanceOf(agentA.address)).to.equal(ethers.parseEther("4"));
    });

    it("earnings added between claims mint exactly the delta", async function () {
        await substrate.setAgentMintTotal(agentA.address, 2n * ONE_ATN);
        await claim.claim(agentA.address);
        expect(await repToken.balanceOf(agentA.address)).to.equal(ethers.parseEther("2"));

        // +3 tool-pool, +1 service = +4 ATN delta.
        await substrate.setAgentMintTotal(agentA.address, 5n * ONE_ATN);
        await substrate.setServiceEarnings(agentA.address, 1n * ONE_ATN);

        await expect(claim.claim(agentA.address))
            .to.emit(claim, "RepClaimed")
            .withArgs(agentA.address, 4n * ONE_ATN, 4n * ONE_ATN * REP_PER_ATN_BASE);
        // Total REP now 2 + 4 = 6.
        expect(await repToken.balanceOf(agentA.address)).to.equal(ethers.parseEther("6"));
        expect(await claim.claimedEarnings(agentA.address)).to.equal(6n * ONE_ATN);
    });

    it("permissionless trigger: anyone claims FOR an agent, REP mints to the agent", async function () {
        await substrate.setServiceEarnings(agentA.address, 9n * ONE_ATN);
        // stranger triggers; REP mints to agentA, not stranger.
        await claim.connect(stranger).claim(agentA.address);
        expect(await repToken.balanceOf(agentA.address)).to.equal(ethers.parseEther("9"));
        expect(await repToken.balanceOf(stranger.address)).to.equal(0);
    });

    it("agents claim independently (separate watermarks)", async function () {
        await substrate.setAgentMintTotal(agentA.address, 11n * ONE_ATN);
        await substrate.setServiceEarnings(agentB.address, 22n * ONE_ATN);
        await claim.claim(agentA.address);
        await claim.claim(agentB.address);
        expect(await repToken.balanceOf(agentA.address)).to.equal(ethers.parseEther("11"));
        expect(await repToken.balanceOf(agentB.address)).to.equal(ethers.parseEther("22"));
    });

    it("pure spenders/buyers (no earnings) claim NOTHING", async function () {
        // agentB never appears in either earnings ledger.
        expect(await claim.claimable(agentB.address)).to.equal(0);
        await expect(claim.claim(agentB.address))
            .to.be.revertedWithCustomError(claim, "NothingToClaim");
    });

    it("reverts a claim for the zero agent", async function () {
        await expect(claim.claim(ethers.ZeroAddress))
            .to.be.revertedWithCustomError(claim, "ZeroAddress");
    });

    it("mints the genesis REP seed at deploy (visible on-chain)", async function () {
        const holders = [gen1.address, gen2.address];
        const amounts = [ethers.parseEther("1000"), ethers.parseEther("500")];
        const seeded = await deployClaim(holders, amounts);
        expect(await seeded.getAddress()).to.properAddress;
        expect(await repToken.balanceOf(gen1.address)).to.equal(ethers.parseEther("1000"));
        expect(await repToken.balanceOf(gen2.address)).to.equal(ethers.parseEther("500"));
    });

    it("genesis: rejects length mismatch and zero holder", async function () {
        const Claim = await ethers.getContractFactory("AutonetRepClaim");
        await expect(
            Claim.connect(deployer).deploy(
                await substrate.getAddress(), await repToken.getAddress(),
                [gen1.address], [ethers.parseEther("1"), ethers.parseEther("2")]
            )
        ).to.be.revertedWithCustomError(Claim, "LengthMismatch");

        // Zero holder: must grant minter to predicted addr first so we reach the
        // constructor loop (not the minter gate).
        const nonce = await ethers.provider.getTransactionCount(deployer.address);
        const predicted = ethers.getCreateAddress({ from: deployer.address, nonce });
        await repToken.connect(timelock).setMinter(predicted, true);
        await expect(
            Claim.connect(deployer).deploy(
                await substrate.getAddress(), await repToken.getAddress(),
                [ethers.ZeroAddress], [ethers.parseEther("1")]
            )
        ).to.be.revertedWithCustomError(Claim, "ZeroAddress");
    });

    it("unauthorized-mint impossible without a minter grant", async function () {
        // Deploy a claim WITHOUT granting minter rights (empty genesis so the
        // constructor doesn't need to mint), then a claim() must revert on the
        // RepToken minter gate.
        const Claim = await ethers.getContractFactory("AutonetRepClaim");
        const ungranted = await Claim.connect(deployer).deploy(
            await substrate.getAddress(), await repToken.getAddress(), [], []
        );
        await substrate.setServiceEarnings(agentA.address, 3n * ONE_ATN);
        await expect(ungranted.claim(agentA.address))
            .to.be.revertedWith("RepToken: Not authorized to mint");
        expect(await repToken.balanceOf(agentA.address)).to.equal(0);
    });
});
