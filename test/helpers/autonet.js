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

// The arguments of the next anchor in the chain
async function anchorArgs(substrate, epochId, agentMintRoot = ethers.ZeroHash) {
    return [epochId, ethers.id(`root:${epochId}`), await substrate.latestEpochRoot(), await substrate.latestAnchorHash(),
        `cid:${epochId}`, ethers.ZeroHash, agentMintRoot];
}

// Anchors the next epoch as `governor`, the only address the Substrate accepts anchors from (the DAO
// timelock in production, so an anchor is a DAO proposal)
async function submitAnchor(substrate, governor, epochId, agentMintRoot = ethers.ZeroHash) {
    return substrate.connect(governor).anchor(...(await anchorArgs(substrate, epochId, agentMintRoot)));
}

// Registers `agent` on the Substrate, self-owned and without a parent: the owner signs the
// EIP-712 OwnerBinding{agent, parent, nonce}
async function registerAgent(substrate, agent, peerId = "0x01") {
    const domain = {
        name: "AutonetSubstrate", version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await substrate.getAddress(),
    };
    const types = { OwnerBinding: [
        { name: "agent", type: "address" }, { name: "parent", type: "address" }, { name: "nonce", type: "uint256" }] };
    const binding = { agent: agent.address, parent: ethers.ZeroAddress, nonce: await substrate.bindingNonce(agent.address) };
    const sig = await agent.signTypedData(domain, types, binding);
    return substrate.connect(agent).registerAgentBound(peerId, agent.address, ethers.ZeroAddress, sig);
}

module.exports = { autonet, mintLeaf, anchorArgs, submitAnchor, registerAgent };
