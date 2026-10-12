const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
    impersonateAccount,
    setBalance,
    time,
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
                    name: "Autonet DAO", votingDelay: 1, votingPeriod: 5,
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

/**
 * Fast test-network governance timing (per user ruling for shadownet genesis):
 * NO voting delay, ~2 minute voting window, NO timelock execution delay —
 * i.e. deploy-autonet-jurisdiction.js run with
 *   VOTING_DELAY_SECS=0 VOTING_PERIOD_SECS=120 TIMELOCK_DELAY_SECS=0
 * The script converts seconds -> the factories' MINUTES unit (0, 2, 0); the
 * HomebaseDAO constructor multiplies the governor values by 60 again
 * (timestamp clock), so on-chain: votingDelay=0s, votingPeriod=120s,
 * timelock minDelay=0s. This suite deploys through the SAME factory path with
 * those minute values and drives a full proposal lifecycle:
 * propose -> vote -> (advance 121s) -> queue -> execute.
 */
describe("Autonet genesis flow — fast governance timing (0/120/0)", function () {
    let deployer, member;
    let trustlessFactory, nativeProjectImpl, erc20ProjectImpl;
    let economyAddr, registryAddr, timelockAddr, repTokenAddr, daoAddr;
    let registry, repToken, timelock, dao, mirror, substrate;

    before(async function () {
        [deployer, member] = await ethers.getSigners();

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

        // TIMELOCK_DELAY_SECS=0 -> toFactoryMinutes = 0 (minDelay 0s).
        const infraReceipt = await (await trustlessFactory.deployInfrastructure(0, 250)).wait();
        const infraEvent = infraReceipt.logs.find((l) => l.eventName === "InfrastructureDeployed");
        ({ economy: economyAddr, registry: registryAddr, timelock: timelockAddr } = infraEvent.args);

        // VOTING_DELAY_SECS=0 -> timelockDelay (now named votingDelay) = 0 min.
        // VOTING_PERIOD_SECS=120 -> votingPeriod = 2 min (x60 in HomebaseDAO = 120s).
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
                    name: "Autonet DAO", votingDelay: 0, votingPeriod: 2,
                    proposalThreshold: ethers.parseEther("10"), quorumFraction: 4,
                }
            )
        ).wait();
        const daoTokenEvent = daoTokenReceipt.logs.find((l) => l.eventName === "DAOTokenDeployed");
        ({ repToken: repTokenAddr, dao: daoAddr } = daoTokenEvent.args);

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
                [], []
            )
        ).wait();

        registry = await ethers.getContractAt("Registry", registryAddr);
        repToken = await ethers.getContractAt("RepToken", repTokenAddr);
        dao = await ethers.getContractAt("HomebaseDAO", daoAddr);
        timelock = await ethers.getContractAt(
            "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController",
            timelockAddr
        );

        // Genesis satellites' mirror as the real proposal target.
        substrate = await (await ethers.getContractFactory("MockGenesisSubstrate")).deploy();
        mirror = await (await ethers.getContractFactory("ReputationMirror")).deploy(
            await substrate.getAddress(), repTokenAddr, 0
        );
    });

    it("lands 0s votingDelay / 120s votingPeriod / 0s timelock minDelay on-chain", async function () {
        expect(await dao.votingDelay()).to.equal(0n);
        expect(await dao.votingPeriod()).to.equal(120n); // SECONDS (timestamp clock), not blocks
        expect(await timelock.getMinDelay()).to.equal(0n);
        expect(await repToken.CLOCK_MODE()).to.equal("mode=timestamp");
    });

    it("runs propose -> vote -> (advance 121s) -> queue -> execute within the test", async function () {
        // One 1000-AREP voter (quorum 4% of 1000 = 40 -> passes). Self-delegate
        // first, exactly like scripts/submit-genesis-proposals.js.
        await repToken.connect(member).delegate(member.address);

        // The genesis grant proposal: RepToken.setMinter(mirror, true).
        const mirrorAddr = await mirror.getAddress();
        const targets = [repTokenAddr];
        const values = [0];
        const calldatas = [repToken.interface.encodeFunctionData("setMinter", [mirrorAddr, true])];
        const description = "Genesis wiring: grant ReputationMirror RepToken-minter rights";
        const descriptionHash = ethers.keccak256(ethers.toUtf8Bytes(description));

        // Propose.
        const rc = await (await dao.connect(member).propose(targets, values, calldatas, description)).wait();
        const ev = rc.logs
            .map((l) => { try { return dao.interface.parseLog(l); } catch { return null; } })
            .find((e) => e && e.name === "ProposalCreated");
        const id = ev.args.proposalId;
        // votingDelay=0: voteStart == proposal timestamp.
        expect(ev.args.voteEnd - ev.args.voteStart).to.equal(120n);

        // Vote (next block, 1s later -> Active).
        await dao.connect(member).castVote(id, 1);
        expect(await dao.state(id)).to.equal(1n); // Active

        // Advance past the 120s window.
        await time.increase(121);
        expect(await dao.state(id)).to.equal(4n); // Succeeded

        // Queue (GovernorTimelockControl requires it) -> with minDelay 0 the
        // eta is immediate; then execute. Same branch logic as
        // scripts/execute-genesis-proposals.js.
        if (await dao.proposalNeedsQueuing(id)) {
            await dao.queue(targets, values, calldatas, descriptionHash);
            expect(await dao.state(id)).to.equal(5n); // Queued
        }
        await dao.execute(targets, values, calldatas, descriptionHash);
        expect(await dao.state(id)).to.equal(7n); // Executed

        // The grant actually landed.
        expect(await repToken.minters(mirrorAddr)).to.equal(true);
    });
});
