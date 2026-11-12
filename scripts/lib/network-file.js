// The network file the werule indexer starts from (EightRice/werule-indexer, networks.py):
// deployments/networks/<Name>.json. A deploy that puts factories on a chain merges its addresses into
// the file; the indexer indexes the network from `fromBlock` and publishes the file as the network's
// entry in networks.json, which werule and the Autonet app read. So everything in it is public:
// `rpc` is a public RPC URL (a keyed one belongs in the indexer's RPC_<NAME> environment variable).
//
// Local dev reads the folder directly (NETWORKS_SOURCE=dir:<this repo>/deployments); for a real network
// copy the file into the indexer's private source: python networks.py put deployments/networks/<Name>.json
const fs = require("fs");
const path = require("path");

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

module.exports = { writeNetworkFile, networkFilePath, chainInfo };
