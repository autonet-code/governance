const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

async function updateFirestoreLocalhost() {
  // Check if we should use the emulator
  const useEmulator = process.env.FIRESTORE_EMULATOR_HOST;

  // Read deployment info
  const deploymentPath = path.join(__dirname, '../deployments/localhost-all.json');
  if (!fs.existsSync(deploymentPath)) {
    console.error('Error: localhost-all.json not found. Run deployAllLocal.js first.');
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

  // Initialize Firebase Admin
  const serviceAccount = require(path.join(__dirname, '../../indexer/homebase.json'));

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  const db = admin.firestore();

  // Localhost configuration for DAO app (werule)
  const localhostConfig = {
    rpc: 'http://127.0.0.1:8545',
    chainId: deployment.chainId,
    daoFactory: deployment.factories.daoFactory,
    wrapper: deployment.wrappers.wrapper,
    wrapper_t: deployment.wrappers.wrapper_t,
    wrapper_w: deployment.wrappers.wrapper,  // Use non-transferable as fallback
    wrapper_trustless: deployment.wrappers.wrapper_trustless,
    nativeProjectImpl: deployment.projectImplementations.nativeProject,
    erc20ProjectImpl: deployment.projectImplementations.erc20Project,
    infrastructureFactory: deployment.factories.infrastructureFactory,
    repTokenFactory: deployment.factories.repTokenFactory,
    economyFactory: deployment.factories.economyFactory,
    nativeCurrency: 'ETH',
    symbol: 'ETH',
    blockExplorer: ''
  };

  console.log('Updating Firestore configuration for Localhost...');
  if (useEmulator) {
    console.log(`Using Firestore emulator at: ${useEmulator}\n`);
  } else {
    console.log('Using production Firestore\n');
  }

  try {
    // Update contracts collection
    const contractsRef = db.collection('contracts').doc('Localhost');
    const contractsDoc = await contractsRef.get();

    if (!contractsDoc.exists) {
      console.log('Creating new Localhost document...');
      await contractsRef.set(localhostConfig);
    } else {
      console.log('Updating existing Localhost document...');
      await contractsRef.update(localhostConfig);
    }

    console.log('\nLocalhost configuration:');
    console.log('  rpc:', localhostConfig.rpc);
    console.log('  chainId:', localhostConfig.chainId);
    console.log('  daoFactory:', localhostConfig.daoFactory);
    console.log('  wrapper:', localhostConfig.wrapper);
    console.log('  wrapper_t:', localhostConfig.wrapper_t);
    console.log('  wrapper_trustless:', localhostConfig.wrapper_trustless);
    console.log('  nativeProjectImpl:', localhostConfig.nativeProjectImpl);
    console.log('  erc20ProjectImpl:', localhostConfig.erc20ProjectImpl);
    console.log('  infrastructureFactory:', localhostConfig.infrastructureFactory);
    console.log('  repTokenFactory:', localhostConfig.repTokenFactory);
    console.log('  economyFactory:', localhostConfig.economyFactory);

    console.log('\n✅ Firestore updated successfully!');

  } catch (error) {
    console.error('Error updating Firestore:', error);
    process.exit(1);
  }

  process.exit(0);
}

updateFirestoreLocalhost();
