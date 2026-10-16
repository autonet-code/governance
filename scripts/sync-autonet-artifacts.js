// Copies the compiled autonet core contracts (ABI + bytecode) into test/fixtures/autonet so the
// jurisdiction tests run against the real Substrate, ServiceMarket and VentureVault
// instead of local mocks. Compile the autonet repo first (npx hardhat compile there).
//
// Usage: node scripts/sync-autonet-artifacts.js [path to autonet repo, default ../../autonet]
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const autonet = path.resolve(process.argv[2] || path.join(__dirname, "..", "..", "..", "autonet"));
const out = path.join(__dirname, "..", "test", "fixtures", "autonet");
const contracts = [
  ["Substrate.sol", "Substrate"],
  ["ServiceMarket.sol", "ServiceRegistry"],
  ["ServiceMarket.sol", "PaymentChannel"],
  ["VentureVault.sol", "VentureVault"],
  ["VentureVault.sol", "VentureVaultFactory"],
];

fs.mkdirSync(out, { recursive: true });
for (const [file, name] of contracts) {
  const a = JSON.parse(fs.readFileSync(path.join(autonet, "artifacts", "contracts", "core", file, `${name}.json`), "utf8"));
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ contractName: name, abi: a.abi, bytecode: a.bytecode }));
  console.log(`  ${name}`);
}
const commit = execSync("git rev-parse HEAD", { cwd: autonet }).toString().trim();
const dirty = execSync("git status --porcelain contracts", { cwd: autonet }).toString().trim() !== "";
fs.writeFileSync(path.join(out, "SOURCE.json"), JSON.stringify({ repo: "autonet-code/node", commit, contractsDirty: dirty, syncedAt: new Date().toISOString() }, null, 2) + "\n");
console.log(`Synced from ${autonet} @ ${commit}${dirty ? " (uncommitted contract changes)" : ""}`);
