const { expect } = require("chai");
const { ethers } = require("hardhat");

const { autonet } = require("./helpers/autonet");
const { deployAutonetGenesis } = require("../scripts/lib/autonet-genesis");

// An Autonet jurisdiction launched the way the werule wizard does it: TrustlessFactory steps 1 and 2,
// AutonetGenesis.launch, then configureAndFinalizeWithGrants with the launch's registry entries and
// grants. Everything is live at genesis, with no proposal.
describe("AutonetGenesis", function () {
    let deployer, launcher, member, buyer;
    let trustlessFactory, genesis, nativeImpl, erc20Impl;

    const ATN = (n) => ethers.parseUnits(String(n), 6);
    const DAY = 86400;
    const BOND = {
        minStake: ATN(100), thresholdBps: 500, reviewWindow: 14 * DAY, revealWindow: 2 * DAY, finderBps: 5000,
        degradeBps: 1000, authorSlashBps: 10000, unbondDelay: 30 * DAY, auditorShareBps: 4000,
    };
    const CHARTER = ethers.id("charter v1");

    const deploy = async (name, ...args) => (await ethers.getContractFactory(name)).deploy(...args);

    async function launchJurisdiction(from, usdc) {
        const f = trustlessFactory.connect(from);
        const infra = (await (await f.deployInfrastructure(0, 250)).wait())
            .logs.find((l) => l.eventName === "InfrastructureDeployed").args;
        const tok = (await (await f.deployDAOToken(infra.registry, infra.timelock,
            { name: "Rep", symbol: "REP", initialMembers: [member.address], initialAmounts: [ethers.parseEther("1000")] },
            { name: "DAO", votingDelay: 0, votingPeriod: 2, proposalThreshold: 0, quorumFraction: 4 }
        )).wait()).logs.find((l) => l.eventName === "DAOTokenDeployed").args;

        const j = { registry: infra.registry, timelock: infra.timelock, repToken: tok.repToken, economy: infra.economy, dao: tok.dao };
        const params = { anchorQuorumBps: 5000, genesisSigners: [from.address], genesisQuorum: 1,
            challengeWindow: 3600, charterHash: CHARTER, charterUri: "ipfs://charter" };
        await genesis.connect(from).launch(j, params, BOND);
        const d = await genesis.deploymentOf(tok.repToken);

        const [keys, values] = await genesis.registryEntries(tok.repToken);
        const parityKey = `jurisdiction.parity.${(await usdc.getAddress()).toLowerCase()}`;
        await f.configureAndFinalizeWithGrants(
            { implAddresses: [await nativeImpl.getAddress(), await erc20Impl.getAddress()],
              contractAddresses: [infra.economy, infra.registry, infra.timelock, tok.repToken, tok.dao] },
            { arbitrationFeeBps: 250, initialPlatformFeeBps: 250, initialAuthorFeeBps: 500, initialCoolingOffPeriod: 60,
              initialBackersQuorumBps: 5100, initialProjectThreshold: 0, initialAppealPeriod: 120 },
            [...keys, parityKey], [...values, (10n ** 30n).toString()],
            [d.repClaim], [d.toolBond]);
        return { j, d };
    }

    before(async function () {
        [deployer, launcher, member, buyer] = await ethers.getSigners();
        nativeImpl = await deploy("NativeProject");
        erc20Impl = await deploy("ERC20Project");
        trustlessFactory = await deploy("TrustlessFactory",
            await (await deploy("InfrastructureFactory")).getAddress(),
            await (await deploy("DAOFactory")).getAddress(),
            await (await deploy("EconomyFactory")).getAddress(),
            await (await deploy("RepTokenFactory")).getAddress());
        genesis = await deployAutonetGenesis(ethers, deployer);
    });

    it("launches a jurisdiction's whole Autonet layer, wired and live at genesis", async function () {
        const usdc = await deploy("TestERC20", "USD Coin", "USDC", 6, 0);
        const { j, d } = await launchJurisdiction(launcher, usdc);

        const substrate = autonet("Substrate", deployer).attach(d.substrate);
        expect(await substrate.vaultMinter()).to.equal(d.vault);
        expect(await substrate.treasury()).to.equal(j.registry);
        expect(await substrate.governor()).to.equal(j.timelock);
        expect(await substrate.repToken()).to.equal(j.repToken);
        expect(await substrate.anchorQuorumBps()).to.equal(5000n);
        expect(await substrate.isGenesisSigner(launcher.address)).to.equal(true);

        const repToken = await ethers.getContractAt("RepToken", j.repToken);
        expect(await repToken.minters(d.repClaim)).to.equal(true);
        expect(await repToken.slashers(d.toolBond)).to.equal(true);
        expect(await repToken.admin()).to.equal(j.timelock);

        const charter = autonet("CharterAnchor", deployer).attach(d.charterAnchor);
        expect(await charter.versionCount()).to.equal(1n);
        expect(await charter.governor()).to.equal(j.timelock);

        const bond = await ethers.getContractAt("ToolBond", d.toolBond);
        expect(await bond.auditorShareBps()).to.equal(4000n);
        expect(await bond.timelock()).to.equal(j.timelock);

        const registry = await ethers.getContractAt("Registry", j.registry);
        expect(await registry.getRegistryValue("jurisdiction.autonet.substrate")).to.equal(d.substrate.toLowerCase());
        expect(await registry.getRegistryValue("jurisdiction.autonet.rep_token")).to.equal(j.repToken.toLowerCase());
        expect(await registry.getRegistryValue("jurisdiction.autonet.venture_vault_factory")).to.equal(d.ventureVaultFactory.toLowerCase());

        // The vault sells ATN at parity straight away
        await usdc.mint(buyer.address, 1_000_000);
        await usdc.connect(buyer).approve(d.vault, 1_000_000);
        const vault = await ethers.getContractAt("AutonetVault", d.vault);
        await vault.connect(buyer).buy(await usdc.getAddress(), 1_000_000);
        expect(await substrate.balanceOf(buyer.address)).to.equal(ATN(1));
    });

    it("a second launch from the same genesis contract still wires its own vault", async function () {
        const usdc = await deploy("TestERC20", "USD Coin", "USDC", 6, 0);
        const { d } = await launchJurisdiction(deployer, usdc);
        expect(await autonet("Substrate", deployer).attach(d.substrate).vaultMinter()).to.equal(d.vault);
        expect(await genesis.launches()).to.equal(2n);
    });

    it("rejects missing jurisdiction addresses and unknown launches", async function () {
        const z = ethers.ZeroAddress;
        await expect(genesis.launch({ registry: z, timelock: z, repToken: z, economy: z, dao: z },
            { anchorQuorumBps: 5000, genesisSigners: [], genesisQuorum: 0, challengeWindow: 0, charterHash: ethers.ZeroHash, charterUri: "" },
            BOND)).to.be.revertedWithCustomError(genesis, "ZeroAddress");
        await expect(genesis.registryEntries(z)).to.be.revertedWithCustomError(genesis, "UnknownLaunch");
    });
});
