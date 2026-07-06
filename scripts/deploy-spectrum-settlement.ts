// Deploy SpectrumSettlement, parameterized per chain (ETH Sepolia + BSC Testnet in scope).
//
// The Permit2 singleton has the SAME address on every supported chain
// (0x000000000022D473030F116dDEE9F6B43aC78BA3), so production/testnet deploys pass address(0)
// to bind the canonical singleton — no per-chain Permit2 address needed. A mock is only injected
// in unit tests, never here.
//
// Usage:
//   ETH Sepolia:  npx hardhat run scripts/deploy-spectrum-settlement.ts --network eth-sepolia
//   BSC Testnet:  npx hardhat run scripts/deploy-spectrum-settlement.ts --network bsc-testnet
//
// Env:
//   DEPLOYER_PRIVATE_KEY  (required) — funded deployer, becomes default admin if INITIAL_ADMIN unset
//   INITIAL_ADMIN         (optional) — address to receive DEFAULT_ADMIN_ROLE + FACILITATOR_MANAGER_ROLE.
//                                      For mainnet this MUST be a multisig/timelock (see plan todo.md);
//                                      testnet may use the deployer EOA.
import { ethers, network } from "hardhat";

// Canonical Permit2 singleton — identical address+bytecode on ETH + BSC (mainnet and testnet).
const PERMIT2_SINGLETON = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// Chains this deploy path supports (matches the plan's testnet scope).
const SUPPORTED = new Map<number, string>([
  [11155111, "ETH Sepolia"],
  [97, "BSC Testnet"],
]);

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer signer — set DEPLOYER_PRIVATE_KEY for this network.");
  }

  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const chainLabel = SUPPORTED.get(chainId) ?? `chainId ${chainId}`;
  if (!SUPPORTED.has(chainId)) {
    console.warn(
      `[warn] ${network.name} (chainId ${chainId}) is not in the in-scope testnet set ` +
        `(ETH Sepolia / BSC Testnet). Proceeding, but verify this is intended.`
    );
  }

  // address(0) => contract binds the canonical Permit2 singleton internally.
  const permit2Arg = ethers.ZeroAddress;
  // Default admin to the deployer when INITIAL_ADMIN is not provided.
  const initialAdmin = process.env.INITIAL_ADMIN && process.env.INITIAL_ADMIN.trim() !== ""
    ? ethers.getAddress(process.env.INITIAL_ADMIN.trim())
    : deployer.address;

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("=".repeat(60));
  console.log(`Deploying SpectrumSettlement to ${chainLabel} (${network.name})`);
  console.log(`  Deployer:      ${deployer.address}`);
  console.log(`  Balance:       ${ethers.formatEther(balance)} (native)`);
  console.log(`  Initial admin: ${initialAdmin}`);
  console.log(`  Permit2:       ${PERMIT2_SINGLETON} (bound via address(0))`);
  console.log("=".repeat(60));

  const Factory = await ethers.getContractFactory("SpectrumSettlement");
  const settlement = await Factory.deploy(initialAdmin, permit2Arg);
  await settlement.waitForDeployment();
  const address = await settlement.getAddress();

  // Sanity: confirm the deployed contract actually bound the canonical singleton.
  const boundPermit2 = await settlement.PERMIT2();
  console.log(`\nSpectrumSettlement deployed at: ${address}`);
  console.log(`  PERMIT2 bound:  ${boundPermit2}`);
  if (boundPermit2.toLowerCase() !== PERMIT2_SINGLETON.toLowerCase()) {
    throw new Error(`Bound Permit2 ${boundPermit2} != canonical singleton — aborting.`);
  }

  console.log("\nNext steps:");
  console.log(`  1. Record this address in the plan (per-chain deploy table).`);
  console.log(`  2. addFacilitator(<facilitator key>)  — Phase 3.`);
  console.log(
    `  3. Verify:  npx hardhat verify --network ${network.name} ${address} ${initialAdmin} ${permit2Arg}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
