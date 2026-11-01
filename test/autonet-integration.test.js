const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// A jurisdiction wired to the real autonet core contracts (test/fixtures/autonet, refreshed with
// scripts/sync-autonet-artifacts.js). Follows scripts/deploy-autonet-jurisdiction.js: jurisdiction
// suite -> Substrate (treasury = Registry, vaultMinter = the predicted AutonetVault, governor =
// timelock, anchors signed by REP weight) -> AutonetVault -> AutonetRepClaim -> minter grant by
// proposal. The member delegates to the agent, so the agent's signature carries the REP majority
// that anchors need (and the agent votes the member's weight in governance). The tests share state
// and run in order.

const { autonet, mintLeaf, anchorArgs, registerAgent } = require("./helpers/autonet");
const { createJurisdiction } = require("./helpers/jurisdiction");

describe("Autonet integration (real Substrate and ServiceMarket)", function () {
    let deployer, member, buyer, agent, outsider;
    let registry, repToken, dao, timelockAddr, registryAddr, repTokenAddr;
    let substrate, vault, repClaim, usdc, channel;

    const ATN = (n) => ethers.parseUnits(String(n), 6);
    const USDC = (n) => ethers.parseUnits(String(n), 6);
    // Jurisdiction parity: 1 USDC (6 dec) is worth 2 REP (18 dec), so it buys 2 ATN (6 dec)
    const PARITY = 2n * 10n ** 30n;

    async function govern(targets, calldatas, description) {
        const values = targets.map(() => 0);
        const rc = await (await dao.connect(agent).propose(targets, values, calldatas, description)).wait();
        const id = rc.logs.map((l) => { try { return dao.interface.parseLog(l); } catch { return null; } })
            .find((e) => e && e.name === "ProposalCreated").args.proposalId;
        await dao.connect(agent).castVote(id, 1);
        await time.increase(121);
        const descriptionHash = ethers.id(description);
        await dao.queue(targets, values, calldatas, descriptionHash);
        await dao.execute(targets, values, calldatas, descriptionHash);
        expect(await dao.state(id)).to.equal(7n); // Executed
    }

    // An epoch anchor is a DAO proposal: the agent, holding the member's delegated REP, decides it alone
    async function anchorByProposal(epochId, agentMintRoot = ethers.ZeroHash) {
        const call = substrate.interface.encodeFunctionData("anchor", await anchorArgs(substrate, epochId, agentMintRoot));
        await govern([await substrate.getAddress()], [call], `Anchor epoch ${epochId}`);
    }

    before(async function () {
        [deployer, member, buyer, agent, outsider] = await ethers.getSigners();

        const deploy = async (name, ...args) => (await ethers.getContractFactory(name)).deploy(...args);
        // Test-network timing: no voting delay, 2 minute vote, no timelock delay
        const j = await createJurisdiction(member, {
            name: "Autonet DAO", symbol: "AREP", members: [member.address], amounts: [ethers.parseEther("1000")],
            proposalThreshold: ethers.parseEther("10"),
        });
        registryAddr = j.core.registry;
        timelockAddr = j.core.timelock;
        repTokenAddr = j.core.token;
        const tok = { dao: j.core.governor };

        registry = await ethers.getContractAt("Registry", registryAddr);
        repToken = await ethers.getContractAt("RepToken", repTokenAddr);
        dao = await ethers.getContractAt("HomebaseDAO", tok.dao);
        await repToken.connect(member).delegate(agent.address);
        usdc = await deploy("TestERC20", "USD Coin", "USDC", 6, 0);
    });

    it("deploys the Substrate against the predicted vault address and the jurisdiction's treasury and timelock", async function () {
        const nonce = await ethers.provider.getTransactionCount(deployer.address);
        const predictedVault = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
        // Only the timelock anchors, so every anchor is a DAO proposal
        substrate = await autonet("Substrate", deployer).deploy(registryAddr, predictedVault, timelockAddr, ethers.ZeroAddress, ethers.ZeroHash, "Test ATN", "TSTATN");
        vault = await (await ethers.getContractFactory("AutonetVault")).deploy(await substrate.getAddress(), registryAddr, timelockAddr);

        expect(await vault.getAddress()).to.equal(predictedVault);
        expect(await substrate.vaultMinter()).to.equal(predictedVault);
        expect(await substrate.treasury()).to.equal(registryAddr);
        expect(await substrate.governor()).to.equal(timelockAddr);
    });

    it("grants AutonetRepClaim minter rights and whitelists the vault payment token in one proposal", async function () {
        repClaim = await (await ethers.getContractFactory("AutonetRepClaim")).deploy(await substrate.getAddress(), repTokenAddr, [], []);
        const parityKey = `jurisdiction.parity.${(await usdc.getAddress()).toLowerCase()}`;
        await govern(
            [repTokenAddr, registryAddr],
            [repToken.interface.encodeFunctionData("setMinter", [await repClaim.getAddress(), true]),
             registry.interface.encodeFunctionData("editRegistry", [parityKey, PARITY.toString()])],
            "Attach Autonet: REP claim minter, USDC parity");
        expect(await repToken.minters(await repClaim.getAddress())).to.equal(true);
    });

    it("sells ATN through the vault: payment to the Registry, ATN minted on the Substrate", async function () {
        await usdc.mint(buyer.address, USDC(500));
        await usdc.connect(buyer).approve(await vault.getAddress(), USDC(500));
        await vault.connect(buyer).buy(await usdc.getAddress(), USDC(500));

        expect(await substrate.balanceOf(buyer.address)).to.equal(ATN(1000));
        expect(await usdc.balanceOf(registryAddr)).to.equal(USDC(500));
        // Bought ATN is money, not earnings: no REP claim
        expect(await repClaim.earningsBase(buyer.address)).to.equal(0);
        await expect(repClaim.claim(buyer.address)).to.be.revertedWithCustomError(repClaim, "NothingToClaim");
    });

    it("splits the service fee: half to the Registry, half burned, net to the provider", async function () {
        await registerAgent(substrate, agent, "0x1234");
        const supplyBefore = await substrate.atnTotalSupply();
        await substrate.connect(buyer).payForService(agent.address, ATN(100), ethers.id("req-1"));

        // 2.5% fee: 1.25 ATN to the treasury, 1.25 ATN burned
        expect(await substrate.balanceOf(agent.address)).to.equal(ATN(97.5));
        expect(await substrate.balanceOf(registryAddr)).to.equal(ATN(1.25));
        expect(await substrate.atnTotalSupply()).to.equal(supplyBefore - ATN(1.25));
        expect(await substrate.serviceEarnings(agent.address)).to.equal(ATN(97.5));
    });

    it("service revenue earns no REP", async function () {
        expect(await repClaim.earningsBase(agent.address)).to.equal(0);
        await expect(repClaim.claim(agent.address)).to.be.revertedWithCustomError(repClaim, "NothingToClaim");
    });

    it("takes anchors only from the DAO timelock", async function () {
        await expect(substrate.connect(outsider).anchor(...(await anchorArgs(substrate, "fake", mintLeaf(outsider.address, ATN(1_000_000))))))
            .to.be.revertedWithCustomError(substrate, "NotGovernor");
    });

    it("turns anchored tool-pool earnings into REP, capped at the fees burned in the previous window", async function () {
        // The 1.25 ATN burned by the service payment is the first window; the next anchor's pool
        await anchorByProposal("epoch-0");
        await anchorByProposal("epoch-1", mintLeaf(agent.address, ATN(1)));
        await substrate.connect(outsider).claimFor(agent.address, ATN(1), ethers.id("epoch-1"), []);
        expect(await substrate.agentMintTotal(agent.address)).to.equal(ATN(1));

        await repClaim.claim(agent.address);
        expect(await repToken.balanceOf(agent.address)).to.equal(ethers.parseEther("1"));
        // The agent owns itself, so the REP is its own, and claiming made it its own delegate: its
        // 1 plus the member's delegated 1000
        expect(await repToken.delegates(agent.address)).to.equal(agent.address);
        expect(await repToken.getVotes(agent.address)).to.equal(ethers.parseEther("1001"));
    });

    it("refuses to mint more than the epoch's pool even when the signed root allows it", async function () {
        // No fees burned since epoch-1, so epoch-2's pool is empty
        await anchorByProposal("epoch-2", mintLeaf(agent.address, ATN(1)));
        await expect(substrate.claimFor(agent.address, ATN(1), ethers.id("epoch-2"), []))
            .to.be.revertedWithCustomError(substrate, "EpochPoolExceeded");
    });

    it("lets the DAO retune the Substrate service fee, and only the DAO", async function () {
        await expect(substrate.connect(member).setServiceFeeBps(500)).to.be.revertedWithCustomError(substrate, "NotGovernor");
        await govern([await substrate.getAddress()], [substrate.interface.encodeFunctionData("setServiceFeeBps", [500])], "Service fee to 5%");
        expect(await substrate.serviceFeeBps()).to.equal(500);
    });

    it("settles payment channels through payForService, so channel income counts as service revenue", async function () {
        channel = await autonet("PaymentChannel", deployer).deploy(await substrate.getAddress(), 3600);
        await substrate.connect(buyer).approve(await channel.getAddress(), ATN(40));
        await channel.connect(buyer).openChannel(agent.address, ATN(40));

        const domain = { name: "AutonetPaymentChannel", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await channel.getAddress() };
        const voucher = await buyer.signTypedData(domain, { Voucher: [{ name: "channelId", type: "uint256" }, { name: "cumulativeAmount", type: "uint256" }] },
            { channelId: 1, cumulativeAmount: ATN(20) });
        const earnedBefore = await substrate.serviceEarnings(agent.address);
        await channel.connect(agent).closeChannel(1, ATN(20), voucher);

        // 5% fee after the retune
        expect(await substrate.serviceEarnings(agent.address)).to.equal(earnedBefore + ATN(19));
        await time.increase(3601);
        const buyerBefore = await substrate.balanceOf(buyer.address);
        await channel.withdrawRemainder(1);
        expect(await substrate.balanceOf(buyer.address)).to.equal(buyerBefore + ATN(20));
    });

    it("changes the charter the daemons follow only through a DAO proposal", async function () {
        const v2 = '{"axes":[{"id":"correctness","thesis":"v2"},{"id":"simplicity","thesis":"v2"}]}';
        const edit = registry.interface.encodeFunctionData("editRegistry", ["jurisdiction.autonet.charter", v2]);
        await expect(registry.connect(member).editRegistry("jurisdiction.autonet.charter", v2)).to.be.reverted;
        await govern([registryAddr], [edit], "Charter v2");
        expect(await registry.getRegistryValue("jurisdiction.autonet.charter")).to.equal(v2);
    });

    it("lets the DAO pause the vault", async function () {
        await govern([await vault.getAddress()], [vault.interface.encodeFunctionData("pause")], "Pause vault");
        await usdc.mint(buyer.address, USDC(1));
        await usdc.connect(buyer).approve(await vault.getAddress(), USDC(1));
        await expect(vault.connect(buyer).buy(await usdc.getAddress(), USDC(1))).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });
});
