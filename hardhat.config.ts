import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import * as dotenv from "dotenv";
import "hardhat-contract-sizer";
import "hardhat-gas-reporter";
import { HardhatUserConfig } from "hardhat/config";
import "solidity-coverage";

dotenv.config();

/**
 * Standard Hardhat deterministic accounts for local development
 * These are well-known test private keys from Hardhat's default configuration.
 * NEVER use these accounts on mainnet or with real funds.
 */
const LOCAL_ACCOUNTS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];

/**
 * Get accounts for network configuration
 */
function getNetworkAccounts(networkName: string): string[] {
  switch (networkName) {
    case "hardhat":
    case "localhost":
      return LOCAL_ACCOUNTS;
      
    case "testnet":
      if (process.env.DEPLOYER_PRIVATE_KEY) {
        return [process.env.DEPLOYER_PRIVATE_KEY];
      }
      return [];
      
    case "production":
      if (process.env.DEPLOYER_PRIVATE_KEY) {
        return [process.env.DEPLOYER_PRIVATE_KEY];
      }
      return [];
      
    default:
      return [];
  }
}

/**
 * Get RPC URL with fallbacks
 */
function getRpcUrl(network: string, fallback: string): string {
  const envKey = `${network.toUpperCase().replace("-", "_")}_RPC_URL`;
  return process.env[envKey] || fallback;
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      gas: 12000000,
      blockGasLimit: 12000000,
      allowUnlimitedContractSize: true,
      accounts: {
        count: 20,
        accountsBalance: "10000000000000000000000",
        mnemonic: "test test test test test test test test test test test junk",
      },
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      accounts: getNetworkAccounts("localhost"),
    },
    "base-sepolia": {
      url: getRpcUrl("base-sepolia", "https://sepolia.base.org"),
      accounts: getNetworkAccounts("testnet"),
      chainId: 84532,
      gasPrice: "auto",
      timeout: 120000,
    },
    "bsc-testnet": {
      url: getRpcUrl("bsc-testnet", "https://data-seed-prebsc-1-s1.bnbchain.org:8545"),
      accounts: getNetworkAccounts("testnet"),
      chainId: 97,
      gasPrice: 10000000000,
      gas: 6000000,
    },
    "arbitrum-sepolia": {
      url: getRpcUrl("arbitrum-sepolia", "https://sepolia-rollup.arbitrum.io/rpc"),
      accounts: getNetworkAccounts("testnet"),
      chainId: 421614,
      gasPrice: "auto",
    },
    mainnet: {
      url: getRpcUrl("mainnet", "https://eth-mainnet.alchemyapi.io/v2/demo"),
      accounts: getNetworkAccounts("production"),
      chainId: 1,
      gasPrice: "auto",
    },
    polygon: {
      url: getRpcUrl("polygon", "https://polygon-rpc.com"),
      accounts: getNetworkAccounts("production"),
      chainId: 137,
      gasPrice: "auto",
    },
    arbitrum: {
      url: getRpcUrl("arbitrum", "https://arb1.arbitrum.io/rpc"),
      accounts: getNetworkAccounts("production"),
      chainId: 42161,
      gasPrice: "auto",
    },
    base: {
      url: getRpcUrl("base", "https://mainnet.base.org"),
      accounts: getNetworkAccounts("production"),
      chainId: 8453,
      gasPrice: "auto",
    },
    bsc: {
      url: getRpcUrl("bsc", "https://bsc-dataseed1.binance.org"),
      accounts: getNetworkAccounts("production"),
      chainId: 56,
      gasPrice: 3000000000,
    },
  },
  etherscan: {
    apiKey: process.env.BASESCAN_API_KEY || process.env.BSCSCAN_API_KEY || process.env.ARBISCAN_API_KEY || "",
    customChains: [
      {
        network: "base-sepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
      {
        network: "bsc-testnet",
        chainId: 97,
        urls: {
          apiURL: "https://api-testnet.bscscan.com/api",
          browserURL: "https://testnet.bscscan.com",
        },
      },
      {
        network: "bsc",
        chainId: 56,
        urls: {
          apiURL: "https://api.bscscan.com/api",
          browserURL: "https://bscscan.com",
        },
      },
      {
        network: "arbitrum-sepolia",
        chainId: 421614,
        urls: {
          apiURL: "https://api-sepolia.arbiscan.io/api",
          browserURL: "https://sepolia.arbiscan.io",
        },
      },
    ],
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    gasPrice: 10, // 10 gwei for BSC
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    token: "BNB", // Use BNB for BSC network
  },
  contractSizer: {
    alphaSort: true,
    disambiguatePaths: false,
    runOnCompile: true,
    strict: true,
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  paths: {
    sources: "./contracts",
    tests: "./tests",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 300000, // 5 minutes for testnet tests
    reporter: "spec",
    bail: false, // Continue running tests even if some fail
    retries: 1, // Retry failed tests once (for flaky testnet issues)
    grep: "^(?!.*archive).*$", // Exclude archived tests
  },
};

export default config;
