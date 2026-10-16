// Publishes a new build of a module: deploys a fresh setup and creates the next version in its repo
// with the current modules/<name>/ metadata, in the latest release. The signer must own the repo.
//   MODULE=economy CATALOG=0x... npx hardhat run scripts/publish-module-build.js --network <net>
const { ethers } = require("hardhat");
const { deployAutonetSetup, metadata, dataUri } = require("./lib/modules");

async function main() {
    const name = process.env.MODULE, catalogAddr = process.env.CATALOG;
    if (!name || !catalogAddr) throw new Error("set MODULE and CATALOG");
    const [signer] = await ethers.getSigners();
    const catalog = await ethers.getContractAt("ModuleCatalog", catalogAddr, signer);
    const repo = await ethers.getContractAt("ModuleRepo", await catalog.repoOf(name), signer);
    const latest = await repo.latestVersion();
    const deploy = async (contract, ...args) => {
        const c = await (await ethers.getContractFactory(contract, signer)).deploy(...args);
        return c.waitForDeployment();
    };
    let setup;
    if (name === "economy") {
        // Same project implementations as the build it replaces
        const prev = await ethers.getContractAt("EconomySetup", latest.setup);
        setup = await deploy("EconomySetup", await prev.nativeProjectImpl(), await prev.erc20ProjectImpl(), await prev.minCoolingOffPeriod());
    } else if (name === "content_court") setup = await deploy("ContentCourtSetup");
    else if (name === "autonet") setup = await deployAutonetSetup(ethers, signer);
    else throw new Error(`unknown module ${name}`);
    const release = latest.release;
    await (await repo.createVersion(release, await setup.getAddress(),
        dataUri(metadata(name, "build")), dataUri(metadata(name, "release")))).wait();
    const v = await repo.latestVersion();
    console.log(`${name} ${v.release}.${v.build}: setup ${v.setup}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
