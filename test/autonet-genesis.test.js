const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
    impersonateAccount,
    setBalance,
} = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Full contracts-side GENESIS flow for an autonet jurisdiction, against a mock
 * Substrate (MockGenesisSubstrate = MockAutonetATN mintFromVault surface +
 * MockSubstrate reputation-read surface at ONE address, like the real thing).
 *
 * Mirrors scripts/deploy-autonet-jurisdiction.js:
 *   factories -> infrastructure -> DAO token -> configureAndFinalize (with the
 *   vault payment-token parity FOLDED IN) -> AutonetVault (nonce-predicted
 *   address) -> ReputationMirror -> timelock-executed setMinter grant.
 *
 * The tests in this describe run IN ORDER and share state (a flow test, like
 * the script it verifies). Assertions cover the coordinator checklist:
 *   - vault attached + can mint via the (mock) Substrate grant
 *   - mirror deployed + minter grant NOT executable by the deployer at any
 *     point (the script's print-calldata decision), but executable by the
 *     timelock (the printed-calldata path)
 *   - timelock owns everything after finalize
 */
describe("Autonet genesis flow (contracts-side)", function () {
    let deployer, member, buyer, agent, agentOwner;
    let trustlessFactory, nativeProjectImpl, erc20ProjectImpl;
    let economyAddr, registryAddr, timelockAddr, repTokenAddr, daoAddr;
    let registry, repToken, timelock;
    let substrate, usdc, vault, mirror;
    let predictedVaultAddr;

    const USDC_DECIMALS = 6;
    const ATN_DECIMALS = 6;
    // 1 USDC (6d) -> 2 ATN (6d): parity = 2e18 (see AutonetVault decimals note).
    const PARITY = ethers.parseEther("2");

    before(async function () {
        [deployer, member, buyer, agent, agentOwner] = await ethers.getSigners();

        // ── Step 0: factory suite (as scripts/deploy-autonet-jurisdiction.js) ──
        nativeProjectImpl = await (await ethers.getContractFactory("NativeProject")).deploy();
        erc20ProjectImpl = await (await ethers.getContractFactory("ERC20Project")).deploy();
        const infraFactory = await (await ethers.getContractFactory("InfrastructureFactory")).deploy();
        const daoFactory = await (await ethers.getContractFactory("DAOFactory")).deploy();
        const repTokenFactory = await (await ethers.getContractFactory("RepTokenFactory")).deploy();
        const economyFactory = await (await ethers.getContractFactory("EconomyFactory")).deploy();
        trustlessFactory = await (await ethers.getContractFactory("TrustlessFactory")).deploy(
            await infraFactory.getAddress(),
            await daoFactory.getAddress(),
            await economyFactory.getAddress(),
            await repTokenFactory.getAddress()
        );

        // ── Step 1: infrastructure ──
        const infraReceipt = await (await trustlessFactory.deployInfrastructure(1, 250)).wait();
        const infraEvent = infraReceipt.logs.find((l) => l.eventName === "InfrastructureDeployed");
        ({ economy: economyAddr, registry: registryAddr, timelock: timelockAddr } = infraEvent.args);

        // ── Step 2: DAO token + governor ──
        const daoTokenReceipt = await (
            await trustlessFactory.deployDAOToken(
                registryAddr,
                timelockAddr,
                {
                    name: "Autonet Rep", symbol: "AREP",
                    initialMembers: [member.address],
                    initialAmounts: [ethers.parseEther("1000")],
                },
                {
                    name: "Autonet DAO", timelockDelay: 1, votingPeriod: 5,
                    proposalThreshold: ethers.parseEther("1"), quorumFraction: 4,
                }
            )
        ).wait();
        const daoTokenEvent = daoTokenReceipt.logs.find((l) => l.eventName === "DAOTokenDeployed");
        ({ repToken: repTokenAddr, dao: daoAddr } = daoTokenEvent.args);

        registry = await ethers.getContractAt("Registry", registryAddr);
        repToken = await ethers.getContractAt("RepToken", repTokenAddr);
        timelock = await ethers.getContractAt(
            "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController",
            timelockAddr
        );

        // ── External-network stand-ins: ONE mock Substrate + a payment token ──
        substrate = await (await ethers.getContractFactory("MockGenesisSubstrate")).deploy();
        usdc = await (await ethers.getContractFactory("TestERC20")).deploy(
            "USD Coin", "USDC", USDC_DECIMALS, 0
        );
    });

    // =========================================================================
    // GRANT SEQUENCING — the script's "print, don't execute" decision
    // =========================================================================

    it("pre-finalize: the deployer can NOT execute RepToken.setMinter (admin is the factory)", async function () {
        // RepToken.admin: RepTokenFactory (constructor) -> TrustlessFactory
        // (deployDAOToken) -> Timelock (configureAndFinalize). Never the EOA.
        expect(await repToken.admin()).to.equal(await trustlessFactory.getAddress());
        await expect(
            repToken.connect(deployer).setMinter(deployer.address, true)
        ).to.be.revertedWith("RepToken: Caller is not the admin or Timelock");
    });

    // =========================================================================
    // FINALIZE — timelock takes ownership; vault parities folded in
    // =========================================================================

    it("configureAndFinalize hands everything to the timelock and folds vault parities into the Registry", async function () {
        const parityKey = `jurisdiction.parity.${(await usdc.getAddress()).toLowerCase()}`;
        await (
            await trustlessFactory.configureAndFinalize(
                {
                    implAddresses: [
                        await nativeProjectImpl.getAddress(),
                        await erc20ProjectImpl.getAddress(),
                    ],
                    contractAddresses: [economyAddr, registryAddr, timelockAddr, repTokenAddr, daoAddr],
                },
                {
                    arbitrationFeeBps: 250,
                    initialPlatformFeeBps: 250,
                    initialAuthorFeeBps: 500,
                    initialCoolingOffPeriod: 60,
                    initialBackersQuorumBps: 5100,
                    initialProjectThreshold: 0,
                    initialAppealPeriod: 120,
                },
                // Registry entries at finalize — the PARITY_TOKENS/PARITY_VALUES
                // fold-in the genesis script performs (no post-finalize proposal).
                ["jurisdiction.name", parityKey],
                ["Autonet", PARITY.toString()]
            )
        ).wait();

        // Timelock owns everything.
        expect(await registry.owner()).to.equal(timelockAddr);
        expect(await repToken.admin()).to.equal(timelockAddr);
        expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), daoAddr)).to.equal(true);
        expect(
            await timelock.hasRole(
                await timelock.DEFAULT_ADMIN_ROLE(),
                await trustlessFactory.getAddress()
            )
        ).to.equal(false);

        // Parity landed (readable by the vault).
        expect(await registry.getRegistryValue(parityKey)).to.equal(PARITY.toString());

        // Post-finalize the deployer STILL cannot grant — governance only.
        await expect(
            repToken.connect(deployer).setMinter(deployer.address, true)
        ).to.be.revertedWith("RepToken: Caller is not the admin or Timelock");
    });

    // =========================================================================
    // VAULT — nonce prediction + attach + mint-via-grant
    // =========================================================================

    it("the vault address is predictable from the deployer nonce and deploys to it", async function () {
        const nonce = await ethers.provider.getTransactionCount(deployer.address);
        predictedVaultAddr = ethers.getCreateAddress({ from: deployer.address, nonce });

        // This is the circular-address break: the prediction is what the
        // autonet side would pass to Substrate's constructor as VAULT_MINTER.
        const Vault = await ethers.getContractFactory("AutonetVault");
        vault = await Vault.deploy(await substrate.getAddress(), registryAddr, timelockAddr);
        await vault.waitForDeployment();

        expect(await vault.getAddress()).to.equal(predictedVaultAddr);
        expect(await vault.admin()).to.equal(timelockAddr);
        expect(await vault.atnToken()).to.equal(await substrate.getAddress());
        expect(await vault.registryAddress()).to.equal(registryAddr);
    });

    it("vault buy mints ATN on the (mock) Substrate and routes payment to the Registry treasury", async function () {
        const pay = ethers.parseUnits("500", USDC_DECIMALS); // 500 USDC
        const expectedAtn = ethers.parseUnits("1000", ATN_DECIMALS); // *2 parity

        await usdc.mint(buyer.address, pay);
        await usdc.connect(buyer).approve(await vault.getAddress(), pay);
        await vault.connect(buyer).buy(await usdc.getAddress(), pay);

        // ATN minted to the buyer on the Substrate, BY the vault (the address
        // Substrate would have been constructed with as VAULT_MINTER).
        expect(await substrate.balanceOf(buyer.address)).to.equal(expectedAtn);
        expect(await substrate.lastMinter()).to.equal(predictedVaultAddr);

        // Payment landed at the Registry treasury; vault holds nothing.
        expect(await usdc.balanceOf(registryAddr)).to.equal(pay);
        expect(await usdc.balanceOf(await vault.getAddress())).to.equal(0n);
    });

    // =========================================================================
    // MIRROR — deploy + the timelock-executed grant path
    // =========================================================================

    it("the mirror deploys against the same Substrate and reads its timelock from RepToken", async function () {
        const Mirror = await ethers.getContractFactory("ReputationMirror");
        mirror = await Mirror.deploy(await substrate.getAddress(), repTokenAddr, 0); // period 0 = single period
        await mirror.waitForDeployment();

        expect(await mirror.timelock()).to.equal(timelockAddr);
        expect(await repToken.minters(await mirror.getAddress())).to.equal(false); // not yet granted
    });

    it("the timelock-executed setMinter grant (the printed calldata) enables mirror claims", async function () {
        // Execute exactly what the genesis script prints as proposal calldata,
        // as the timelock (impersonated — in production: proposal -> queue ->
        // execute).
        await impersonateAccount(timelockAddr);
        await setBalance(timelockAddr, ethers.parseEther("1"));
        const timelockSigner = await ethers.getSigner(timelockAddr);
        await repToken.connect(timelockSigner).setMinter(await mirror.getAddress(), true);
        expect(await repToken.minters(await mirror.getAddress())).to.equal(true);

        // Drive the mirror loop: baseline sync mints nothing…
        await substrate.setOwner(agent.address, agentOwner.address);
        await substrate.setReputation(agent.address, 1_000_000n); // pre-mirror rep
        await mirror.sync([agent.address]);
        expect(await mirror.pending(agentOwner.address)).to.equal(0n);

        // …new reputation accrues to the owner and claims as RepToken (1:1 rate).
        await substrate.setReputation(agent.address, 3_000_000n); // +2_000_000
        await mirror.sync([agent.address]);
        expect(await mirror.pending(agentOwner.address)).to.equal(2_000_000n);

        const before = await repToken.balanceOf(agentOwner.address);
        await mirror.claim(agentOwner.address);
        expect(await repToken.balanceOf(agentOwner.address)).to.equal(before + 2_000_000n);
        expect(await mirror.pending(agentOwner.address)).to.equal(0n);
    });

    // =========================================================================
    // END STATE — everything the genesis leaves behind is timelock-governed
    // =========================================================================

    it("end state: timelock owns/administers every governed surface", async function () {
        expect(await registry.owner()).to.equal(timelockAddr);
        expect(await repToken.admin()).to.equal(timelockAddr);
        expect(await vault.admin()).to.equal(timelockAddr);
        expect(await mirror.timelock()).to.equal(timelockAddr);
        // CharterAnchor lives autonet-side; its governor is a constructor-only
        // immutable, so the genesis checklist instructs deploying it there with
        // governor = this timelock (no assertion possible in this repo).
    });
});
