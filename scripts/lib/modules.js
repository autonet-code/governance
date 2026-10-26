// The jurisdiction suite: the core factory, the module catalog and processor, and the module setups
// with their published versions (docs/modules.md). Shared by the deploy scripts and the tests.
//
// Module metadata (Aragon OSx format, modules/<name>/{release,build}-metadata.json) is published
// on-chain as data: URIs, so a version needs no external host.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

// ── Code blobs (AutonetSetup reads creation code from them) ──────────────────────

// Autonet contracts come from test/fixtures/autonet (synced by scripts/sync-autonet-artifacts.js);
// ToolBond from this repo's artifacts.
const AUTONET_BLOBS = ["Substrate", "ServiceRegistry", "PaymentChannel", "VentureVaultFactory", "AnchorElection"];

// Creation code that returns everything after its own 10 bytes as the runtime code, behind a 0x00
// STOP byte so the blob can't be called
function blobInitCode(data) {
    const body = "00" + data.replace(/^0x/, "");
    const len = body.length / 2;
    if (len > 0x6000) throw new Error(`code blob too large: ${len} bytes`);
    return "0x61" + len.toString(16).padStart(4, "0") + "80600a3d393df3" + body;
}

async function deployBlob(signer, bytecode) {
    const tx = await signer.sendTransaction({ data: blobInitCode(bytecode) });
    return (await tx.wait()).contractAddress;
}

async function deployAutonetSetup(ethers, signer, log = () => {}) {
    const blobs = [];
    for (const name of AUTONET_BLOBS) {
        const a = require(path.join(ROOT, "test", "fixtures", "autonet", `${name}.json`));
        blobs.push(await deployBlob(signer, a.bytecode));
        log(`  ${name} code blob: ${blobs[blobs.length - 1]}`);
    }
    const toolBond = await ethers.getContractFactory("ToolBond");
    blobs.push(await deployBlob(signer, toolBond.bytecode));
    log(`  ToolBond code blob: ${blobs[blobs.length - 1]}`);
    const setup = await (await ethers.getContractFactory("AutonetSetup", signer)).deploy(...blobs);
    await setup.waitForDeployment();
    return setup;
}

// ── Metadata ─────────────────────────────────────────────────────────────────

function metadata(name, kind) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "modules", name, `${kind}-metadata.json`), "utf8"));
}

function dataUri(obj) {
    return "data:application/json;base64," + Buffer.from(JSON.stringify(obj)).toString("base64");
}

// Solidity JSON ABI input -> ethers param type string
function paramType(input) {
    if (input.type.startsWith("tuple")) {
        return `tuple(${input.components.map((c) => `${paramType(c)} ${c.name}`).join(",")})${input.type.slice(5)}`;
    }
    return input.type;
}

/// The prepareInstallation `data` for module `name`, encoded from its build metadata's inputs.
/// `values` maps input names to values (tuples as objects by component name).
function encodeInstallData(ethers, name, values) {
    const inputs = metadata(name, "build").pluginSetup.prepareInstallation.inputs;
    const toValue = (input, v) => input.type === "tuple"
        ? input.components.map((c) => toValue(c, v[c.name]))
        : v;
    return ethers.AbiCoder.defaultAbiCoder().encode(
        inputs.map(paramType),
        inputs.map((i) => toValue(i, values[i.name])));
}

// ── Suite ────────────────────────────────────────────────────────────────────

const MODULES = ["economy", "content_court", "autonet"];

/// Deploys the core factory, catalog, processor and module setups, and publishes each module's
/// version 1.1 in the catalog. `curator` maintains the repos and the catalog (default: the signer).
/// `minCoolingOff` (seconds) is the cooling-off no Economy can go below: 1 day, 1 minute on a local chain.
async function deployJurisdictionSuite(ethers, signer, { log = () => {}, curator, minCoolingOff } = {}) {
    curator = curator ?? signer.address;
    minCoolingOff = minCoolingOff ?? await defaultMinCoolingOff(ethers);
    const deploy = async (name, ...args) => {
        const c = await (await ethers.getContractFactory(name, signer)).deploy(...args);
        await c.waitForDeployment();
        log(`  ${name}: ${await c.getAddress()}`);
        return c;
    };
    const s = {};
    s.infrastructureFactory = await deploy("InfrastructureFactory");
    s.daoFactory = await deploy("DAOFactory");
    s.repTokenFactory = await deploy("RepTokenFactory");
    s.wrappedRepTokenFactory = await deploy("WrappedRepTokenFactory");
    s.nativeProject = await deploy("NativeProject");
    s.erc20Project = await deploy("ERC20Project");
    // The signer publishes the first versions, then hands the catalog and repos to the curator
    s.catalog = await deploy("ModuleCatalog", signer.address);
    s.processor = await deploy("ModuleProcessor", await s.catalog.getAddress());
    s.jurisdictionFactory = await deploy("JurisdictionFactory",
        await s.infrastructureFactory.getAddress(), await s.daoFactory.getAddress(),
        await s.repTokenFactory.getAddress(), await s.wrappedRepTokenFactory.getAddress(),
        await s.processor.getAddress());

    s.setups = {
        economy: await deploy("EconomySetup", await s.nativeProject.getAddress(), await s.erc20Project.getAddress(), minCoolingOff),
        content_court: await deploy("ContentCourtSetup"),
        autonet: await deployAutonetSetup(ethers, signer, log),
    };
    log(`  AutonetSetup: ${await s.setups.autonet.getAddress()}`);
    s.repos = {};
    for (const name of MODULES) {
        const repo = await deploy("ModuleRepo", name, signer.address);
        await (await repo.createVersion(1, await s.setups[name].getAddress(),
            dataUri(metadata(name, "build")), dataUri(metadata(name, "release")))).wait();
        await (await s.catalog.register(await repo.getAddress())).wait();
        if (curator !== signer.address) await (await repo.transferOwnership(curator)).wait();
        s.repos[name] = repo;
    }
    if (curator !== signer.address) await (await s.catalog.transferOwnership(curator)).wait();
    return s;
}

async function defaultMinCoolingOff(ethers) {
    const { chainId } = await ethers.provider.getNetwork();
    return chainId === 31337n ? 60 : 86400;
}

module.exports = {
    AUTONET_BLOBS, MODULES, blobInitCode, deployBlob, deployAutonetSetup,
    metadata, dataUri, paramType, encodeInstallData, deployJurisdictionSuite, defaultMinCoolingOff,
};
