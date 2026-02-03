const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("Deploying TrustlessFactory and dependencies to Etherlink Shadownet Testnet...\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "ETH\n");

  // Step 1: Deploy project implementations
  console.log("1. Deploying project implementations...");
  const NativeProject = await ethers.getContractFactory("NativeProject");
  const nativeProject = await NativeProject.deploy();
  await nativeProject.waitForDeployment();
  const nativeAddr = await nativeProject.getAddress();
  console.log("   NativeProject deployed at:", nativeAddr);

  const ERC20Project = await ethers.getContractFactory("ERC20Project");
  const erc20Project = await ERC20Project.deploy();
  await erc20Project.waitForDeployment();
  const erc20Addr = await erc20Project.getAddress();
  console.log("   ERC20Project deployed at:", erc20Addr);

  // Step 2: Deploy InfrastructureFactory
  console.log("2. Deploying InfrastructureFactory...");
  const InfrastructureFactory = await ethers.getContractFactory("InfrastructureFactory");
  const infrastructureFactory = await InfrastructureFactory.deploy();
  await infrastructureFactory.waitForDeployment();
  const infraAddr = await infrastructureFactory.getAddress();
  console.log("   InfrastructureFactory deployed at:", infraAddr);

  // Step 3: Deploy DAOFactory
  console.log("3. Deploying DAOFactory...");
  const DAOFactory = await ethers.getContractFactory("DAOFactory");
  const daoFactory = await DAOFactory.deploy();
  await daoFactory.waitForDeployment();
  const daoFactoryAddr = await daoFactory.getAddress();
  console.log("   DAOFactory deployed at:", daoFactoryAddr);

  // Step 4: Deploy EconomyFactory
  console.log("4. Deploying EconomyFactory...");
  const EconomyFactory = await ethers.getContractFactory("EconomyFactory");
  const economyFactory = await EconomyFactory.deploy();
  await economyFactory.waitForDeployment();
  const economyFactoryAddr = await economyFactory.getAddress();
  console.log("   EconomyFactory deployed at:", economyFactoryAddr);

  // Step 5: Deploy RepTokenFactory
  console.log("5. Deploying RepTokenFactory...");
  const RepTokenFactory = await ethers.getContractFactory("RepTokenFactory");
  const repTokenFactory = await RepTokenFactory.deploy();
  await repTokenFactory.waitForDeployment();
  const repTokenFactoryAddr = await repTokenFactory.getAddress();
  console.log("   RepTokenFactory deployed at:", repTokenFactoryAddr);

  // Step 6: Deploy TrustlessFactory (the wrapper contract)
  console.log("6. Deploying TrustlessFactory (wrapper contract)...");
  const TrustlessFactory = await ethers.getContractFactory("TrustlessFactory");
  const trustlessFactory = await TrustlessFactory.deploy(
    infraAddr,
    daoFactoryAddr,
    economyFactoryAddr,
    repTokenFactoryAddr
  );
  await trustlessFactory.waitForDeployment();
  const trustlessFactoryAddr = await trustlessFactory.getAddress();
  console.log("   TrustlessFactory deployed at:", trustlessFactoryAddr);

  // Save deployment addresses
  const deploymentInfo = {
    network: "Etherlink-Shadownet",
    chainId: 127823,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    projectImplementations: {
      nativeProject: nativeAddr,
      erc20Project: erc20Addr
    },
    contracts: {
      infrastructureFactory: infraAddr,
      daoFactory: daoFactoryAddr,
      economyFactory: economyFactoryAddr,
      repTokenFactory: repTokenFactoryAddr,
      trustlessFactory: trustlessFactoryAddr
    }
  };

  const outputPath = path.join(__dirname, "..", "deployments", "etherlink-shadownet-trustless.json");
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(deploymentInfo, null, 2));

  console.log("\nDeployment complete!");
  console.log("\nDeployment info saved to:", outputPath);
  console.log("\nSummary:");
  console.log("========================================");
  console.log("TrustlessFactory (wrapper):", trustlessFactoryAddr);
  console.log("----------------------------------------");
  console.log("Project Implementations:");
  console.log("  NativeProject:         ", nativeAddr);
  console.log("  ERC20Project:          ", erc20Addr);
  console.log("----------------------------------------");
  console.log("Factories:");
  console.log("  InfrastructureFactory: ", infraAddr);
  console.log("  DAOFactory:            ", daoFactoryAddr);
  console.log("  EconomyFactory:        ", economyFactoryAddr);
  console.log("  RepTokenFactory:       ", repTokenFactoryAddr);
  console.log("========================================");
  console.log("\nNext steps:");
  console.log("1. Update Firestore with TrustlessFactory wrapper address:", trustlessFactoryAddr);
  console.log("2. Test 3-step economy DAO deployment");
  console.log("3. Verify indexer captures NewDaoCreated event");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
