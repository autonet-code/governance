require("@nomicfoundation/hardhat-toolbox");

const { INFURA_API_KEY, SEPOLIA_PRIVATE_KEY, PRIVATE_KEY } = require("./config");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version:"0.8.26",
    settings: {
      evmVersion: "cancun",
      optimizer: {
        enabled: true,
        runs: 200,
      },
       viaIR: true,
  }
},
  networks: {
    // The indexer e2e harness can run against a second node (E2E_RPC_URL), leaving the usual one alone
    localhost: { url: process.env.E2E_RPC_URL || "http://127.0.0.1:8545" },
    hardhat: {
      mining: {
        auto: true,
        interval: 2000
      },
      // Lets the local UI harness start the chain behind wall-clock time (see scripts/indexer-e2e/ui.sh)
      ...(process.env.HARDHAT_INITIAL_DATE ? { initialDate: process.env.HARDHAT_INITIAL_DATE } : {})
    },
    ganache: {
      url: "http://127.0.0.1:7545",
      chainId: 1337,
      accounts: {
        mnemonic: "fruit insect love learn tower opera divide link intact always garment foam",
      }
    },
    sepolia: {
      url: `https://sepolia.infura.io/v3/${INFURA_API_KEY}`,
      chainId: 11155111,
      accounts: [`0x${SEPOLIA_PRIVATE_KEY}`],
    },
    et: {
      url: `https://node.ghostnet.etherlink.com`,
      chainId: 128123,
      accounts: [`0x${PRIVATE_KEY}`],
      timeout: 180000,
    },
    ets: {
      url: `https://node.shadownet.etherlink.com`,
      chainId: 127823,
      accounts: [`0x${PRIVATE_KEY}`],
      timeout: 180000,
    },
    etm: {
      url: `https://node.mainnet.etherlink.com`,
      chainId: 42793,
      accounts: [`0x${PRIVATE_KEY}`],
    },
    baseSepolia: {
      url: `https://sepolia.base.org`,
      chainId: 84532,
      accounts: [`0x${SEPOLIA_PRIVATE_KEY}`],
    },
  },
  etherscan: {
    apiKey: {
      // Blockscout doesn't require a real API key, just a non-empty string
      et: "blockscout",
      ets: "blockscout",
      etm: "blockscout",
    },
    customChains: [
      {
        network: "et",
        chainId: 128123,
        urls: {
          apiURL: "https://testnet.explorer.etherlink.com/api",
          browserURL: "https://testnet.explorer.etherlink.com",
        },
      },
      {
        network: "ets",
        chainId: 127823,
        urls: {
          apiURL: "https://shadownet.explorer.etherlink.com/api",
          browserURL: "https://shadownet.explorer.etherlink.com",
        },
      },
      {
        network: "etm",
        chainId: 42793,
        urls: {
          apiURL: "https://explorer.etherlink.com/api",
          browserURL: "https://explorer.etherlink.com",
        },
      },
    ],
  },
};
