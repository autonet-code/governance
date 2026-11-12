// The network file the werule indexer starts from (EightRice/werule-indexer, networks.py):
// deployments/networks/<Name>.json. A deploy that puts factories on a chain merges its addresses into
// the file; the indexer indexes the network from `fromBlock` and publishes the file as the network's
// entry in networks.json, which werule and the Autonet app read. So everything in it is public:
// `rpc` is a public RPC URL (a keyed one belongs in the indexer's RPC_<NAME> environment variable).
//
// Local dev reads the folder directly (NETWORKS_SOURCE=dir:<this repo>/deployments). A real network's
// file is also published to the R2 data bucket (networks/<Name>.json), where the indexer picks it up,
// through the indexer's own uploader (python networks.py put), when R2 keys are available: the R2_*
// environment variables, else ~/.edge/r2.env (R2_ACCESS_KEY_ID=..., R2_SECRET_ACCESS_KEY=...).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const R2_ACCOUNT_ID = "774864e190e45a3f8c637282fb83eed5";

const CHAINS = {
    31337: { name: "Localhost", nativeCurrency: "ETH", symbol: "ETH", blockExplorer: "" },
    127823: { name: "Etherlink-Shadownet", rpc: "https://node.shadownet.etherlink.com",
              nativeCurrency: "XTZ", symbol: "XTZ", blockExplorer: "https://shadownet.explorer.etherlink.com" },
    11155111: { name: "Sepolia", rpc: "https://ethereum-sepolia-rpc.publicnode.com",
                nativeCurrency: "ETH", symbol: "ETH", blockExplorer: "https://sepolia.etherscan.io" },
    1: { name: "Ethereum", rpc: "https://ethereum-rpc.publicnode.com",
         nativeCurrency: "ETH", symbol: "ETH", blockExplorer: "https://etherscan.io" },
};

function chainInfo(chainId) {
    const c = CHAINS[Number(chainId)];
    if (!c) throw new Error(`No network name for chain ${chainId}: add it to scripts/lib/network-file.js`);
    return c;
}

// NETWORK_FILES_DIR moves the folder (tests)
function networkFilePath(name) {
    const dir = process.env.NETWORK_FILES_DIR || path.join(__dirname, "..", "..", "deployments", "networks");
    return path.join(dir, `${name}.json`);
}

// The public RPC for the file: PUBLIC_RPC, else the chain's known public one, else (local chains only)
// the URL hardhat used
function publicRpc(chainId, hardhatUrl) {
    if (process.env.PUBLIC_RPC) return process.env.PUBLIC_RPC;
    const c = chainInfo(chainId);
    if (c.rpc) return c.rpc;
    if (Number(chainId) === 31337) return hardhatUrl || "http://127.0.0.1:8545";
    throw new Error(`No public RPC known for chain ${chainId}; set PUBLIC_RPC`);
}

// Merge `fields` into the chain's network file. `fromBlock` is the block this deploy started at: the
// network's factories are this deploy's, so the indexer has nothing to read before it.
function writeNetworkFile({ chainId, hardhatUrl, fromBlock, fields }) {
    const c = chainInfo(chainId);
    const file = networkFilePath(c.name);
    const cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const out = {
        ...cur,
        name: c.name,
        chainId: Number(chainId),
        rpc: publicRpc(chainId, hardhatUrl),
        nativeCurrency: cur.nativeCurrency || c.nativeCurrency,
        symbol: cur.symbol || c.symbol,
        blockExplorer: cur.blockExplorer || c.blockExplorer,
        ...fields,
    };
    if (fromBlock !== undefined) out.fromBlock = Number(fromBlock);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
    return file;
}

function r2Env() {
    const env = { R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID || R2_ACCOUNT_ID,
                  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY };
    const file = process.env.R2_ENV_FILE || path.join(os.homedir(), ".edge", "r2.env");
    if ((!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) && fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
            const m = line.match(/^\s*(R2_[A-Z_]+)\s*=\s*(.+?)\s*$/);
            if (m && !env[m[1]]) env[m[1]] = m[2];
        }
    }
    return env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY ? env : null;
}

// Publish a network file to the R2 data bucket (NETWORKS_BUCKET, default autonet-data) for the indexer.
// Never a local chain's. Without R2 keys the file stays local, and the deploy says so.
function publishNetworkFile(file) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Number(data.chainId) === 31337) return false;
    const env = r2Env();
    if (!env) {
        console.log(`No R2 keys (R2_* or ~/.edge/r2.env): ${path.basename(file)} kept local; publish it later with`);
        console.log(`  python networks.py put ${file}   (in werule-indexer, NETWORKS_SOURCE=r2:autonet-data)`);
        return false;
    }
    const indexer = process.env.WERULE_INDEXER_DIR || path.join(__dirname, "..", "..", "..", "werule-indexer");
    const bucket = process.env.NETWORKS_BUCKET || "autonet-data";
    const r = spawnSync(process.env.PYTHON || "python", ["networks.py", "put", path.resolve(file)], {
        cwd: indexer, stdio: "inherit", env: { ...process.env, ...env, NETWORKS_SOURCE: `r2:${bucket}` },
    });
    if (r.status !== 0) throw new Error(`publishing ${file} to r2:${bucket} failed (exit ${r.status})`);
    return true;
}

module.exports = { writeNetworkFile, publishNetworkFile, networkFilePath, chainInfo };
