const { ethers } = require('hardhat');

async function main() {
  console.log('InfrastructureDeployed(address,address,address):', ethers.id('InfrastructureDeployed(address,address,address)'));
  console.log('DAOTokenDeployed(address,address):', ethers.id('DAOTokenDeployed(address,address)'));
}

main();
