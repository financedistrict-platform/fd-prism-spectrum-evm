// Phase 4.5 — Rails Integration Checkpoint (local proof).
//
// Drives approve -> permit(arm) -> executePermit2Settlement(pull) -> second pull through the REAL
// deployed SpectrumSettlement, feeding it the REAL .NET-produced calldata + digest golden vectors
// (emitted by the facilitator Permit2SettlerEncoder and the wallet RecurringMandateDigestBuilder). No
// Prism. Proves three cross-component seams the per-phase unit tests never exercised against a live
// contract:
//
//   Seam 1 (encoder <-> ABI):  the .NET executePermit2Settlement calldata executes on the real contract.
//   Seam 2 (digest  <-> permit): the .NET-built digest, EOA-signed, verifies under PERMIT2.permit() (no revert).
//   Seam 3 (second pull / F1): a second in-cap pull succeeds and the packed nonce is unchanged.
//
// The golden vectors pin DETERMINISTIC hardhat addresses (deploy order MockPermit2 -> SpectrumSettlement
// -> MockFDUSD from account[0]); this test asserts each deployed address equals the pinned constant, so a
// nonce/order drift fails loudly rather than silently producing a wrong-domain digest.
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { MockERC20, MockPermit2, SpectrumSettlement } from "../typechain-types";

const VECTOR_DIR = path.join(__dirname, "golden-vectors");

interface WalletDigestVector {
  chainId: number;
  permit2Address: string;
  settlementAddress: string;
  fdusdAddress: string;
  cycleAmount: string;
  cap: string;
  permitSingle: {
    details: { token: string; amount: string; expiration: string; nonce: string };
    spender: string;
    sigDeadline: string;
  };
  domainSeparator: string;
  digest: string;
}

interface FacilitatorCalldataVector {
  addresses: {
    permit2: string;
    settlement: string;
    fdusd: string;
    subscriber: string;
    clientWallet: string;
    feeRecipient: string;
  };
  cycleAmount: string;
  cap: string;
  value: string;
  registerPermit2Mandate: { calldata: string };
  executePermit2Settlement: { calldata: string };
}

function loadVector<T>(file: string): T {
  const p = path.join(VECTOR_DIR, file);
  if (!fs.existsSync(p)) {
    throw new Error(
      `Golden vector ${file} not found at ${p}. Emit it first:\n` +
        `  (wallet)      GOLDEN_VECTOR_OUT=${VECTOR_DIR} dotnet test <wallet UnitTests> --filter Category=GoldenVector\n` +
        `  (facilitator) GOLDEN_VECTOR_OUT=${VECTOR_DIR} dotnet test <facilitator IntegrationTests> --filter Category=GoldenVector`
    );
  }
  return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
}

// Well-known hardhat account[3] private key — the subscriber. Used to EOA-sign the RAW .NET digest
// (Permit2 recovers ECDSA over exactly that 32-byte digest). Asserted against the runtime signer address
// so a hardhat config change that reorders accounts fails loudly.
const SUBSCRIBER_PRIVATE_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";

describe("Phase 4.5 — Rails Integration Checkpoint (real contract + real .NET vectors)", function () {
  let wallet: WalletDigestVector;
  let facil: FacilitatorCalldataVector;

  before(function () {
    wallet = loadVector<WalletDigestVector>("rails-checkpoint-wallet-digest.json");
    facil = loadVector<FacilitatorCalldataVector>("rails-checkpoint-facilitator-calldata.json");
  });

  // loadFixture snapshots after the first run and reverts to it for every test — so the deploy nonces
  // (and therefore the deterministic contract addresses the golden vectors were built against) are
  // identical in every test, not drifting as blocks accumulate.
  async function deployFixture() {
    const signers = await ethers.getSigners();
    const deployer = signers[0]; // account[0] — pins deterministic deploy addresses
    const facilitator = signers[2];
    const subscriber = signers[3];

    // Deploy in the pinned order so on-chain addresses match the golden vectors.
    const MockPermit2Factory = await ethers.getContractFactory("MockPermit2", deployer);
    const permit2 = await MockPermit2Factory.deploy();
    await permit2.waitForDeployment();

    const SettlementFactory = await ethers.getContractFactory("SpectrumSettlement", deployer);
    const settlement = await SettlementFactory.deploy(deployer.address, await permit2.getAddress());
    await settlement.waitForDeployment();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20", deployer);
    const fdusd = await MockERC20Factory.deploy("First Digital USD", "FDUSD", 18);
    await fdusd.waitForDeployment();

    await settlement.connect(deployer).addFacilitator(facilitator.address);
    // Fund the subscriber generously (cap = 120 FDUSD; give 1000).
    await fdusd.mint(subscriber.address, ethers.parseEther("1000"));

    return { permit2, settlement, fdusd, facilitator, subscriber };
  }

  // Sign the RAW .NET digest with the subscriber EOA and build the PermitSingle tuple from the vector.
  function buildArmInputs(subscriberAddr: string) {
    const rawSigner = new ethers.Wallet(SUBSCRIBER_PRIVATE_KEY);
    expect(rawSigner.address).to.equal(subscriberAddr); // guards the hardcoded key vs the runtime signer
    const sig = rawSigner.signingKey.sign(wallet.digest).serialized;
    const permitSingle = {
      details: {
        token: wallet.permitSingle.details.token,
        amount: BigInt(wallet.permitSingle.details.amount),
        expiration: BigInt(wallet.permitSingle.details.expiration),
        nonce: BigInt(wallet.permitSingle.details.nonce),
      },
      spender: wallet.permitSingle.spender,
      sigDeadline: BigInt(wallet.permitSingle.sigDeadline),
    };
    return { sig, permitSingle };
  }

  it("deploys to the deterministic addresses the golden vectors were built against", async function () {
    const { permit2, settlement, fdusd, facilitator, subscriber } = await loadFixture(deployFixture);
    // If any of these fail, the .NET vectors were built for different addresses => wrong domain/calldata.
    expect(await permit2.getAddress()).to.equal(wallet.permit2Address);
    expect(await settlement.getAddress()).to.equal(wallet.settlementAddress);
    expect(await fdusd.getAddress()).to.equal(wallet.fdusdAddress);
    expect(subscriber.address).to.equal(facil.addresses.subscriber);
    expect(facilitator.address).to.not.equal(subscriber.address);
    const net = await ethers.provider.getNetwork();
    expect(Number(net.chainId)).to.equal(wallet.chainId);
  });

  it("Seam 0: the contract's on-chain domain separator matches the .NET-computed one", async function () {
    const { permit2 } = await loadFixture(deployFixture);
    // The wallet builder hashed against this exact domain separator; if the contract's differs, the digest
    // would be wrong and permit() (Seam 2) would revert. Assert equality directly for a precise failure.
    const onChain = await permit2.DOMAIN_SEPARATOR();
    expect(onChain.toLowerCase()).to.equal(wallet.domainSeparator.toLowerCase());
  });

  // Splice the runtime 65-byte signature into the .NET registerPermit2Mandate calldata, replacing the
  // emitter's placeholder. This lets us EXECUTE the real facilitator-encoded register bytes (not just
  // decode them): the ARM signature is dynamic (built from the wallet digest at runtime), so the emitter
  // ships a placeholder and the harness injects the real one here. The signature is the trailing dynamic
  // `bytes` member; its 65-byte length is fixed, so only the 65 signature bytes change — the ABI head,
  // the PermitSingle tuple, and the length word are the untouched .NET encoding.
  function spliceRegisterSignature(registerCalldata: string, realSig: string): string {
    const body = registerCalldata.slice(2); // strip 0x, keeps the 4-byte (8-hex) selector
    const realSigHex = realSig.slice(2);
    expect(realSigHex.length).to.equal(130); // 65 bytes
    // PermitSingle is a fully-STATIC tuple, so it is encoded inline (not via an offset). Head layout after
    // the 8-hex selector, one 64-hex word each: owner, token, amount, expiration, nonce, spender,
    // sigDeadline, offset_sig = 8 words. Then word 8 = signature length, word 9 = signature data.
    const SEL = 8;
    const lenWordStart = SEL + 8 * 64; // 520
    const sigDataStart = SEL + 9 * 64; // 584
    // Sanity: the emitter's placeholder length word must say 0x41 (65) right before the sig data.
    const lenWord = body.slice(lenWordStart, sigDataStart);
    expect(BigInt("0x" + lenWord)).to.equal(65n);
    const before = body.slice(0, sigDataStart);
    const after = body.slice(sigDataStart + 130); // trailing right-padding of the placeholder word
    return "0x" + before + realSigHex + after;
  }

  it("Seam 2: the .NET wallet digest verifies under the real PERMIT2.permit() (arm does not revert)", async function () {
    const { permit2, settlement, fdusd, facilitator, subscriber } = await loadFixture(deployFixture);
    const { sig } = buildArmInputs(subscriber.address);

    // approve(Permit2, max) then ARM by EXECUTING the real .NET register calldata (signature spliced in).
    await fdusd.connect(subscriber).approve(await permit2.getAddress(), ethers.MaxUint256);
    const registerData = spliceRegisterSignature(facil.registerPermit2Mandate.calldata, sig);
    await expect(
      facilitator.sendTransaction({ to: await settlement.getAddress(), data: registerData })
    ).to.not.be.reverted;

    // The armed allowance is exactly the .NET cap, and the packed nonce bumped 0 -> 1.
    const [amount, , nonce] = await permit2.allowance(
      subscriber.address,
      wallet.fdusdAddress,
      wallet.settlementAddress
    );
    expect(amount).to.equal(BigInt(wallet.cap));
    expect(nonce).to.equal(1n);
  });

  it("Seam 1 + Seam 3: the .NET executePermit2Settlement calldata pulls twice; nonce unchanged (F1)", async function () {
    const { permit2, settlement, fdusd, facilitator, subscriber } = await loadFixture(deployFixture);
    // Cross-check the two independently-emitted vectors agree on the economics before asserting on them:
    // the pull value MUST equal one wallet cycle, else the allowance/balance math below silently masks a
    // drift between the two hand-maintained emitters.
    expect(BigInt(facil.value)).to.equal(BigInt(wallet.cycleAmount));
    expect(BigInt(facil.cap)).to.equal(BigInt(wallet.cap));

    // Arm first by EXECUTING the real .NET register calldata (signature spliced), same as Seam 2.
    const { sig } = buildArmInputs(subscriber.address);
    await fdusd.connect(subscriber).approve(await permit2.getAddress(), ethers.MaxUint256);
    const registerData = spliceRegisterSignature(facil.registerPermit2Mandate.calldata, sig);
    await facilitator.sendTransaction({ to: await settlement.getAddress(), data: registerData });

    const settlementAddr = await settlement.getAddress();
    const clientWallet = facil.addresses.clientWallet;
    const feeRecipient = facil.addresses.feeRecipient;
    const value = BigInt(facil.value);

    // Seam 1: send the RAW .NET executePermit2Settlement calldata as a facilitator transaction.
    const rawTx = { to: settlementAddr, data: facil.executePermit2Settlement.calldata };

    const clientBefore = await fdusd.balanceOf(clientWallet);
    const feeBefore = await fdusd.balanceOf(feeRecipient);
    const [, , nonceBeforePulls] = await permit2.allowance(
      subscriber.address,
      wallet.fdusdAddress,
      settlementAddr
    );

    // Pull #1
    await expect(facilitator.sendTransaction(rawTx)).to.not.be.reverted;
    // Pull #2 — SAME calldata, no new signature. This is the F1 on-chain fact.
    await expect(facilitator.sendTransaction(rawTx)).to.not.be.reverted;

    // Two cycles pulled: 10% fee to recipient, 90% residual to clientWallet, per pull.
    const feePerPull = (value * 1000n) / 10000n;
    const residualPerPull = value - feePerPull;
    expect(await fdusd.balanceOf(feeRecipient)).to.equal(feeBefore + feePerPull * 2n);
    expect(await fdusd.balanceOf(clientWallet)).to.equal(clientBefore + residualPerPull * 2n);

    // Seam 3: transferFrom does NOT touch the packed nonce — unchanged after both pulls.
    const [amountAfter, , nonceAfterPulls] = await permit2.allowance(
      subscriber.address,
      wallet.fdusdAddress,
      settlementAddr
    );
    expect(nonceAfterPulls).to.equal(nonceBeforePulls);
    // Allowance decremented by exactly two cycles.
    expect(amountAfter).to.equal(BigInt(wallet.cap) - value * 2n);
  });

  it("Seam 1 (register): the .NET registerPermit2Mandate calldata decodes 1:1 to the frozen ABI struct", async function () {
    const { settlement } = await loadFixture(deployFixture);
    // Seam 2 already EXECUTES the spliced .NET register calldata; this adds a precise field-by-field decode
    // so a struct-layout regression names the exact wrong field instead of just reverting on-chain.
    const iface = settlement.interface;
    const decoded = iface.parseTransaction({ data: facil.registerPermit2Mandate.calldata });
    expect(decoded).to.not.be.null;
    expect(decoded!.name).to.equal("registerPermit2Mandate");
    expect(decoded!.args[0]).to.equal(facil.addresses.subscriber); // owner
    const ps = decoded!.args[1];
    expect(ps.details.token).to.equal(facil.addresses.fdusd);
    expect(ps.spender).to.equal(facil.addresses.settlement);
    expect(ps.details.amount).to.equal(BigInt(wallet.cap));
  });
});
