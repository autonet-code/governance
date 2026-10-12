const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TrustlessFactory Deployment", function () {
    let deployer, initialMember1, initialMember2;
    let trustlessFactory;
    let nativeProjectImpl, erc20ProjectImpl;

    beforeEach(async function () {
        [deployer, initialMember1, initialMember2] = await ethers.getSigners();

        nativeProjectImpl = await (await ethers.getContractFactory("NativeProject")).deploy();
        erc20ProjectImpl = await (await ethers.getContractFactory("ERC20Project")).deploy();

        const infraFactory = await (await ethers.getContractFactory("InfrastructureFactory")).deploy();
        const daoFactory = await (await ethers.getContractFactory("DAOFactory")).deploy();
        const repTokenFactory = await (await ethers.getContractFactory("RepTokenFactory")).deploy();
        const economyFactory = await (await ethers.getContractFactory("EconomyFactory")).deploy();

        const TrustlessFactory = await ethers.getContractFactory("TrustlessFactory");
        trustlessFactory = await TrustlessFactory.deploy(
            await infraFactory.getAddress(),
            await daoFactory.getAddress(),
            await economyFactory.getAddress(),
            await repTokenFactory.getAddress()
        );
    });

    it("should deploy and link the entire suite correctly", async function () {
        const timelockDelay = 1;
        const tokenParams = {
            name: "My Trustless Token", symbol: "MTT",
            initialMembers: [initialMember1.address, initialMember2.address],
            initialAmounts: [ethers.parseEther("100"), ethers.parseEther("50")],
        };
        const govParams = {
            name: "My Trustless DAO", votingDelay: timelockDelay, votingPeriod: 5,
            proposalThreshold: ethers.parseEther("1"), quorumFraction: 4,
        };
        
        // THE FIX: Construct economyParams as a JS object to match the Solidity struct
        const arbitrationFeeBps = 500; // 5%
        const economyParams = {
            arbitrationFeeBps: arbitrationFeeBps,
            initialPlatformFeeBps: 100,
            initialAuthorFeeBps: 100,
            initialCoolingOffPeriod: 60,
            initialBackersQuorumBps: 7000,
            initialProjectThreshold: 0,
            initialAppealPeriod: 120,
        };

        // --- TX 1: Deploy Infrastructure ---
        const infraTx = await trustlessFactory.deployInfrastructure(timelockDelay, arbitrationFeeBps);
        const infraReceipt = await infraTx.wait();
        const infraEvent = infraReceipt.logs.find(log => log.eventName === 'InfrastructureDeployed');
        const { economy, registry, timelock } = infraEvent.args;

        // --- TX 2: Deploy DAO & Token ---
        const daoTokenTx = await trustlessFactory.deployDAOToken(registry, timelock, tokenParams, govParams);
        const daoTokenReceipt = await daoTokenTx.wait();
        const daoTokenEvent = daoTokenReceipt.logs.find(log => log.eventName === 'DAOTokenDeployed');
        const { repToken, dao } = daoTokenEvent.args;

        // --- TX 3: Configure and Finalize ---
        const addressParams = {
            implAddresses: [await nativeProjectImpl.getAddress(), await erc20ProjectImpl.getAddress()],
            contractAddresses: [economy, registry, timelock, repToken, dao]
        };
        
        const configureTx = await trustlessFactory.configureAndFinalize(
            addressParams,
            economyParams,
            [], // registryKeys
            []  // registryValues
        );
        const configureReceipt = await configureTx.wait();
        const configuredEvent = configureReceipt.logs.find(log => log.eventName === 'SuiteConfigured');
        expect(configuredEvent).to.not.be.undefined;

        // --- VERIFICATION ---
        const economyContract = await ethers.getContractAt("Economy", economy);
        const registryContract = await ethers.getContractAt("Registry", registry);
        const timelockContract = await ethers.getContractAt("@openzeppelin/contracts/governance/TimelockController.sol:TimelockController", timelock);
        const repTokenContract = await ethers.getContractAt("RepToken", repToken);
        const daoContract = await ethers.getContractAt("HomebaseDAO", dao);
        
        expect(await economyContract.timelockAddress()).to.equal(timelock);
        expect(await repTokenContract.admin()).to.equal(timelock);
        expect(await registryContract.owner()).to.equal(timelock);
        expect(await daoContract.timelock()).to.equal(timelock);
        
        const proposerRole = await timelockContract.PROPOSER_ROLE();
        expect(await timelockContract.hasRole(proposerRole, dao)).to.be.true;
        expect(await timelockContract.hasRole(await timelockContract.CANCELLER_ROLE(), dao)).to.be.true;
    });
});
// factory-deployment.test.js