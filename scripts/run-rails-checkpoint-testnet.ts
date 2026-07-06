// Phase 4.5 — Rails Integration Checkpoint (LIVE testnet confirmation pass).
//
// Runs approve -> registerPermit2Mandate(arm) -> executePermit2Settlement(pull) -> second pull against
// the REAL Permit2 singleton + REAL FDUSD test token, on a real testnet (ETH Sepolia first, BSC Testnet
// too). This is the confirmation pass that closes the residual "MockPermit2 != real singleton" gap; the
// hard cross-component seam proof (.NET calldata/digest vs the real contract) already ran locally in
// tests/rails-integration-checkpoint.test.ts against deterministic addresses.
//
// The permit is signed here with the Permit2 EIP-712 helper (the same domain facts the .NET wallet
// builder uses: name "Permit2", NO version, verifyingContract = the singleton). The point of the live
// run is the on-chain mechanic on the real singleton, not re-proving the .NET encoder (done locally).
//
// Usage (USER runs — needs a funded key + FDUSD test balance; see plan phase-04.5/questions.md):
//   ETH Sepolia:  DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/run-rails-checkpoint-testnet.ts --network eth-sepolia
//   BSC Testnet:  DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/run-rails-checkpoint-testnet.ts --network bsc-testnet
//
// Env:
//   DEPLOYER_PRIVATE_KEY   (required) — funded key; deploys the contract, is admin + facilitator, and by
//                          default is ALSO the subscriber (owner) that signs the permit and holds FDUSD.
//   SUBSCRIBER_PRIVATE_KEY (optional) — separate owner key. If set it must hold FDUSD test tokens AND gas;
//                          otherwise the deployer key plays every role (matches the Phase 1 spike PoC).
//   SETTLEMENT_ADDRESS     (optional) — reuse an already-deployed SpectrumSettlement instead of deploying.
//   FDUSD_ADDRESS          (optional) — override the FDUSD test token (default = the known testnet address).
//   CYCLE_AMOUNT_WEI       (optional) — per-cycle pull amount in wei (default 1e16 = 0.01 FDUSD, cheap).
import { ethers, network } from "hardhat";
import {
  buildSubscriptionPermit,
  signPermitSingle,
} from "../tests/helpers/permit2-eip712-helper";
import { SpectrumSettlement } from "../typechain-types";

// Canonical Permit2 singleton — identical address on ETH + BSC (mainnet and testnet).
const PERMIT2_SINGLETON = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
// FDUSD test token — SAME address on ETH Sepolia AND BSC Testnet (verified Phase 1), 18 decimals, EIP-2612.
const FDUSD_TESTNET_DEFAULT = "0xaB27f55DB008704Ed8098f0dfBCf5e1aA387b9d9";

const SUPPORTED: Record<number, string> = { 11155111: "ETH Sepolia", 97: "BSC Testnet" };

// Minimal ABIs for the pieces we touch outside the typechain SpectrumSettlement.
const PERMIT2_ABI = [
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const label = SUPPORTED[chainId] ?? `chainId ${chainId}`;
  if (!SUPPORTED[chainId]) {
    console.warn(`[warn] ${network.name} (chainId ${chainId}) is not ETH Sepolia / BSC Testnet. Proceeding.`);
  }

  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) throw new Error("No signer — set DEPLOYER_PRIVATE_KEY for this network.");

  // Subscriber = deployer unless a separate key is provided (that key must hold FDUSD + gas).
  const subKey = process.env.SUBSCRIBER_PRIVATE_KEY?.trim();
  const subscriber = subKey ? new ethers.Wallet(subKey, ethers.provider) : deployer;
  const fdusdAddr = process.env.FDUSD_ADDRESS?.trim() || FDUSD_TESTNET_DEFAULT;
  const cycleAmount = BigInt(process.env.CYCLE_AMOUNT_WEI?.trim() || "10000000000000000"); // 0.01 FDUSD

  const bar = "=".repeat(64);
  console.log(bar);
  console.log(`Phase 4.5 Rails Checkpoint (LIVE) — ${label} (${network.name})`);
  console.log(`  Deployer/admin/facilitator: ${deployer.address}`);
  console.log(`  Subscriber (owner):         ${subscriber.address}`);
  console.log(`  Permit2 singleton:          ${PERMIT2_SINGLETON}`);
  console.log(`  FDUSD test token:           ${fdusdAddr}`);
  console.log(`  Cycle amount (wei):         ${cycleAmount}`);
  console.log(bar);

  // 1) Deploy (or reuse) SpectrumSettlement bound to the canonical singleton (address(0) => singleton).
  const SettlementFactory = await ethers.getContractFactory("SpectrumSettlement", deployer);
  let settlement: SpectrumSettlement;
  const reuse = process.env.SETTLEMENT_ADDRESS?.trim();
  if (reuse) {
    settlement = SettlementFactory.attach(reuse) as SpectrumSettlement;
    console.log(`Reusing SpectrumSettlement at ${reuse}`);
  } else {
    const deployed = await SettlementFactory.deploy(deployer.address, ethers.ZeroAddress);
    await deployed.waitForDeployment();
    settlement = deployed;
    const addr = await settlement.getAddress();
    console.log(`Deployed SpectrumSettlement at ${addr}  (tx ${deployed.deploymentTransaction()?.hash})`);
  }
  const settlementAddr = await settlement.getAddress();

  // Guard BOTH paths (deploy and reuse): the contract must be bound to the canonical singleton, else the
  // permit is signed against the wrong domain and every pull would run through the wrong Permit2.
  const bound = await settlement.PERMIT2();
  if (bound.toLowerCase() !== PERMIT2_SINGLETON.toLowerCase()) {
    throw new Error(`Bound Permit2 ${bound} != canonical singleton ${PERMIT2_SINGLETON} — aborting.`);
  }

  // 2) Whitelist the facilitator (deployer) so onlyFacilitator paths run.
  const addFacTx = await settlement.connect(deployer).addFacilitator(deployer.address);
  await addFacTx.wait();
  console.log(`addFacilitator(${deployer.address})  tx ${addFacTx.hash}`);

  const permit2 = new ethers.Contract(PERMIT2_SINGLETON, PERMIT2_ABI, ethers.provider);
  const fdusd = new ethers.Contract(fdusdAddr, ERC20_ABI, ethers.provider);

  // Sanity: CYCLE_AMOUNT_WEI assumes 18-decimal FDUSD; warn loudly on a different-decimals token so a
  // 6-decimal override doesn't silently pull a huge amount.
  const decimals = Number(await fdusd.decimals());
  if (decimals !== 18) {
    console.warn(`[warn] FDUSD token has ${decimals} decimals (expected 18) — verify CYCLE_AMOUNT_WEI scaling.`);
  }

  const subBal = (await fdusd.balanceOf(subscriber.address)) as bigint;
  console.log(`Subscriber FDUSD balance: ${subBal} (need >= ${cycleAmount * 2n} for two pulls)`);
  if (subBal < cycleAmount * 2n) {
    throw new Error(
      `Subscriber ${subscriber.address} holds ${subBal} FDUSD < 2 cycles. Fund it first ` +
        `(FDUSD test token mint is onlyOwner — transfer from a wallet that holds it; no public faucet).`
    );
  }

  // 3) approve(Permit2 singleton, max) — the singleton is msg.sender of token.transferFrom on each pull.
  const approveTx = await (fdusd.connect(subscriber) as any).approve(PERMIT2_SINGLETON, ethers.MaxUint256);
  await approveTx.wait();
  console.log(`approve(Permit2, max)  tx ${approveTx.hash}`);

  // 4) Build + EOA-sign the PermitSingle (cap = cycleAmount * 12) against the singleton's domain.
  const [, , nonce0] = await permit2.allowance(subscriber.address, fdusdAddr, settlementAddr);
  const permitSingle = buildSubscriptionPermit({
    token: fdusdAddr,
    spender: settlementAddr,
    cycleAmount,
    cycles: 12,
    currentNonce: nonce0,
  });
  const sig = await signPermitSingle(subscriber, chainId, permitSingle, PERMIT2_SINGLETON);

  // 5) ARM — registerPermit2Mandate forwards the permit to PERMIT2.permit() (verifies sig, bumps nonce).
  const armTx = await settlement.connect(deployer).registerPermit2Mandate(subscriber.address, permitSingle, sig);
  await armTx.wait();
  const [armAmount, , nonceAfterArm] = await permit2.allowance(subscriber.address, fdusdAddr, settlementAddr);
  console.log(`ARM  tx ${armTx.hash}  | allowance=${armAmount} nonce ${nonce0}->${nonceAfterArm}`);

  // 6) A settlement instruction: residual to the subscriber (self), one 10% fee recipient (deployer).
  const instruction = {
    clientWalletAddress: subscriber.address,
    clientId: "rails-45-live",
    packageTier: 5,
    attestationHash: "rails-45-live-consent",
    recipients: [{ recipient: deployer.address, basisPoints: 1000, flatAmount: 0 }],
  };

  // 7) PULL #1
  const pull1 = await settlement
    .connect(deployer)
    .executePermit2Settlement(fdusdAddr, subscriber.address, cycleAmount, cycleAmount, instruction);
  await pull1.wait();
  const [amtAfter1, , nonceAfter1] = await permit2.allowance(subscriber.address, fdusdAddr, settlementAddr);
  console.log(`PULL #1  tx ${pull1.hash}  | allowance=${amtAfter1} nonce=${nonceAfter1}`);

  // 8) PULL #2 — NO new signature. The F1 on-chain fact: nonce unchanged, allowance decremented again.
  const pull2 = await settlement
    .connect(deployer)
    .executePermit2Settlement(fdusdAddr, subscriber.address, cycleAmount, cycleAmount, instruction);
  await pull2.wait();
  const [amtAfter2, , nonceAfter2] = await permit2.allowance(subscriber.address, fdusdAddr, settlementAddr);
  console.log(`PULL #2  tx ${pull2.hash}  | allowance=${amtAfter2} nonce=${nonceAfter2}`);

  console.log(bar);
  console.log("RESULT");
  console.log(`  nonce after arm:            ${nonceAfterArm}`);
  console.log(`  nonce after pull #1 / #2:   ${nonceAfter1} / ${nonceAfter2}  (must be equal — F1 fact)`);
  console.log(`  allowance armed -> p1 -> p2: ${armAmount} -> ${amtAfter1} -> ${amtAfter2}`);
  // F1 invariant: NEITHER pull touches the packed nonce (arm == p1 == p2), and each pull decrements the
  // allowance by one cycle. Including nonceAfterArm closes the pathological "pull#1 bumps, pull#2 doesn't".
  const secondPullNoSig =
    nonceAfterArm === nonceAfter1 &&
    nonceAfter1 === nonceAfter2 &&
    amtAfter1 === armAmount - cycleAmount &&
    amtAfter2 === amtAfter1 - cycleAmount;
  console.log(`  second pull needed NO new signature: ${secondPullNoSig ? "YES ✔" : "NO ✗"}`);
  console.log(bar);
  console.log("Record these tx hashes in plan phase-04.5 report (per-chain table).");
  if (!secondPullNoSig) {
    throw new Error("Second-pull invariant (F1) did not hold — investigate before recording success.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
