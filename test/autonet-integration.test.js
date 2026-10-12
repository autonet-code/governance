const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// A jurisdiction wired to the real autonet core contracts (test/fixtures/autonet, refreshed with
// scripts/sync-autonet-artifacts.js). Follows scripts/deploy-autonet-jurisdiction.js: jurisdiction
// suite -> Substrate (treasury = Registry, vaultMinter = the predicted AutonetVault, governor =
// timelock) -> AutonetVault -> AutonetRepClaim -> minter grant by proposal. The tests share state
// and run in order.

function autonet(name, signer) {
    const a = require(`./fixtures/autonet/${name}.json`);
    return new ethers.ContractFactory(a.abi, a.bytecode, signer);
}

// Single-leaf merkle tree: the root is the double-hashed leaf and the proof is empty.
function mintLeaf(agent, amount) {
    const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [agent, amount]));
    return ethers.keccak256(inner);
}

describe("Autonet integration (real Substrate, ServiceMarket, CharterAnchor)", function () {
    let deployer, member, buyer, agent;
    let registry, repToken, dao, timelockAddr, registryAddr, repTokenAddr;
    let substrate, vault, repClaim, usdc, channel, charter;

    const ATN = (n) => ethers.parseUnits(String(n), 6);
    const USDC = (n) => ethers.parseUnits(String(n), 6);
    // Vault parity: 1 USDC (6 dec) -> 2 ATN (6 dec)
    const PARITY = ethers.parseEther("2");

    async function govern(targets, calldatas, description) {
        const values = targets.map(() => 0);
        const rc = await (await dao.connect(member).propose(targets, values, calldatas, description)).wait();
        const id = rc.logs.map((l) => { try { return dao.interface.parseLog(l); } catch { return null; } })
            .find((e) => e && e.name === "ProposalCreated").args.proposalId;
        await dao.connect(member).castVote(id, 1);
        await time.increase(121);
        const descriptionHash = ethers.id(description);
        await dao.queue(targets, values, calldatas, descriptionHash);
        await dao.execute(targets, values, calldatas, descriptionHash);
        expect(await dao.state(id)).to.equal(7n); // Executed
    }

    before(async function () {
        [deployer, member, buyer, agent] = await ethers.getSigners();

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
        await repToken.connect(member).delegate(member.address);
        usdc = await deploy("TestERC20", "USD Coin", "USDC", 6, 0);
    });

    it("deploys the Substrate against the predicted vault address and the jurisdiction's treasury and timelock", async function () {
        const nonce = await ethers.provider.getTransactionCount(deployer.address);
        const predictedVault = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
        substrate = await autonet("Substrate", deployer).deploy(registryAddr, predictedVault, timelockAddr);
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
        await expect(repClaim.claim(buyer.address)).to.be.revertedWithCustomError(repClaim, "NothingToClaim");
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
        await repToken.connect(agent).delegate(agent.address);
        expect(await repToken.getVotes(agent.address)).to.equal(ethers.parseEther("97.5"));
    });

    it("turns anchored tool-pool earnings into REP on top of service earnings", async function () {
        const amount = ATN(10);
        await substrate.submitAnchor("epoch-1", ethers.id("root-1"), ethers.ZeroHash, ethers.ZeroHash, "cid", ethers.ZeroHash, mintLeaf(agent.address, amount));
        await substrate.connect(agent).recordTrainingForEpoch(amount, ethers.id("epoch-1"), []);
        expect(await substrate.agentMintTotal(agent.address)).to.equal(amount);

        await repClaim.claim(agent.address);
        expect(await repToken.balanceOf(agent.address)).to.equal(ethers.parseEther("107.5"));
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

    it("anchors the charter only through a DAO proposal", async function () {
        charter = await autonet("CharterAnchor", deployer).deploy(timelockAddr);
        const hash = ethers.id("charter v1");
        await expect(charter.connect(member).anchorCharter(hash, "ipfs://charter")).to.be.revertedWithCustomError(charter, "NotGovernor");
        await govern([await charter.getAddress()], [charter.interface.encodeFunctionData("anchorCharter", [hash, "ipfs://charter"])], "Anchor charter v1");
        const current = await charter.currentCharter();
        expect(current.version).to.equal(1n);
        expect(current.hash).to.equal(hash);
    });

    it("lets the DAO pause the vault", async function () {
        await govern([await vault.getAddress()], [vault.interface.encodeFunctionData("pause")], "Pause vault");
        await usdc.mint(buyer.address, USDC(1));
        await usdc.connect(buyer).approve(await vault.getAddress(), USDC(1));
        await expect(vault.connect(buyer).buy(await usdc.getAddress(), USDC(1))).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });
});
