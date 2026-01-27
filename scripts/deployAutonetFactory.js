const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const networkName = hre.network.name;
  console.log(`Deploying AutonetFactory to ${networkName}...\n`);

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "XTZ\n");

  // Get existing jurisdiction addresses based on network
  let existingDeployment;
  let jurisdictionName;

  if (networkName === "ets") {
    // Etherlink Shadownet
    const deployPath = path.join(__dirname, "..", "deployments", "etherlink-shadownet-trustless.json");
    existingDeployment = JSON.parse(fs.readFileSync(deployPath, "utf8"));
    jurisdictionName = "Etherlink-Shadownet";
  } else if (networkName === "baseSepolia") {
    const deployPath = path.join(__dirname, "..", "deployments", "baseSepolia-trustless.json");
    existingDeployment = JSON.parse(fs.readFileSync(deployPath, "utf8"));
    jurisdictionName = "Base-Sepolia";
  } else {
    console.log("Using mock addresses for local/test network");
    existingDeployment = null;
    jurisdictionName = networkName;
  }

  // Step 1: Deploy mock Registry for implementation (just for the reference)
  // The actual Registry will come from the jurisdiction
  console.log("1. Deploying AutonetMockRegistry (for implementation reference)...");
  const MockRegistry = await ethers.getContractFactory("AutonetMockRegistry");
  const mockRegistry = await MockRegistry.deploy();
  await mockRegistry.waitForDeployment();
  const mockRegistryAddr = await mockRegistry.getAddress();
  console.log("   AutonetMockRegistry deployed at:", mockRegistryAddr);

  // Step 2: Deploy mock RepToken for implementation
  console.log("2. Deploying AutonetMockRepToken (for implementation reference)...");
  const MockRepToken = await ethers.getContractFactory("AutonetMockRepToken");
  const mockRepToken = await MockRepToken.deploy("Mock Rep", "MREP");
  await mockRepToken.waitForDeployment();
  const mockRepTokenAddr = await mockRepToken.getAddress();
  console.log("   AutonetMockRepToken deployed at:", mockRepTokenAddr);

  // Step 3: Deploy Autonet implementation (used as reference by factory)
  console.log("3. Deploying Autonet implementation...");
  const Autonet = await ethers.getContractFactory("Autonet");
  const autonetImpl = await Autonet.deploy(
    deployer.address,  // mock economy
    mockRegistryAddr,  // mock registry (payable)
    mockRepTokenAddr,  // mock rep token
    deployer.address,  // mock timelock
    "Autonet Implementation",
    "IMPL"
  );
  await autonetImpl.waitForDeployment();
  const autonetImplAddr = await autonetImpl.getAddress();
  console.log("   Autonet implementation deployed at:", autonetImplAddr);

  // Step 4: Deploy AutonetFactory
  console.log("4. Deploying AutonetFactory...");
  const AutonetFactory = await ethers.getContractFactory("AutonetFactory");
  const autonetFactory = await AutonetFactory.deploy(
    autonetImplAddr,
    false  // Don't enforce one-per-economy initially
  );
  await autonetFactory.waitForDeployment();
  const autonetFactoryAddr = await autonetFactory.getAddress();
  console.log("   AutonetFactory deployed at:", autonetFactoryAddr);

  // Save deployment info
  const deploymentInfo = {
    network: jurisdictionName,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      autonetFactory: autonetFactoryAddr,
      autonetImplementation: autonetImplAddr,
      mockRegistry: mockRegistryAddr,
      mockRepToken: mockRepTokenAddr
    },
    existingJurisdiction: existingDeployment ? existingDeployment.contracts : null
  };

  const outputPath = path.join(__dirname, "..", "deployments", `${networkName}-autonet.json`);
  fs.writeFileSync(outputPath, JSON.stringify(deploymentInfo, null, 2));

  console.log("\nDeployment complete!");
  console.log("\nDeployment info saved to:", outputPath);
  console.log("\nSummary:");
  console.log("========================================");
  console.log("AutonetFactory:        ", autonetFactoryAddr);
  console.log("Autonet Implementation:", autonetImplAddr);
  console.log("========================================");

  if (existingDeployment) {
    console.log("\nTo create an Autonet for an existing jurisdiction, call:");
    console.log(`  autonetFactory.createAutonet(`);
    console.log(`    "${existingDeployment.contracts.infrastructureFactory}", // economy placeholder`);
    console.log(`    "<registry_address>",  // from jurisdiction`);
    console.log(`    "<repToken_address>",  // from jurisdiction`);
    console.log(`    "<timelock_address>",  // from jurisdiction`);
    console.log(`    "Autonet Credits - YourJurisdiction",`);
    console.log(`    "ATN-SYMBOL"`);
    console.log(`  )`);
  }

  console.log("\nFirestore update:");
  console.log(`  chains/${jurisdictionName}: { autonetFactory: "${autonetFactoryAddr}" }`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
