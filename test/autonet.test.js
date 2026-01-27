const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Autonet", function () {
    let deployer, user1, user2, backer1, backer2;
    let autonet, autonetFactory;
    let economy, registry, repToken, timelock;
    let mockProject;

    // Deploy a minimal jurisdiction infrastructure for testing
    async function deployMockJurisdiction() {
        // Deploy mock contracts that implement the minimal interfaces we need
        const MockRegistry = await ethers.getContractFactory("AutonetMockRegistry");
        const mockRegistry = await MockRegistry.deploy();

        const MockRepToken = await ethers.getContractFactory("AutonetMockRepToken");
        const mockRepToken = await MockRepToken.deploy("Test Rep", "REP");

        // For timelock and economy, use simple addresses (we won't call their functions in basic tests)
        const mockEconomy = deployer.address; // placeholder
        const mockTimelock = deployer.address; // deployer acts as timelock for admin actions

        return {
            economy: mockEconomy,
            registry: await mockRegistry.getAddress(),
            repToken: await mockRepToken.getAddress(),
            timelock: mockTimelock,
            registryContract: mockRegistry,
            repTokenContract: mockRepToken,
        };
    }

    beforeEach(async function () {
        [deployer, user1, user2, backer1, backer2] = await ethers.getSigners();

        // Deploy mock jurisdiction
        const jurisdiction = await deployMockJurisdiction();
        economy = jurisdiction.economy;
        registry = jurisdiction.registry;
        repToken = jurisdiction.repToken;
        timelock = jurisdiction.timelock;

        // Deploy Autonet
        const Autonet = await ethers.getContractFactory("Autonet");
        autonet = await Autonet.deploy(
            economy,
            registry,
            repToken,
            timelock,
            "Autonet Credits - Test",
            "ATN-TEST"
        );

        // Deploy a mock project for service registration
        mockProject = user1.address; // placeholder for project contract
    });

    describe("Deployment", function () {
        it("should deploy with correct parameters", async function () {
            expect(await autonet.name()).to.equal("Autonet Credits - Test");
            expect(await autonet.symbol()).to.equal("ATN-TEST");
            expect(await autonet.economyAddress()).to.equal(economy);
            expect(await autonet.registryAddress()).to.equal(registry);
            expect(await autonet.repTokenAddress()).to.equal(repToken);
            expect(await autonet.timelockAddress()).to.equal(timelock);
            expect(await autonet.admin()).to.equal(deployer.address);
            expect(await autonet.currentEpoch()).to.equal(0);
        });

        it("should have correct decimals", async function () {
            expect(await autonet.decimals()).to.equal(18);
        });

        it("should start with zero supply", async function () {
            expect(await autonet.totalSupply()).to.equal(0);
        });
    });

    describe("Service Registration", function () {
        const serviceId = ethers.keccak256(ethers.toUtf8Bytes("test-service-1"));
        const codebaseHash = "abc123";

        it("should register a general service", async function () {
            await expect(autonet.connect(user1).registerService(serviceId, mockProject, codebaseHash))
                .to.emit(autonet, "ServiceRegistered")
                .withArgs(serviceId, mockProject, await autonet.SERVICE_TYPE_GENERAL(), user1.address);

            const service = await autonet.getService(serviceId);
            expect(service.projectContract).to.equal(mockProject);
            expect(service.codebaseHash).to.equal(codebaseHash);
            expect(service.serviceType).to.equal(await autonet.SERVICE_TYPE_GENERAL());
            expect(service.isActive).to.equal(false);
        });

        it("should register an inference provider", async function () {
            const inferenceEndpoint = user2.address; // placeholder for IInferenceProvider

            await expect(autonet.connect(user1).registerInferenceProvider(
                serviceId, mockProject, inferenceEndpoint, codebaseHash
            ))
                .to.emit(autonet, "ServiceRegistered")
                .withArgs(serviceId, mockProject, await autonet.SERVICE_TYPE_INFERENCE_PROVIDER(), user1.address);

            const service = await autonet.getService(serviceId);
            expect(service.serviceEndpoint).to.equal(inferenceEndpoint);
            expect(service.serviceType).to.equal(await autonet.SERVICE_TYPE_INFERENCE_PROVIDER());
        });

        it("should not allow duplicate service IDs", async function () {
            await autonet.connect(user1).registerService(serviceId, mockProject, codebaseHash);

            await expect(autonet.connect(user2).registerService(serviceId, user2.address, "xyz"))
                .to.be.revertedWithCustomError(autonet, "ServiceAlreadyExists");
        });

        it("should track services by creator", async function () {
            const serviceId2 = ethers.keccak256(ethers.toUtf8Bytes("test-service-2"));

            await autonet.connect(user1).registerService(serviceId, mockProject, codebaseHash);
            await autonet.connect(user1).registerService(serviceId2, mockProject, "def456");

            const services = await autonet.getServicesByCreator(user1.address);
            expect(services.length).to.equal(2);
            expect(services[0]).to.equal(serviceId);
            expect(services[1]).to.equal(serviceId2);
        });
    });

    describe("Service Activation", function () {
        const serviceId = ethers.keccak256(ethers.toUtf8Bytes("activation-test"));

        beforeEach(async function () {
            await autonet.connect(user1).registerService(serviceId, mockProject, "hash");
        });

        it("should allow admin to activate service", async function () {
            await expect(autonet.activateService(serviceId))
                .to.emit(autonet, "ServiceActivated")
                .withArgs(serviceId);

            const service = await autonet.getService(serviceId);
            expect(service.isActive).to.equal(true);
        });

        it("should allow admin to deactivate service", async function () {
            await autonet.activateService(serviceId);

            await expect(autonet.deactivateService(serviceId))
                .to.emit(autonet, "ServiceDeactivated")
                .withArgs(serviceId);

            const service = await autonet.getService(serviceId);
            expect(service.isActive).to.equal(false);
        });

        it("should not allow non-admin to activate", async function () {
            await expect(autonet.connect(user1).activateService(serviceId))
                .to.be.revertedWithCustomError(autonet, "NotAuthorized");
        });
    });

    describe("Usage Attestation", function () {
        const serviceId = ethers.keccak256(ethers.toUtf8Bytes("usage-test"));

        beforeEach(async function () {
            await autonet.connect(user1).registerService(serviceId, mockProject, "hash");
            await autonet.activateService(serviceId);
        });

        it("should attest usage for active service", async function () {
            const units = 100;

            await expect(autonet.connect(user1).attestUsage(serviceId, units))
                .to.emit(autonet, "UsageAttested")
                .withArgs(serviceId, user1.address, units, 0);

            const service = await autonet.getService(serviceId);
            expect(service.totalUsageUnits).to.equal(units);
        });

        it("should not attest for inactive service", async function () {
            await autonet.deactivateService(serviceId);

            await expect(autonet.connect(user1).attestUsage(serviceId, 100))
                .to.be.revertedWithCustomError(autonet, "ServiceNotActive");
        });

        it("should accumulate usage across attestations", async function () {
            await autonet.connect(user1).attestUsage(serviceId, 100);
            await autonet.connect(user2).attestUsage(serviceId, 50);

            const service = await autonet.getService(serviceId);
            expect(service.totalUsageUnits).to.equal(150);
        });
    });

    describe("Epoch Management", function () {
        const serviceId = ethers.keccak256(ethers.toUtf8Bytes("epoch-test"));
        const budget = ethers.parseEther("1000");

        beforeEach(async function () {
            await autonet.connect(user1).registerService(serviceId, mockProject, "hash");
            await autonet.activateService(serviceId);
        });

        it("should start new epoch", async function () {
            await expect(autonet.startEpoch(budget))
                .to.emit(autonet, "EpochStarted")
                .withArgs(1, budget);

            expect(await autonet.currentEpoch()).to.equal(1);
        });

        it("should finalize epoch and distribute rewards", async function () {
            await autonet.startEpoch(budget);
            await autonet.connect(user1).attestUsage(serviceId, 100);

            await expect(autonet.finalizeCurrentEpoch())
                .to.emit(autonet, "EpochFinalized");

            const epochStats = await autonet.getEpochStats(1);
            expect(epochStats.totalUsage).to.equal(100);
            expect(epochStats.finalized).to.equal(true);
        });

        it("should distribute proportional rewards to services", async function () {
            const serviceId2 = ethers.keccak256(ethers.toUtf8Bytes("epoch-test-2"));
            await autonet.connect(user2).registerService(serviceId2, user2.address, "hash2");
            await autonet.activateService(serviceId2);

            await autonet.startEpoch(budget);
            await autonet.connect(user1).attestUsage(serviceId, 75);  // 75%
            await autonet.connect(user2).attestUsage(serviceId2, 25); // 25%

            await autonet.finalizeCurrentEpoch();

            const reward1 = await autonet.getServiceEpochReward(serviceId, 1);
            const reward2 = await autonet.getServiceEpochReward(serviceId2, 1);

            // Should be approximately 750 and 250 ATN
            expect(reward1.totalReward).to.equal(ethers.parseEther("750"));
            expect(reward2.totalReward).to.equal(ethers.parseEther("250"));
        });
    });

    describe("Admin Transfer", function () {
        it("should transfer admin role", async function () {
            await expect(autonet.transferAdmin(user1.address))
                .to.emit(autonet, "AdminTransferred")
                .withArgs(deployer.address, user1.address);

            expect(await autonet.admin()).to.equal(user1.address);
        });

        it("should not allow non-admin to transfer", async function () {
            await expect(autonet.connect(user1).transferAdmin(user2.address))
                .to.be.revertedWithCustomError(autonet, "NotAuthorized");
        });

        it("should not allow transfer to zero address", async function () {
            await expect(autonet.transferAdmin(ethers.ZeroAddress))
                .to.be.revertedWithCustomError(autonet, "ZeroAddress");
        });
    });

    describe("View Functions", function () {
        it("should list all service IDs", async function () {
            const id1 = ethers.keccak256(ethers.toUtf8Bytes("view-1"));
            const id2 = ethers.keccak256(ethers.toUtf8Bytes("view-2"));

            await autonet.connect(user1).registerService(id1, mockProject, "h1");
            await autonet.connect(user1).registerService(id2, mockProject, "h2");

            const allIds = await autonet.getAllServiceIds();
            expect(allIds.length).to.equal(2);
        });

        it("should list inference providers only", async function () {
            const generalId = ethers.keccak256(ethers.toUtf8Bytes("general"));
            const inferId = ethers.keccak256(ethers.toUtf8Bytes("inference"));

            await autonet.connect(user1).registerService(generalId, mockProject, "h1");
            await autonet.connect(user1).registerInferenceProvider(inferId, mockProject, user2.address, "h2");

            const providers = await autonet.getInferenceProviders();
            expect(providers.length).to.equal(1);
            expect(providers[0]).to.equal(inferId);
        });
    });
});

describe("AutonetFactory", function () {
    let deployer, user1;
    let factory;
    let mockEconomy, mockRegistry, mockRepToken, mockTimelock;

    beforeEach(async function () {
        [deployer, user1] = await ethers.getSigners();

        // Deploy mock contracts
        const MockRegistry = await ethers.getContractFactory("AutonetMockRegistry");
        const mockRegistryContract = await MockRegistry.deploy();

        const MockRepToken = await ethers.getContractFactory("AutonetMockRepToken");
        const mockRepTokenContract = await MockRepToken.deploy("Test Rep", "REP");

        mockEconomy = deployer.address;
        mockRegistry = await mockRegistryContract.getAddress();
        mockRepToken = await mockRepTokenContract.getAddress();
        mockTimelock = deployer.address;

        // Deploy implementation for factory reference (not actually used as clone)
        const Autonet = await ethers.getContractFactory("Autonet");
        const implementation = await Autonet.deploy(
            mockEconomy,
            mockRegistry,
            mockRepToken,
            mockTimelock,
            "Implementation",
            "IMPL"
        );

        // Deploy factory
        const AutonetFactory = await ethers.getContractFactory("AutonetFactory");
        factory = await AutonetFactory.deploy(await implementation.getAddress(), false);
    });

    it("should deploy factory correctly", async function () {
        expect(await factory.implementation()).to.not.equal(ethers.ZeroAddress);
        expect(await factory.enforceOnePerEconomy()).to.equal(false);
    });

    it("should create new Autonet instance", async function () {
        const tx = await factory.createAutonet(
            mockEconomy,
            mockRegistry,
            mockRepToken,
            mockTimelock,
            "Test ATN",
            "TATN"
        );

        const receipt = await tx.wait();
        const event = receipt.logs.find(log => log.eventName === "AutonetCreated");
        expect(event).to.not.be.undefined;

        const autonetAddress = event.args.autonet;
        const autonet = await ethers.getContractAt("Autonet", autonetAddress);

        expect(await autonet.name()).to.equal("Test ATN");
        expect(await autonet.symbol()).to.equal("TATN");
        expect(await autonet.admin()).to.equal(deployer.address); // transferred to deployer
    });

    it("should track deployments by deployer", async function () {
        await factory.createAutonet(mockEconomy, mockRegistry, mockRepToken, mockTimelock, "ATN1", "A1");
        await factory.createAutonet(mockEconomy, mockRegistry, mockRepToken, mockTimelock, "ATN2", "A2");

        const deployments = await factory.getAutonetsByDeployer(deployer.address);
        expect(deployments.length).to.equal(2);

        expect(await factory.getDeployedCount()).to.equal(2);
    });

    it("should enforce one-per-economy when enabled", async function () {
        await factory.setEnforcement(true);

        await factory.createAutonet(mockEconomy, mockRegistry, mockRepToken, mockTimelock, "ATN1", "A1");

        await expect(
            factory.createAutonet(mockEconomy, mockRegistry, mockRepToken, mockTimelock, "ATN2", "A2")
        ).to.be.revertedWithCustomError(factory, "AlreadyDeployedForEconomy");
    });

    it("should allow multiple per economy when not enforced", async function () {
        await factory.createAutonet(mockEconomy, mockRegistry, mockRepToken, mockTimelock, "ATN1", "A1");
        await factory.createAutonet(mockEconomy, mockRegistry, mockRepToken, mockTimelock, "ATN2", "A2");

        expect(await factory.getDeployedCount()).to.equal(2);
    });
});
