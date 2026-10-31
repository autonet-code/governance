// Creates DAOs through the JurisdictionFactory the way werule does (see test/helpers/jurisdiction.js):
// `deploy` for a DAO without modules; otherwise deployCore, a prepared installation per module
// (data encoded from the module's build metadata), then finalize. Shared by the local e2e scripts.
const { ethers } = require("hardhat");
const { encodeInstallData } = require("../lib/modules");

const wait = async (txPromise) => (await txPromise).wait();
const SETUP_CONTRACTS = { economy: "EconomySetup", content_court: "ContentCourtSetup", autonet: "AutonetSetup" };

// tokenKind: 0 soulbound, 1 transferable, 2 wrapped (`underlying` ERC20, no initial members)
function coreParams(o = {}) {
    return {
        name: o.name, symbol: o.symbol, description: o.description ?? "",
        tokenKind: o.tokenKind ?? 0, underlying: o.underlying ?? ethers.ZeroAddress,
        initialMembers: o.members ?? [], initialAmounts: o.amounts ?? [],
        votingDelay: o.votingDelay ?? 0, votingPeriod: o.votingPeriod ?? 1,          // minutes
        proposalThreshold: o.proposalThreshold ?? 0, quorumFraction: o.quorumFraction ?? 4,
        executionDelay: o.executionDelay ?? 60,                                       // seconds
        supermajorityBps: o.supermajorityBps ?? 0,                                    // 0: default 6667
    };
}

const coreOf = (c) => ({ registry: c.registry, timelock: c.timelock, token: c.token, governor: c.governor });

/// Prepares an installation of module `name` for `core`. Returns its setup, id, main contract and helpers.
async function prepare(dep, core, name, values) {
    const [signer] = await ethers.getSigners();
    const setup = await ethers.getContractAt(SETUP_CONTRACTS[name], dep[`${name}Setup`]);
    await wait(setup.prepareInstallation(core, encodeInstallData(ethers, name, values)));
    const id = await setup.lastPreparedBy(signer.address);
    const [, p] = await setup.installationOf(id);
    return { setup, id, module: p.module, helpers: [...p.helpers] };
}

/// `o.modules`: { name: installData values }, attached at origination in order.
/// Returns the core addresses, the prepared installations and the receipt that emitted NewDaoCreated.
async function createJurisdiction(dep, o = {}) {
    const f = await ethers.getContractAt("JurisdictionFactory", dep.jurisdictionFactory);
    const p = coreParams(o);
    const keys = o.keys ?? [], values = o.values ?? [];
    const installs = {};
    let receipt;
    if (!o.modules) {
        receipt = await wait(f.deploy(p, keys, values));
    } else {
        const core = coreOf(await f.deployCore.staticCall(p));
        await wait(f.deployCore(p));
        const refs = [];
        for (const [name, v] of Object.entries(o.modules)) {
            installs[name] = await prepare(dep, core, name, v);
            refs.push({ setup: dep[`${name}Setup`], id: installs[name].id });
        }
        receipt = await wait(f.finalize(core, refs, keys, values));
    }
    const created = receipt.logs.map((l) => { try { return f.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "NewDaoCreated").args;
    const governor = await ethers.getContractAt("HomebaseDAO", created.dao);
    const core = { registry: created.registry, timelock: await governor.timelock(), token: created.token, governor: created.dao };
    return { core, installs, receipt, governor };
}

module.exports = { wait, coreParams, prepare, createJurisdiction };
