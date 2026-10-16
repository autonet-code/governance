const { expect } = require("chai");
const { ethers } = require("hardhat");

const { autonet } = require("./helpers/autonet");
const { createJurisdiction, suite, REP } = require("./helpers/jurisdiction");

// The autonet module, attached at origination the way the werule wizard does it: the core, then
// autonet, with no Economy needed. Everything is live at genesis.
describe("AutonetSetup", function () {
    let deployer, launcher, member, buyer;
    let s;
    const ATN = (n) => ethers.parseUnits(String(n), 6);
    const CHARTER = ethers.id("charter v1");

    before(async function () {
        [deployer, launcher, member, buyer] = await ethers.getSigners();
        s = await suite();
    });

    async function launch(from, usdc) {
        const parityKey = `jurisdiction.parity.${(await usdc.getAddress()).toLowerCase()}`;
        const j = await createJurisdiction(from, {
            members: [member.address], amounts: [REP(1000)],
            modules: [["autonet", { substrate: { challengeWindow: 3600, charterHash: CHARTER, charterUri: "ipfs://charter" } }]],
            keys: [parityKey], values: [(10n ** 30n).toString()],
        });
        return { j, d: await s.setups.autonet.deploymentOf(j.installs.autonet.id) };
    }

    it("launches a jurisdiction's whole Autonet layer, wired and live at genesis", async function () {
        const usdc = await (await ethers.getContractFactory("TestERC20")).deploy("USD Coin", "USDC", 6, 0);
        const { j, d } = await launch(launcher, usdc);

        const substrate = autonet("Substrate", deployer).attach(d.substrate);
        expect(await substrate.vaultMinter()).to.equal(d.vault);
        expect(await substrate.treasury()).to.equal(j.core.registry);
        expect(await substrate.governor()).to.equal(j.core.timelock);

        expect(await j.rep.minters(d.repClaim)).to.equal(true);
        expect(await j.rep.slashers(d.toolBond)).to.equal(true);
        expect(await j.rep.admin()).to.equal(j.core.timelock);

        // The charter is a registry entry the DAO changes by proposal
        expect(await j.registry.getRegistryValue("jurisdiction.autonet.charter")).to.equal(CHARTER);
        expect(await j.registry.getRegistryValue("jurisdiction.autonet.charter_uri")).to.equal("ipfs://charter");

        const bond = await ethers.getContractAt("ToolBond", d.toolBond);
        expect(await bond.auditorShareBps()).to.equal(4000n);
        expect(await bond.timelock()).to.equal(j.core.timelock);
        expect(await bond.governor()).to.equal(j.core.governor);
        // Never shorter than one proposal lifecycle plus two days
        const lifecycle = (await j.dao.votingDelay()) + (await j.dao.votingPeriod()) + (await j.timelock.getMinDelay());
        expect(await bond.appealWindow()).to.equal(lifecycle + 2n * 86400n);

        expect(await j.registry.getRegistryValue("jurisdiction.autonet.substrate")).to.equal(d.substrate.toLowerCase());
        expect(await j.registry.getRegistryValue("jurisdiction.autonet.economy")).to.equal("");
        expect(await j.registry.getRegistryValue("modules.autonet"))
            .to.equal(`${(await s.setups.autonet.getAddress()).toLowerCase()}:${j.installs.autonet.id}`);

        // The vault sells ATN at parity straight away
        await usdc.mint(buyer.address, 1_000_000);
        await usdc.connect(buyer).approve(d.vault, 1_000_000);
        await (await ethers.getContractAt("AutonetVault", d.vault)).connect(buyer).buy(await usdc.getAddress(), 1_000_000);
        expect(await substrate.balanceOf(buyer.address)).to.equal(ATN(1));
    });

    it("a second launch from the same setup still wires its own vault", async function () {
        const usdc = await (await ethers.getContractFactory("TestERC20")).deploy("USD Coin", "USDC", 6, 0);
        const { d } = await launch(deployer, usdc);
        expect(await autonet("Substrate", deployer).attach(d.substrate).vaultMinter()).to.equal(d.vault);
        expect(await s.setups.autonet.installations()).to.be.greaterThan(1n);
    });

    it("records no charter when none is given, and rejects unknown installations", async function () {
        const j = await createJurisdiction(launcher, { members: [member.address], amounts: [REP(1000)], modules: ["autonet"] });
        expect(await j.registry.getRegistryValue("jurisdiction.autonet.charter")).to.equal("");
        expect(await j.registry.getRegistryValue("jurisdiction.autonet.substrate")).to.not.equal("");
        await expect(s.setups.autonet.installationOf(999)).to.be.revertedWithCustomError(s.setups.autonet, "UnknownInstallation");
    });
});
