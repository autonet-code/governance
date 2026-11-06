const { expect } = require("chai");
const { ethers } = require("hardhat");
const { impersonateAccount, stopImpersonatingAccount } = require("@nomicfoundation/hardhat-network-helpers");

describe("EconomyRepClaim", function () {
    let economy, repToken, claim, testToken, registry, timelock;
    let deployer, author, contractor, user1;
    let mockProjectSigner; // To be used as a valid caller

    const NATIVE_CURRENCY = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    const ARBITRATION_FEE_BPS = 500; // 5%

    // This helper now uses the pre-configured mockProjectSigner
    async function updateEconomyState(updates) {
        for (const update of updates) {
            if (update.type === 'earnings') {
                await economy.connect(mockProjectSigner).updateEarnings(update.user.address, update.amount, update.token);
            } else if (update.type === 'spendings') {
                await economy.connect(mockProjectSigner).updateSpendings(update.user.address, update.amount, update.token);
            }
        }
    }

    beforeEach(async function () {
        [deployer, timelock, author, contractor, user1] = await ethers.getSigners();

        const RegistryFactory = await ethers.getContractFactory("Registry");
        registry = await RegistryFactory.deploy(timelock.address, deployer.address);

        const ERC20ProjectImpl = await ethers.getContractFactory("ERC20Project");
        const erc20ProjectImpl = await ERC20ProjectImpl.deploy();
        const EconomyFactory = await ethers.getContractFactory("Economy");
        economy = await EconomyFactory.deploy(ARBITRATION_FEE_BPS);
        
        await economy.connect(deployer).setImplementations(ethers.ZeroAddress, await erc20ProjectImpl.getAddress());
        
        const RepTokenFactory = await ethers.getContractFactory("RepToken");
        repToken = await RepTokenFactory.deploy("Jurisdiction Token", "JUR", await registry.getAddress(), timelock.address, [], []);
        const TestTokenFactory = await ethers.getContractFactory("TestToken");
        testToken = await TestTokenFactory.deploy();

        await testToken.connect(deployer).transfer(author.address, ethers.parseEther("10000"));
        await testToken.connect(deployer).transfer(contractor.address, ethers.parseEther("10000"));
        
        await repToken.connect(deployer).setAdmin(timelock.address);
        claim = await (await ethers.getContractFactory("EconomyRepClaim")).deploy(
            await economy.getAddress(), await repToken.getAddress(), await registry.getAddress());
        await repToken.connect(timelock).setMinter(await claim.getAddress(), true);
        await economy.connect(deployer).setDaoAddresses(timelock.address, await registry.getAddress(), deployer.address, await repToken.getAddress());
        
        const economyAddr = await economy.getAddress();
        // Create project without arbitration fee parameter (it's now percentage-based)
        const tx = await economy.connect(author).createERC20Project("Mock Project", contractor.address, deployer.address, "t", "r", "d", await testToken.getAddress());
        const receipt = await tx.wait();
        const mockProjectAddress = receipt.logs.find(log => log.eventName === 'NewProject').args.contractAddress;
        
        await impersonateAccount(mockProjectAddress);
        mockProjectSigner = await ethers.getSigner(mockProjectAddress);

        // --- THE FIX: Manually set the balance of the impersonated contract address ---
        // We give it 10 ETH to pay for gas fees in the tests.
        const oneEth = ethers.parseEther("10.0").toString(16); // Hex value of 10 ETH
        await ethers.provider.send("hardhat_setBalance", [
            mockProjectAddress,
            "0x" + oneEth,
        ]);

        const nativeParityKey = `jurisdiction.parity.${NATIVE_CURRENCY.toLowerCase()}`;
        const tokenParityKey = `jurisdiction.parity.${(await testToken.getAddress()).toLowerCase()}`;
        
        // Parity is an 18-decimal fixed-point multiplier (see docs/registry-settings.md):
        // 1e18 == 1:1. testToken is 18-decimals, so 1x and 2x are 1e18 and 2e18.
        await registry.connect(timelock).editRegistry(nativeParityKey, ethers.parseEther("1").toString());
        await registry.connect(timelock).editRegistry(tokenParityKey, ethers.parseEther("2").toString());
    });

    afterEach(async function() {
        if (mockProjectSigner) {
            await stopImpersonatingAccount(mockProjectSigner.address);
        }
    });

    it("should allow a user to claim reputation for the first time", async function () {
        const nativeEarnings = ethers.parseEther("10");
        const tokenEarnings = ethers.parseEther("100");
        
        await updateEconomyState([{ user: contractor, amount: nativeEarnings, token: NATIVE_CURRENCY, type: 'earnings' }, { user: contractor, amount: tokenEarnings, token: await testToken.getAddress(), type: 'earnings' }]);
        
        const expectedReputation = (nativeEarnings * 1n) + (tokenEarnings * 2n);
        
        await expect(claim.connect(contractor).claim())
            .to.emit(claim, "ReputationClaimedFromEconomy")
            .withArgs(contractor.address, expectedReputation);
            
        expect(await repToken.balanceOf(contractor.address)).to.equal(expectedReputation);
    });

    it("should prevent a user from claiming the same earnings twice", async function () {
        const nativeEarnings = ethers.parseEther("5");
        await updateEconomyState([{ user: contractor, amount: nativeEarnings, token: NATIVE_CURRENCY, type: 'earnings' }]);

        await claim.connect(contractor).claim();
        const balanceAfterFirstClaim = await repToken.balanceOf(contractor.address);
        
        await claim.connect(contractor).claim();
        expect(await repToken.balanceOf(contractor.address)).to.equal(balanceAfterFirstClaim);
    });
    
    it("should allow a user to make an incremental claim for new earnings", async function() {
        const initialTokenEarnings = ethers.parseEther("50");
        await updateEconomyState([{ user: contractor, amount: initialTokenEarnings, token: await testToken.getAddress(), type: 'earnings' }]);
        
        await claim.connect(contractor).claim();
        const balanceAfterFirstClaim = await repToken.balanceOf(contractor.address);
        expect(balanceAfterFirstClaim).to.equal(initialTokenEarnings * 2n);

        const newTokenEarnings = ethers.parseEther("30");
        await updateEconomyState([{ user: contractor, amount: newTokenEarnings, token: await testToken.getAddress(), type: 'earnings' }]);

        await claim.connect(contractor).claim();
        const expectedSecondRep = newTokenEarnings * 2n;
        const finalBalance = await repToken.balanceOf(contractor.address);

        expect(finalBalance).to.equal(balanceAfterFirstClaim + expectedSecondRep);
    });

    it("should correctly calculate reputation when both earnings and spendings are present", async function() {
        const nativeEarnings = ethers.parseEther("10");
        const tokenSpendings = ethers.parseEther("200");
        const tokenAddress = await testToken.getAddress();

        await updateEconomyState([
            { user: user1, amount: nativeEarnings, token: NATIVE_CURRENCY, type: 'earnings' },
            { user: user1, amount: tokenSpendings, token: tokenAddress, type: 'spendings' }
        ]);

        const expectedReputation = (nativeEarnings * 1n) + (tokenSpendings * 2n);
        await claim.connect(user1).claim();
        expect(await repToken.balanceOf(user1.address)).to.equal(expectedReputation);
    });
    
    it("should respect changes in parity for new claims", async function() {
        const tokenEarnings = ethers.parseEther("100");
        await updateEconomyState([{ user: contractor, amount: tokenEarnings, token: await testToken.getAddress(), type: 'earnings' }]);

        const tokenParityKey = `jurisdiction.parity.${(await testToken.getAddress()).toLowerCase()}`;
        
        await registry.connect(timelock).editRegistry(tokenParityKey, ethers.parseEther("5").toString());

        const expectedReputation = tokenEarnings * 5n;
        await claim.connect(contractor).claim();
        expect(await repToken.balanceOf(contractor.address)).to.equal(expectedReputation);
    });

    describe("jurisdiction.economy.rep_rate_bps", function () {
        const KEY = "jurisdiction.economy.rep_rate_bps";

        async function earn(amount) {
            await updateEconomyState([{ user: contractor, amount, token: await testToken.getAddress(), type: 'earnings' }]);
        }

        it("absent, mints the full amount", async function () {
            await earn(ethers.parseEther("100"));
            expect(await claim.claimable(contractor.address)).to.equal(ethers.parseEther("200"));
        });

        it("scales the REP of every token, and claimable agrees with claim", async function () {
            await updateEconomyState([
                { user: contractor, amount: ethers.parseEther("100"), token: await testToken.getAddress(), type: 'earnings' },
                { user: contractor, amount: ethers.parseEther("10"), token: NATIVE_CURRENCY, type: 'spendings' },
            ]);
            await registry.connect(timelock).editRegistry(KEY, "2500");
            const expected = ethers.parseEther("210") / 4n;
            expect(await claim.claimable(contractor.address)).to.equal(expected);
            await claim.connect(contractor).claim();
            expect(await repToken.balanceOf(contractor.address)).to.equal(expected);
        });

        it("reaches REP earned but not yet claimed, and leaves what was claimed alone", async function () {
            await earn(ethers.parseEther("100"));
            await claim.connect(contractor).claim();
            await earn(ethers.parseEther("100"));
            await registry.connect(timelock).editRegistry(KEY, "5000");
            await claim.connect(contractor).claim();
            expect(await repToken.balanceOf(contractor.address)).to.equal(ethers.parseEther("300"));
        });

        it("at 0 mints nothing, and removing it restores the full amount", async function () {
            await registry.connect(timelock).editRegistry(KEY, "0");
            await earn(ethers.parseEther("100"));
            expect(await claim.claimable(contractor.address)).to.equal(0);
            await registry.connect(timelock).editRegistry(KEY, "");
            expect(await claim.claimable(contractor.address)).to.equal(ethers.parseEther("200"));
        });
    });
});
// RepToken.test.js