// Redeploy only the NativeProject / ERC20Project implementations to Etherlink Shadownet.
// Economies get their implementation addresses from Firestore (nativeProjectImpl / erc20ProjectImpl)
// when created through the web app, so factories don't need redeploying for project-only changes.
const { ethers } = require("hardhat");

async function main() {
    const net = await ethers.provider.getNetwork();
    if (net.chainId !== 127823n) throw new Error(`Wrong network: expected 127823 (shadownet), got ${net.chainId}`);
    for (const name of ["NativeProject", "ERC20Project"]) {
        const c = await (await ethers.getContractFactory(name)).deploy();
        await c.waitForDeployment();
        console.log(`${name}: ${await c.getAddress()}`);
    }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
