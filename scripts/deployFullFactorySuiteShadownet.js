// Deploy the FULL fresh DAO factory suite to Etherlink Shadownet (ets, chainId 127823).
//
// Everything is deployed fresh from current source. NO base factory is reused --
// especially RepTokenFactory, which embeds the current RepToken creation bytecode
// (with setMinter). All wrappers are wired to the freshly deployed base factories.
//
// Produces the Firestore field mapping:
//   wrapper            -> StandardFactory (soulbound)
//   wrapper_t          -> StandardFactoryTransferable
//   wrapper_w          -> StandardFactoryWrapped (wrapped ERC20)
//   wrapper_trustless  -> TrustlessFactory
//   nativeProject      -> NativeProject implementation
//   erc20Project       -> ERC20Project implementation
//   modules            -> { autonet: AutonetGenesis, content_court: ContentCourtFactory }, the
//                         module factories werule offers (AutonetGenesis with the autonet
//                         contracts' code blobs from test/fixtures/autonet)
//   moduleAttacher     -> ModuleAttacher (builds attach/detach proposals for live DAOs)
//
// Also writes deployments/<shadownet|localhost>-trustless.json for deploy-autonet-jurisdiction.js.
// Runs on localhost (31337) too, for rehearsals against `npx hardhat node`.
//
// Sequential nonces from one key -- do not parallelize.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deployAutonetGenesis } = require("./lib/autonet-genesis");

async function deploy(name, ...args) {
  const F = await ethers.getContractFactory(name);
  const c = await F.deploy(...args);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`   ${name} deployed at: ${addr}`);
  return addr;
}

async function main() {
  console.log("Deploying FULL fresh DAO factory suite to Etherlink Shadownet...\n");

  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log("Deployer:", deployer.address);
  console.log("ChainId :", net.chainId.toString());
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance :", ethers.formatEther(balance), "native\n");

  const local = net.chainId === 31337n;
  if (net.chainId !== 127823n && !local) {
    throw new Error(`Wrong network: expected chainId 127823 (shadownet) or 31337, got ${net.chainId}`);
  }

  // ---- Base factories (all fresh) ----
  console.log("Base factories (fresh):");
  const infraAddr = await deploy("InfrastructureFactory");
  const daoFactoryAddr = await deploy("DAOFactory");
  const repTokenFactoryAddr = await deploy("RepTokenFactory");
  const economyFactoryAddr = await deploy("EconomyFactory");
  const wrappedRepTokenFactoryAddr = await deploy("WrappedRepTokenFactory");

  // ---- Project implementations (fresh) ----
  console.log("\nProject implementations (fresh):");
  const nativeAddr = await deploy("NativeProject");
  const erc20Addr = await deploy("ERC20Project");

  // ---- Wrapper factories, wired to the NEW base factories ----
  console.log("\nWrapper factories (wired to fresh base factories):");
  const standardFactoryAddr = await deploy(
    "StandardFactory",
    infraAddr, daoFactoryAddr, repTokenFactoryAddr
  );
  const standardFactoryTransferableAddr = await deploy(
    "StandardFactoryTransferable",
    infraAddr, daoFactoryAddr, repTokenFactoryAddr
  );
  const standardFactoryWrappedAddr = await deploy(
    "StandardFactoryWrapped",
    infraAddr, daoFactoryAddr, wrappedRepTokenFactoryAddr
  );
  const trustlessFactoryAddr = await deploy(
    "TrustlessFactory",
    infraAddr, daoFactoryAddr, economyFactoryAddr, repTokenFactoryAddr
  );

  // ---- Autonet launcher ----
  console.log("\nAutonetGenesis (code blobs + launcher):");
  const autonetGenesisAddr = await (await deployAutonetGenesis(ethers, deployer, console.log)).getAddress();
  console.log(`   AutonetGenesis deployed at: ${autonetGenesisAddr}`);

  console.log("\nOther modules:");
  const contentCourtFactoryAddr = await deploy("ContentCourtFactory");
  const moduleAttacherAddr = await deploy("ModuleAttacher");

  // ---- Sanity: read back on-chain that wrappers point at the NEW factories ----
  console.log("\nSanity verification (on-chain getters):");
  const sf = await ethers.getContractAt("StandardFactory", standardFactoryAddr);
  const sfRep = await sf.repTokenFactory();
  console.log(`   StandardFactory.repTokenFactory()            = ${sfRep}  ${sfRep === repTokenFactoryAddr ? "OK" : "MISMATCH"}`);

  const sft = await ethers.getContractAt("StandardFactoryTransferable", standardFactoryTransferableAddr);
  const sftRep = await sft.repTokenFactory();
  console.log(`   StandardFactoryTransferable.repTokenFactory()= ${sftRep}  ${sftRep === repTokenFactoryAddr ? "OK" : "MISMATCH"}`);

  const tf = await ethers.getContractAt("TrustlessFactory", trustlessFactoryAddr);
  const tfRep = await tf.repTokenFactory();
  console.log(`   TrustlessFactory.repTokenFactory()           = ${tfRep}  ${tfRep === repTokenFactoryAddr ? "OK" : "MISMATCH"}`);

  const sfw = await ethers.getContractAt("StandardFactoryWrapped", standardFactoryWrappedAddr);
  const sfwRep = await sfw.wrappedRepTokenFactory();
  console.log(`   StandardFactoryWrapped.wrappedRepTokenFactory()= ${sfwRep}  ${sfwRep === wrappedRepTokenFactoryAddr ? "OK" : "MISMATCH"}`);

  const allOk =
    sfRep === repTokenFactoryAddr &&
    sftRep === repTokenFactoryAddr &&
    tfRep === repTokenFactoryAddr &&
    sfwRep === wrappedRepTokenFactoryAddr;

  const deploymentInfo = {
    network: "Etherlink-Shadownet",
    chainId: 127823,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    sanityAllOk: allOk,
    baseFactories: {
      infrastructureFactory: infraAddr,
      daoFactory: daoFactoryAddr,
      repTokenFactory: repTokenFactoryAddr,
      economyFactory: economyFactoryAddr,
      wrappedRepTokenFactory: wrappedRepTokenFactoryAddr
    },
    projectImplementations: {
      nativeProject: nativeAddr,
      erc20Project: erc20Addr
    },
    firestoreFields: {
      wrapper: standardFactoryAddr,
      wrapper_t: standardFactoryTransferableAddr,
      wrapper_w: standardFactoryWrappedAddr,
      wrapper_trustless: trustlessFactoryAddr,
      nativeProject: nativeAddr,
      erc20Project: erc20Addr,
      modules: { autonet: autonetGenesisAddr, content_court: contentCourtFactoryAddr },
      moduleAttacher: moduleAttacherAddr
    }
  };

  const prefix = local ? "localhost" : "etherlink-shadownet";
  const outputPath = path.join(__dirname, "..", "deployments", `${prefix}-full-suite.json`);
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(deploymentInfo, null, 2));
  fs.writeFileSync(path.join(outputDir, `${prefix}-trustless.json`), JSON.stringify({
    network: local ? "localhost" : "ets",
    chainId: Number(net.chainId),
    timestamp: deploymentInfo.timestamp,
    projectImplementations: deploymentInfo.projectImplementations,
    contracts: {
      trustlessFactory: trustlessFactoryAddr,
      autonetGenesis: autonetGenesisAddr,
      contentCourtFactory: contentCourtFactoryAddr,
      moduleAttacher: moduleAttacherAddr,
      ...deploymentInfo.baseFactories
    }
  }, null, 2));

  const finalBalance = await ethers.provider.getBalance(deployer.address);

  console.log("\n========================================");
  console.log("FULL SUITE DEPLOYED. Sanity all OK:", allOk);
  console.log("----------------------------------------");
  console.log("Firestore fields:");
  console.log("  wrapper           (StandardFactory)            :", standardFactoryAddr);
  console.log("  wrapper_t         (StandardFactoryTransferable):", standardFactoryTransferableAddr);
  console.log("  wrapper_w         (StandardFactoryWrapped)     :", standardFactoryWrappedAddr);
  console.log("  wrapper_trustless (TrustlessFactory)           :", trustlessFactoryAddr);
  console.log("  nativeProject     (NativeProject impl)         :", nativeAddr);
  console.log("  erc20Project      (ERC20Project impl)          :", erc20Addr);
  console.log("  modules.autonet       (AutonetGenesis)         :", autonetGenesisAddr);
  console.log("  modules.content_court (ContentCourtFactory)    :", contentCourtFactoryAddr);
  console.log("  moduleAttacher        (ModuleAttacher)         :", moduleAttacherAddr);
  console.log("----------------------------------------");
  console.log("Base factories (for the record):");
  console.log("  InfrastructureFactory :", infraAddr);
  console.log("  DAOFactory            :", daoFactoryAddr);
  console.log("  RepTokenFactory       :", repTokenFactoryAddr);
  console.log("  EconomyFactory        :", economyFactoryAddr);
  console.log("  WrappedRepTokenFactory:", wrappedRepTokenFactoryAddr);
  console.log("----------------------------------------");
  console.log("Final balance:", ethers.formatEther(finalBalance), "native");
  console.log("Saved:", outputPath);
  console.log("========================================");

  if (!allOk) throw new Error("Sanity verification FAILED -- a wrapper does not point at the fresh factory");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
