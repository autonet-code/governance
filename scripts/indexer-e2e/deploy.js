// Indexer end-to-end, phase A: deploy the factory suite to a local node and record addresses.
//   npx hardhat run scripts/indexer-e2e/deploy.js --network localhost
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function deploy(name, ...args) {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    return c.getAddress();
}

async function main() {
    const infra = await deploy("InfrastructureFactory");
    const daoFactory = await deploy("DAOFactory");
    const repTokenFactory = await deploy("RepTokenFactory");
    const economyFactory = await deploy("EconomyFactory");
    const wrappedRepTokenFactory = await deploy("WrappedRepTokenFactory");
    const out = {
        rpc: "http://127.0.0.1:8545",
        chainId: 31337,
        wrapper: await deploy("StandardFactory", infra, daoFactory, repTokenFactory),
        wrapper_t: await deploy("StandardFactoryTransferable", infra, daoFactory, repTokenFactory),
        wrapper_w: await deploy("StandardFactoryWrapped", infra, daoFactory, wrappedRepTokenFactory),
        wrapper_trustless: await deploy("TrustlessFactory", infra, daoFactory, economyFactory, repTokenFactory),
        nativeProjectImpl: await deploy("NativeProject"),
        erc20ProjectImpl: await deploy("ERC20Project"),
        infrastructureFactory: infra, daoFactory, repTokenFactory, economyFactory, wrappedRepTokenFactory,
        nativeCurrency: "ETH", symbol: "ETH", blockExplorer: "",
    };
    const file = path.join(__dirname, "out", "deployment.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
