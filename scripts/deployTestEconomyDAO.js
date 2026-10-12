const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("Testing 3-step Economy DAO deployment on Etherlink Testnet...\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "ETH\n");

  // Load deployed TrustlessFactory address
  const deploymentPath = path.join(__dirname, "..", "deployments", "etherlink-testnet-trustless.json");
  const deploymentInfo = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const trustlessFactoryAddr = deploymentInfo.contracts.trustlessFactory;
  const nativeProjectAddr = deploymentInfo.projectImplementations.nativeProject;
  const erc20ProjectAddr = deploymentInfo.projectImplementations.erc20Project;

  console.log("Using TrustlessFactory at:", trustlessFactoryAddr);
  console.log("NativeProject implementation:", nativeProjectAddr);
  console.log("ERC20Project implementation:", erc20ProjectAddr);
  console.log();

  const TrustlessFactory = await ethers.getContractFactory("TrustlessFactory");
  const trustlessFactory = TrustlessFactory.attach(trustlessFactoryAddr);

  // Step 1: Deploy Infrastructure (Economy, Timelock, Registry)
  console.log("Step 1: Deploying infrastructure...");
  const timelockDelayInMinutes = 2; // 2 minutes for testing
  const tx1 = await trustlessFactory.deployInfrastructure(timelockDelayInMinutes);
  const receipt1 = await tx1.wait();

  // Parse InfrastructureDeployed event
  const infraEvent = receipt1.logs.find(log => {
    try {
      const parsed = trustlessFactory.interface.parseLog(log);
      return parsed.name === "InfrastructureDeployed";
    } catch (e) {
      return false;
    }
  });

  if (!infraEvent) {
    throw new Error("InfrastructureDeployed event not found");
  }

  const parsedInfraEvent = trustlessFactory.interface.parseLog(infraEvent);
  const economyAddr = parsedInfraEvent.args.economy;
  const registryAddr = parsedInfraEvent.args.registry;
  const timelockAddr = parsedInfraEvent.args.timelock;

  console.log("   Economy deployed at:", economyAddr);
  console.log("   Registry deployed at:", registryAddr);
  console.log("   Timelock deployed at:", timelockAddr);
  console.log();

  // Step 2: Deploy DAO and Token
  console.log("Step 2: Deploying DAO and RepToken...");

  const tokenParams = {
    name: "Test Economy DAO Token",
    symbol: "TEDT",
    initialMembers: [
      ethers.getAddress("0x06e5b15bc39f921e1503073dbb8a5da2fc6220e9"),
      ethers.getAddress("0x6e147e1d239bf49c88d64505e746e8522845d8d3")
    ],
    initialAmounts: [
      ethers.parseEther("100"),
      ethers.parseEther("50")
    ]
  };

  const govParams = {
    name: "Test Economy DAO Governor",
    votingDelay: 1, // minutes
    votingPeriod: 50400, // ~1 week
    proposalThreshold: ethers.parseEther("10"),
    quorumFraction: 4 // 4%
  };

  const tx2 = await trustlessFactory.deployDAOToken(
    registryAddr,
    timelockAddr,
    tokenParams,
    govParams
  );
  const receipt2 = await tx2.wait();

  // Parse DAOTokenDeployed event
  const daoTokenEvent = receipt2.logs.find(log => {
    try {
      const parsed = trustlessFactory.interface.parseLog(log);
      return parsed.name === "DAOTokenDeployed";
    } catch (e) {
      return false;
    }
  });

  if (!daoTokenEvent) {
    throw new Error("DAOTokenDeployed event not found");
  }

  const parsedDAOTokenEvent = trustlessFactory.interface.parseLog(daoTokenEvent);
  const repTokenAddr = parsedDAOTokenEvent.args.repToken;
  const daoAddr = parsedDAOTokenEvent.args.dao;

  console.log("   RepToken deployed at:", repTokenAddr);
  console.log("   DAO deployed at:", daoAddr);
  console.log();

  // Step 3: Configure and Finalize
  console.log("Step 3: Configuring and finalizing...");

  const addressParams = {
    implAddresses: [nativeProjectAddr, erc20ProjectAddr],
    contractAddresses: [economyAddr, registryAddr, timelockAddr, repTokenAddr, daoAddr]
  };

  const economyParams = {
    initialPlatformFeeBps: 250,        // 2.5%
    initialAuthorFeeBps: 500,          // 5%
    initialCoolingOffPeriod: 259200,   // 3 days in seconds
    initialBackersQuorumBps: 5100,     // 51%
    initialProjectThreshold: ethers.parseEther("10"), // 10 tokens
    initialAppealPeriod: 604800        // 7 days in seconds
  };

  // Initial registry entries for token parity
  // Native currency (0xEeee...eeee) parity: 1:1 (1e18 = 1 token earns 1 reputation)
  const NATIVE_CURRENCY_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const registryKeys = [
    `jurisdiction.parity.${NATIVE_CURRENCY_ADDRESS}`,
    "benefits.claim.gracePeriod"
  ];
  const registryValues = [
    "1000000000000000000",  // 1e18 = 1:1 parity for native currency
    "2592000"              // 30 days grace period for benefits claims
  ];

  console.log("   Setting initial registry entries:");
  for (let i = 0; i < registryKeys.length; i++) {
    console.log(`     ${registryKeys[i]}: ${registryValues[i]}`);
  }

  const tx3 = await trustlessFactory.configureAndFinalize(
    addressParams,
    economyParams,
    registryKeys,
    registryValues
  );
  const receipt3 = await tx3.wait();

  console.log("   Configuration complete!");
  console.log();

  // Check for NewDaoCreated event
  console.log("Verifying NewDaoCreated event emission...");
  const newDaoEvent = receipt3.logs.find(log => {
    try {
      const parsed = trustlessFactory.interface.parseLog(log);
      return parsed.name === "NewDaoCreated";
    } catch (e) {
      return false;
    }
  });

  if (newDaoEvent) {
    const parsedNewDaoEvent = trustlessFactory.interface.parseLog(newDaoEvent);
    console.log("✓ NewDaoCreated event emitted successfully!");
    console.log("   DAO Address:", parsedNewDaoEvent.args.dao);
    console.log("   Token Address:", parsedNewDaoEvent.args.token);
    console.log("   Name:", parsedNewDaoEvent.args.name);
    console.log("   Symbol:", parsedNewDaoEvent.args.symbol);
    console.log("   Description:", parsedNewDaoEvent.args.description);
    console.log("   Execution Delay:", parsedNewDaoEvent.args.executionDelay.toString(), "seconds");
    console.log("   Registry:", parsedNewDaoEvent.args.registry);
  } else {
    console.log("✗ NewDaoCreated event NOT found!");
  }
  console.log();

  // Save deployment info (convert BigInt to string for JSON)
  const testDeploymentInfo = {
    network: "Etherlink-Testnet",
    chainId: 128123,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    daoType: "Economy",
    addresses: {
      trustlessFactory: trustlessFactoryAddr,
      economy: economyAddr,
      registry: registryAddr,
      timelock: timelockAddr,
      repToken: repTokenAddr,
      dao: daoAddr
    },
    parameters: {
      token: {
        name: tokenParams.name,
        symbol: tokenParams.symbol,
        initialMembers: tokenParams.initialMembers,
        initialAmounts: tokenParams.initialAmounts.map(a => a.toString())
      },
      governance: {
        name: govParams.name,
        votingDelay: govParams.votingDelay,
        votingPeriod: govParams.votingPeriod,
        proposalThreshold: govParams.proposalThreshold.toString(),
        quorumFraction: govParams.quorumFraction
      },
      economy: {
        initialPlatformFeeBps: economyParams.initialPlatformFeeBps,
        initialAuthorFeeBps: economyParams.initialAuthorFeeBps,
        initialCoolingOffPeriod: economyParams.initialCoolingOffPeriod,
        initialBackersQuorumBps: economyParams.initialBackersQuorumBps,
        initialProjectThreshold: economyParams.initialProjectThreshold.toString(),
        initialAppealPeriod: economyParams.initialAppealPeriod
      },
      registry: Object.fromEntries(registryKeys.map((k, i) => [k, registryValues[i]]))
    }
  };

  const outputPath = path.join(__dirname, "..", "deployments", "test-economy-dao.json");
  fs.writeFileSync(outputPath, JSON.stringify(testDeploymentInfo, null, 2));

  console.log("========================================");
  console.log("Test Economy DAO Deployment Complete!");
  console.log("========================================");
  console.log("DAO Address:          ", daoAddr);
  console.log("RepToken Address:     ", repTokenAddr);
  console.log("Economy Address:      ", economyAddr);
  console.log("Registry Address:     ", registryAddr);
  console.log("Timelock Address:     ", timelockAddr);
  console.log("========================================");
  console.log("\nDeployment info saved to:", outputPath);
  console.log("\nNext steps:");
  console.log("1. Check indexer logs to verify NewDaoCreated event was captured");
  console.log("2. Verify DAO appears in Firestore database");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
