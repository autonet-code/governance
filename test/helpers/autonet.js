// Helpers for tests that run against the real autonet contracts (test/fixtures/autonet).
const { ethers } = require("hardhat");

function autonet(name, signer) {
    const a = require(`../fixtures/autonet/${name}.json`);
    return new ethers.ContractFactory(a.abi, a.bytecode, signer);
}

// Single-leaf merkle tree: the root is the double-hashed (agent, amount) leaf and the proof is empty.
function mintLeaf(agent, amount) {
    const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [agent, amount]));
    return ethers.keccak256(inner);
}

const ANCHOR_TYPES = {
    AnchorApproval: [
        { name: "epochId", type: "string" },
        { name: "epochRoot", type: "bytes32" },
        { name: "prevEpochRoot", type: "bytes32" },
        { name: "prevAnchorHash", type: "bytes32" },
        { name: "agentMintCid", type: "string" },
        { name: "payloadHash", type: "bytes32" },
        { name: "agentMintRoot", type: "bytes32" },
    ],
};

// Submit the next anchor in the chain, signed by `signers` (sorted ascending, as the Substrate requires).
// `from` relays it; the relayer has no authority of its own.
async function submitAnchor(substrate, signers, epochId, agentMintRoot = ethers.ZeroHash, from = undefined) {
    const anchor = {
        epochId,
        epochRoot: ethers.id(`root:${epochId}`),
        prevEpochRoot: await substrate.latestEpochRoot(),
        prevAnchorHash: await substrate.latestAnchorHash(),
        agentMintCid: `cid:${epochId}`,
        payloadHash: ethers.ZeroHash,
        agentMintRoot,
    };
    const domain = {
        name: "AutonetSubstrate", version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await substrate.getAddress(),
    };
    const sorted = [...signers].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
    const signatures = await Promise.all(sorted.map((s) => s.signTypedData(domain, ANCHOR_TYPES, anchor)));
    const c = from ? substrate.connect(from) : substrate;
    return c.submitAnchor(anchor.epochId, anchor.epochRoot, anchor.prevEpochRoot, anchor.prevAnchorHash,
        anchor.agentMintCid, anchor.payloadHash, anchor.agentMintRoot, signatures);
}

module.exports = { autonet, mintLeaf, submitAnchor };
