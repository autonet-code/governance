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

const { autonet, mintLeaf, submitAnchor } = require("./helpers/autonet");

describe("Autonet integration (real Substrate, ServiceMarket, CharterAnchor)", function () {
    let deployer, member, buyer, agent, outsider;
    let registry, repToken, dao, timelockAddr, registryAddr, repTokenAddr;
    let substrate, vault, repClaim, usdc, channel, charter;

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

    before(async function () {
        [deployer, member, buyer, agent, outsider] = await ethers.getSigners();

        const deploy = async (name, ...args) => (await ethers.getContractFactory(name)).deploy(...args);
        const nativeImpl = await deploy("NativeProject");
        const erc20Impl = await deploy("ERC20Project");
        const trustlessFactory = await deploy("TrustlessFactory",
            await (await deploy("InfrastructureFactory")).getAddress(),
            await (await deploy("DAOFactory")).getAddress(),
            await (await deploy("EconomyFactory")).getAddress(),
            await (await deploy("RepTokenFactory")).getAddress());

        // Test-network timing: no voting delay, 2 minute vote, no timelock delay
        const infra = (await (await trustlessFactory.deployInfrastructure(0, 250)).wait())
            .logs.find((l) => l.eventName === "InfrastructureDeployed").args;
        registryAddr = infra.registry;
        timelockAddr = infra.timelock;
        const tok = (await (await trustlessFactory.deployDAOToken(registryAddr, timelockAddr,
            { name: "Autonet Rep", symbol: "AREP", initialMembers: [member.address], initialAmounts: [ethers.parseEther("1000")] },
            { name: "Autonet DAO", votingDelay: 0, votingPeriod: 2, proposalThreshold: ethers.parseEther("10"), quorumFraction: 4 }
        )).wait()).logs.find((l) => l.eventName === "DAOTokenDeployed").args;
        repTokenAddr = tok.repToken;
        await trustlessFactory.configureAndFinalize(
            { implAddresses: [await nativeImpl.getAddress(), await erc20Impl.getAddress()],
              contractAddresses: [infra.economy, registryAddr, timelockAddr, repTokenAddr, tok.dao] },
            { arbitrationFeeBps: 250, initialPlatformFeeBps: 250, initialAuthorFeeBps: 500, initialCoolingOffPeriod: 60,
              initialBackersQuorumBps: 5100, initialProjectThreshold: 0, initialAppealPeriod: 120 },
            [], []);

        registry = await ethers.getContractAt("Registry", registryAddr);
        repToken = await ethers.getContractAt("RepToken", repTokenAddr);
        dao = await ethers.getContractAt("HomebaseDAO", tok.dao);
        await repToken.connect(member).delegate(agent.address);
        usdc = await deploy("TestERC20", "USD Coin", "USDC", 6, 0);
    });

    it("deploys the Substrate against the predicted vault address and the jurisdiction's treasury and timelock", async function () {
        const nonce = await ethers.provider.getTransactionCount(deployer.address);
        const predictedVault = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
        // Anchors need signatures carrying more than half of the REP votes; no genesis set (REP exists)
        substrate = await autonet("Substrate", deployer).deploy(registryAddr, predictedVault, timelockAddr, repTokenAddr, 5000, [], 0);
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
        // Bought ATN is money, not earnings: no REP claim (and the buyer is no agent)
        expect(await repClaim.earningsBase(buyer.address)).to.equal(0);
        await expect(repClaim.claim(buyer.address)).to.be.revertedWithCustomError(repClaim, "NotAgent");
    });

    it("splits the service fee: half to the Registry, half burned, net to the provider", async function () {
        await substrate.connect(agent).registerAgent(ethers.id("agent-lineage"), "0x1234");
        const supplyBefore = await substrate.atnTotalSupply();
        await substrate.connect(buyer).payForService(agent.address, ATN(100), ethers.id("req-1"));

        // 2.5% fee: 1.25 ATN to the treasury, 1.25 ATN burned
        expect(await substrate.balanceOf(agent.address)).to.equal(ATN(97.5));
        expect(await substrate.balanceOf(registryAddr)).to.equal(ATN(1.25));
        expect(await substrate.atnTotalSupply()).to.equal(supplyBefore - ATN(1.25));
        expect(await substrate.serviceEarnings(agent.address)).to.equal(ATN(97.5));
    });

    it("turns service earnings into voting REP 1:1 in whole tokens", async function () {
        await repClaim.claim(agent.address);
        expect(await repToken.balanceOf(agent.address)).to.equal(ethers.parseEther("97.5"));
        // Claiming made the agent its own delegate: its own 97.5 plus the member's delegated 1000
        expect(await repToken.delegates(agent.address)).to.equal(agent.address);
        expect(await repToken.getVotes(agent.address)).to.equal(ethers.parseEther("1097.5"));
    });

    it("rejects anchors that lack a REP majority, whoever signs or relays them", async function () {
        // An outsider registers and signs: no REP behind it
        await substrate.connect(outsider).registerAgent(ethers.id("outsider"), "0x99");
        await expect(submitAnchor(substrate, [outsider], "fake", mintLeaf(outsider.address, ATN(1_000_000)), outsider))
            .to.be.revertedWithCustomError(substrate, "AnchorQuorumNotMet");
    });

    it("turns anchored tool-pool earnings into REP, capped at the fees burned in the previous window", async function () {
        // The 1.25 ATN burned by the service payment is the first window; the next anchor's pool
        await submitAnchor(substrate, [agent], "epoch-0", ethers.ZeroHash, outsider);
        await submitAnchor(substrate, [agent], "epoch-1", mintLeaf(agent.address, ATN(1)), outsider);
        await substrate.connect(agent).recordTrainingForEpoch(ATN(1), ethers.id("epoch-1"), []);
        expect(await substrate.agentMintTotal(agent.address)).to.equal(ATN(1));

        await repClaim.claim(agent.address);
        expect(await repToken.balanceOf(agent.address)).to.equal(ethers.parseEther("98.5"));
    });

    it("refuses to mint more than the epoch's pool even when the signed root allows it", async function () {
        // No fees burned since epoch-1, so epoch-2's pool is empty
        await submitAnchor(substrate, [agent], "epoch-2", mintLeaf(agent.address, ATN(1)), outsider);
        await expect(substrate.connect(agent).recordTrainingForEpoch(ATN(1), ethers.id("epoch-2"), []))
            .to.be.revertedWithCustomError(substrate, "EpochPoolExceeded");
    });

    it("lets the DAO retune the Substrate service fee, and only the DAO", async function () {
        await expect(substrate.connect(member).setServiceFeeBps(500)).to.be.revertedWithCustomError(substrate, "NotGovernor");
        await govern([await substrate.getAddress()], [substrate.interface.encodeFunctionData("setServiceFeeBps", [500])], "Service fee to 5%");
        expect(await substrate.serviceFeeBps()).to.equal(500);
    });

    it("settles payment channels through payForService, so channel income also earns REP", async function () {
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

    it("anchors the genesis charter at deploy and later versions only through a DAO proposal", async function () {
        const v1 = ethers.id("charter v1");
        charter = await autonet("CharterAnchor", deployer).deploy(timelockAddr, v1, "ipfs://charter-v1");
        expect((await charter.currentCharter()).hash).to.equal(v1);
        const v2 = ethers.id("charter v2");
        await expect(charter.connect(member).anchorCharter(v2, "ipfs://charter-v2")).to.be.revertedWithCustomError(charter, "NotGovernor");
        await govern([await charter.getAddress()], [charter.interface.encodeFunctionData("anchorCharter", [v2, "ipfs://charter-v2"])], "Anchor charter v2");
        const current = await charter.currentCharter();
        expect(current.version).to.equal(2n);
        expect(current.hash).to.equal(v2);
    });

    it("lets the DAO pause the vault", async function () {
        await govern([await vault.getAddress()], [vault.interface.encodeFunctionData("pause")], "Pause vault");
        await usdc.mint(buyer.address, USDC(1));
        await usdc.connect(buyer).approve(await vault.getAddress(), USDC(1));
        await expect(vault.connect(buyer).buy(await usdc.getAddress(), USDC(1))).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });
});
