// Deploys AutonetGenesis with the autonet contracts' creation code stored on-chain as code blobs
// (runtime code = 0x00 STOP byte + creation code, the SSTORE2 layout AutonetGenesis reads).
// Creation code comes from test/fixtures/autonet, synced by scripts/sync-autonet-artifacts.js.
const path = require("path");

const BLOBS = ["Substrate", "ServiceRegistry", "PaymentChannel", "VentureVaultFactory", "CharterAnchor"];

// Creation code that returns everything after its own 10 bytes as the runtime code
function blobInitCode(data) {
    const body = "00" + data.replace(/^0x/, "");
    const len = body.length / 2;
    if (len > 0x6000) throw new Error(`code blob too large: ${len} bytes`);
    return "0x61" + len.toString(16).padStart(4, "0") + "80600a3d393df3" + body;
}

async function deployBlob(signer, bytecode) {
    const tx = await signer.sendTransaction({ data: blobInitCode(bytecode) });
    const rc = await tx.wait();
    return rc.contractAddress;
}

async function deployAutonetGenesis(ethers, signer, log = () => {}) {
    const blobs = [];
    for (const name of BLOBS) {
        const a = require(path.join(__dirname, "..", "..", "test", "fixtures", "autonet", `${name}.json`));
        blobs.push(await deployBlob(signer, a.bytecode));
        log(`  ${name} code blob: ${blobs[blobs.length - 1]}`);
    }
    const genesis = await (await ethers.getContractFactory("AutonetGenesis", signer)).deploy(...blobs);
    await genesis.waitForDeployment();
    return genesis;
}

module.exports = { BLOBS, blobInitCode, deployBlob, deployAutonetGenesis };
