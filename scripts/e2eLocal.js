// End-to-end smoke run against a live node: deploys the factory suite, creates an
// economy DAO through the 3-step TrustlessFactory flow, runs native and 6-decimal
// ERC20 projects (with immediate release), and checks REP claims and treasury fees.
//
//   npx hardhat node
//   npx hardhat run scripts/e2eLocal.js --network localhost
const { ethers } = require("hardhat");

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const PLATFORM_FEE_BPS = 100n;
const AUTHOR_FEE_BPS = 100n;
const ARB_FEE_BPS = 500n;

// Same encoding werule's ValueIndexItem.toRegistryValue writes: parity * 10^(36 - decimals)
const parityValue = (parity, decimals) => (BigInt(Math.round(parity * 1e8)) * 10n ** BigInt(36 - decimals)) / 10n ** 8n;

function check(label, actual, expected) {
    const ok = actual === expected;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
    if (!ok) process.exitCode = 1;
}

async function deploy(name, ...args) {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    return c;
}

const eventArgs = (receipt, name) => receipt.logs.find(l => l.eventName === name).args;

async function main() {
    const [deployer, backer, contractor, arbiter] = await ethers.getSigners();

    const nativeImpl = await deploy("NativeProject");
    const erc20Impl = await deploy("ERC20Project");
    const factory = await deploy("TrustlessFactory",
        await (await deploy("InfrastructureFactory")).getAddress(),
        await (await deploy("DAOFactory")).getAddress(),
        await (await deploy("EconomyFactory")).getAddress(),
        await (await deploy("RepTokenFactory")).getAddress());
    const usdc = await deploy("TestERC20", "Test USDC", "USDC", 6, 10n ** 12n);
    const usdcAddr = await usdc.getAddress();

    // --- Economy DAO via the 3-step flow ---
    const infra = eventArgs(await (await factory.deployInfrastructure(1, ARB_FEE_BPS)).wait(), "InfrastructureDeployed");
    const daoTok = eventArgs(await (await factory.deployDAOToken(infra.registry, infra.timelock,
        { name: "E2E", symbol: "E2E", initialMembers: [deployer.address], initialAmounts: [ethers.parseEther("100")] },
        { name: "E2E DAO", timelockDelay: 1, votingPeriod: 5, proposalThreshold: 0, quorumFraction: 4 })).wait(), "DAOTokenDeployed");
    await (await factory.configureAndFinalize(
        {
            implAddresses: [await nativeImpl.getAddress(), await erc20Impl.getAddress()],
            contractAddresses: [infra.economy, infra.registry, infra.timelock, daoTok.repToken, daoTok.dao],
        },
        {
            arbitrationFeeBps: ARB_FEE_BPS, initialPlatformFeeBps: PLATFORM_FEE_BPS, initialAuthorFeeBps: AUTHOR_FEE_BPS,
            initialCoolingOffPeriod: 0, initialBackersQuorumBps: 7000, initialProjectThreshold: 0, initialAppealPeriod: 120,
        },
        [`jurisdiction.parity.${NATIVE.toLowerCase()}`, `jurisdiction.parity.${usdcAddr.toLowerCase()}`],
        [parityValue(1, 18).toString(), parityValue(2, 6).toString()],
    )).wait();
    console.log(`Economy ${infra.economy}, registry ${infra.registry}`);

    const economy = await ethers.getContractAt("Economy", infra.economy);
    const repToken = await ethers.getContractAt("RepToken", daoTok.repToken);
    check("economy admin can no longer configure", await economy.timelockAddress(), infra.timelock);

    const fees = (amount) => {
        const platform = amount * PLATFORM_FEE_BPS / 10000n;
        const author = (amount - platform) * AUTHOR_FEE_BPS / 10000n;
        return { platform, author, net: amount - platform - author };
    };

    // --- Native project: 10 ETH, 20% immediate, released by vote ---
    const nAmount = ethers.parseEther("10");
    const nAddr = eventArgs(await (await economy.createProject("native", contractor.address, arbiter.address, "t", "r", "d")).wait(), "NewProject").contractAddress;
    const nProject = await ethers.getContractAt("NativeProject", nAddr);
    await (await nProject.connect(backer).sendFundsWithImmediate(2000, { value: nAmount })).wait();
    const nLocked = nAmount * 8000n / 10000n;
    await (await nProject.connect(contractor).signContract({ value: nLocked * ARB_FEE_BPS / 10000n / 2n })).wait();
    await (await nProject.connect(backer).voteToReleasePayment()).wait();
    await (await nProject.connect(contractor).withdrawAsContractor()).wait();
    await (await nProject.connect(backer).withdrawAsContributor()).wait();
    await (await nProject.connect(contractor).reclaimArbitrationStake()).wait();

    // --- ERC20 project: 1000 USDC, 10% immediate, released by vote ---
    const uAmount = 1000n * 10n ** 6n;
    await (await usdc.transfer(backer.address, uAmount)).wait();
    await (await usdc.transfer(contractor.address, uAmount)).wait();
    const uAddr = eventArgs(await (await economy.createERC20Project("usdc", contractor.address, arbiter.address, "t", "r", "d", usdcAddr)).wait(), "NewProject").contractAddress;
    const uProject = await ethers.getContractAt("ERC20Project", uAddr);
    await (await usdc.connect(backer).approve(uAddr, uAmount)).wait();
    await (await uProject.connect(backer).sendFundsWithImmediate(uAmount, 1000)).wait();
    const uLocked = uAmount * 9000n / 10000n;
    await (await usdc.connect(contractor).approve(uAddr, uLocked * ARB_FEE_BPS / 10000n / 2n)).wait();
    await (await uProject.connect(contractor).signContract()).wait();
    await (await uProject.connect(backer).voteToReleasePayment()).wait();
    await (await uProject.connect(contractor).withdrawAsContractor()).wait();
    await (await uProject.connect(contractor).reclaimArbitrationStake()).wait();

    // The USDC backer never withdraws: spending is read from the closed project

    // --- Checks ---
    const nImm = fees(nAmount - nLocked), nRel = fees(nLocked);
    const uImm = fees(uAmount - uLocked), uRel = fees(uLocked);
    check("treasury native fees", await ethers.provider.getBalance(infra.registry), nImm.platform + nRel.platform);
    check("treasury USDC fees", await usdc.balanceOf(infra.registry), uImm.platform + uRel.platform);

    await (await repToken.connect(contractor).claimReputationFromEconomy()).wait();
    await (await repToken.connect(backer).claimReputationFromEconomy()).wait();
    // ETH at 1:1, USDC (6 decimals) at 2:1, both scaled to 18-decimal REP
    const contractorRep = (nImm.net + nRel.net) + (uImm.net + uRel.net) * 2n * 10n ** 12n;
    const backerRep = nAmount + uAmount * 2n * 10n ** 12n;
    check("contractor REP", await repToken.balanceOf(contractor.address), contractorRep);
    check("backer REP", await repToken.balanceOf(backer.address), backerRep);
    console.log(`Contractor ${ethers.formatEther(contractorRep)} REP, backer ${ethers.formatEther(backerRep)} REP`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
