const { ethers } = require("hardhat");

/**
 * Test configureAndFinalize with exact parameters from the failed deployment
 * Usage: npx hardhat run scripts/testConfigureAndFinalize.js --network ets
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Testing with account:", deployer.address);

  // TrustlessFactory address
  const factoryAddress = "0x022D1a8257Ea9145c9C71Ab45F09a396167eabD3";

  // Parameters from the failed deployment logs
  const addressParams = {
    implAddresses: [
      "0xE6d70C82ea31a0C73EE5Dc4d2cF3275BCBBa36Cd", // nativeProjectImpl
      "0xD4D3465539d614c7C8fC2814dCBb1bCBccaF390d"  // erc20ProjectImpl
    ],
    contractAddresses: [
      "0xb15db9a7dc1a68ba9ba22b32f9fda4d6f2bb6ad6", // economy
      "0xe03871dae7c549d4120a75ed6619ccd333051c05", // registry
      "0xb7b447850d86075a9724f80264d135c0bfb6f9bf", // timelock
      "0x9c768ffec4297e185378403d654316df245c6d16", // repToken
      "0x5e240a0b3e7d3c936c264eec18f7b60acd551954"  // dao
    ]
  };

  const economyParams = {
    arbitrationFeeBps: 300,
    initialPlatformFeeBps: 100,
    initialAuthorFeeBps: 100,
    initialCoolingOffPeriod: 60,
    initialBackersQuorumBps: 5000,
    initialProjectThreshold: 100,
    initialAppealPeriod: 300
  };

  const registryKeys = [
    "jurisdiction.parity.0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "jurisdiction.parity.0x475f58a990f8be262f849ef4ab201e8e7b8d70d6",
    "description"
  ];

  const registryValues = [
    "1",
    "1",
    "Quick test Economy DAO"
  ];

  console.log("\n=== Testing configureAndFinalize ===");
  console.log("Factory:", factoryAddress);
  console.log("addressParams:", JSON.stringify(addressParams, null, 2));
  console.log("economyParams:", JSON.stringify(economyParams, null, 2));
  console.log("registryKeys:", registryKeys);
  console.log("registryValues:", registryValues);

  const factory = await ethers.getContractAt("TrustlessFactory", factoryAddress);

  try {
    // Try static call first to get revert reason
    console.log("\nTrying staticCall to get revert reason...");
    await factory.configureAndFinalize.staticCall(
      addressParams,
      economyParams,
      registryKeys,
      registryValues
    );
    console.log("staticCall succeeded - now sending actual transaction...");

    // Send actual transaction
    const tx = await factory.configureAndFinalize(
      addressParams,
      economyParams,
      registryKeys,
      registryValues,
      { gasLimit: 8000000 }
    );
    console.log("Transaction sent:", tx.hash);
    console.log("Waiting for confirmation...");
    const receipt = await tx.wait();
    console.log("Transaction confirmed! Status:", receipt.status);
    console.log("Gas used:", receipt.gasUsed.toString());
  } catch (error) {
    console.log("\n=== REVERT REASON ===");
    console.log(error.message);
    if (error.reason) console.log("Reason:", error.reason);
    if (error.data) console.log("Data:", error.data);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
