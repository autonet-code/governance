const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("Deploying Standard DAO Factories to Etherlink Shadownet Testnet...\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "ETH\n");

  // Reuse existing factories from TrustlessFactory deployment
  const infraAddr = "0xd30455f4F9a22375E4852Aa6D5DAe281107a71ad";
  const daoFactoryAddr = "0x96eF8D2c5A1966cCcbD6c701089811327Bfc3f27";
  const repTokenFactoryAddr = "0xc1275b1F8f11D735d0e47b7Fb0804a01D00821d6";

  console.log("Reusing existing factories from TrustlessFactory deployment:");
  console.log("   InfrastructureFactory:", infraAddr);
  console.log("   DAOFactory:", daoFactoryAddr);
  console.log("   RepTokenFactory:", repTokenFactoryAddr);
  console.log();

  // Step 1: Deploy StandardFactory (non-transferable wrapper)
  console.log("1. Deploying StandardFactory (wrapper - non-transferable)...");
  const StandardFactory = await ethers.getContractFactory("StandardFactory");
  const standardFactory = await StandardFactory.deploy(
    infraAddr,
    daoFactoryAddr,
    repTokenFactoryAddr
  );
  await standardFactory.waitForDeployment();
  const standardFactoryAddr = await standardFactory.getAddress();
  console.log("   StandardFactory deployed at:", standardFactoryAddr);

  // Step 2: Deploy StandardFactoryTransferable (wrapper_t)
  console.log("2. Deploying StandardFactoryTransferable (wrapper_t - transferable)...");
  const StandardFactoryTransferable = await ethers.getContractFactory("StandardFactoryTransferable");
  const standardFactoryTransferable = await StandardFactoryTransferable.deploy(
    infraAddr,
    daoFactoryAddr,
    repTokenFactoryAddr
  );
  await standardFactoryTransferable.waitForDeployment();
  const standardFactoryTransferableAddr = await standardFactoryTransferable.getAddress();
  console.log("   StandardFactoryTransferable deployed at:", standardFactoryTransferableAddr);

  // Step 3: Deploy WrappedRepTokenFactory for wrapper_w
  console.log("3. Deploying WrappedRepTokenFactory...");
  const WrappedRepTokenFactory = await ethers.getContractFactory("WrappedRepTokenFactory");
  const wrappedRepTokenFactory = await WrappedRepTokenFactory.deploy();
  await wrappedRepTokenFactory.waitForDeployment();
  const wrappedRepTokenFactoryAddr = await wrappedRepTokenFactory.getAddress();
  console.log("   WrappedRepTokenFactory deployed at:", wrappedRepTokenFactoryAddr);

  // Step 4: Deploy StandardFactoryWrapped (wrapper_w)
  console.log("4. Deploying StandardFactoryWrapped (wrapper_w - wrapped ERC20)...");
  const StandardFactoryWrapped = await ethers.getContractFactory("StandardFactoryWrapped");
  const standardFactoryWrapped = await StandardFactoryWrapped.deploy(
    infraAddr,
    daoFactoryAddr,
    wrappedRepTokenFactoryAddr
  );
  await standardFactoryWrapped.waitForDeployment();
  const standardFactoryWrappedAddr = await standardFactoryWrapped.getAddress();
  console.log("   StandardFactoryWrapped deployed at:", standardFactoryWrappedAddr);

  // Save deployment addresses
  const deploymentInfo = {
    network: "Etherlink-Shadownet",
    chainId: 127823,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    reusedContracts: {
      infrastructureFactory: infraAddr,
      daoFactory: daoFactoryAddr,
      repTokenFactory: repTokenFactoryAddr
    },
    newContracts: {
      standardFactory: standardFactoryAddr,
      standardFactoryTransferable: standardFactoryTransferableAddr,
      wrappedRepTokenFactory: wrappedRepTokenFactoryAddr,
      standardFactoryWrapped: standardFactoryWrappedAddr
    }
  };

  const outputPath = path.join(__dirname, "..", "deployments", "etherlink-shadownet-standard.json");
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(deploymentInfo, null, 2));

  console.log("\nDeployment complete!");
  console.log("\nDeployment info saved to:", outputPath);
  console.log("\nSummary:");
  console.log("========================================");
  console.log("StandardFactory (wrapper):            ", standardFactoryAddr);
  console.log("StandardFactoryTransferable (wrapper_t):", standardFactoryTransferableAddr);
  console.log("StandardFactoryWrapped (wrapper_w):   ", standardFactoryWrappedAddr);
  console.log("========================================");
  console.log("\nFirestore fields to add to Etherlink-Shadownet document:");
  console.log(`   wrapper: ${standardFactoryAddr}`);
  console.log(`   wrapper_t: ${standardFactoryTransferableAddr}`);
  console.log(`   wrapper_w: ${standardFactoryWrappedAddr}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
