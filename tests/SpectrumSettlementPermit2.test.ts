import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { MockERC20, MockPermit2, SpectrumSettlement } from "../typechain-types";
import { buildSubscriptionPermit, signPermitSingle, MAX_UINT48 } from "./helpers/permit2-eip712-helper";

/**
 * SpectrumSettlement — Permit2 recurring-subscription settlement path.
 *
 * Coverage:
 * - registerPermit2Mandate (arm): spender check, onlyFacilitator, nonce bump
 * - executePermit2Settlement (pull): distribute, residual, second pull no new sig, max recipients
 * - Contract-level enforcements: value <= cycleAmount, attestationHash non-empty, uint160 bound
 * - EIP-3009 path is covered by the sibling SpectrumSettlement.test.ts suite (regression).
 */
describe("SpectrumSettlement — Permit2 path", function () {
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let facilitator: SignerWithAddress;
  let subscriber: SignerWithAddress;
  let clientWallet: SignerWithAddress;
  let recipient1: SignerWithAddress;
  let recipient2: SignerWithAddress;
  let unauthorized: SignerWithAddress;

  let settlement: SpectrumSettlement;
  let permit2: MockPermit2;
  let fdusd: MockERC20;

  let chainId: bigint;
  let settlementAddr: string;
  let permit2Addr: string;
  let fdusdAddr: string;

  const CYCLE_AMOUNT = ethers.parseEther("10"); // 10 FDUSD / cycle
  const SUBSCRIBER_BALANCE = ethers.parseEther("1000");

  // Build a settlement instruction (residual to clientWallet, one 10% fee recipient by default).
  function createInstruction(overrides: any = {}) {
    return {
      clientWalletAddress:
        overrides.clientWalletAddress !== undefined ? overrides.clientWalletAddress : clientWallet.address,
      clientId: overrides.clientId !== undefined ? overrides.clientId : "sub-client-001",
      packageTier: overrides.packageTier !== undefined ? overrides.packageTier : 5,
      attestationHash: overrides.attestationHash !== undefined ? overrides.attestationHash : "consent-hash-abc",
      recipients: overrides.recipients || [
        { recipient: recipient1.address, basisPoints: 1000, flatAmount: 0 }, // 10%
      ],
    };
  }

  // Arm a mandate for `subscriber` with cap = cycleAmount * cycles.
  async function armMandate(cycles = 12) {
    await fdusd.connect(subscriber).approve(permit2Addr, ethers.MaxUint256);
    const [, , nonce0] = await permit2.allowance(subscriber.address, fdusdAddr, settlementAddr);
    const permitSingle = buildSubscriptionPermit({
      token: fdusdAddr,
      spender: settlementAddr,
      cycleAmount: CYCLE_AMOUNT,
      cycles,
      currentNonce: nonce0,
    });
    const sig = await signPermitSingle(subscriber, chainId, permitSingle, permit2Addr);
    await settlement.connect(facilitator).registerPermit2Mandate(subscriber.address, permitSingle, sig);
    return permitSingle;
  }

  beforeEach(async function () {
    [owner, admin, facilitator, subscriber, clientWallet, recipient1, recipient2, unauthorized] =
      await ethers.getSigners();

    // Deploy MockPermit2 first so we can bind the settlement contract to it.
    const MockPermit2Factory = await ethers.getContractFactory("MockPermit2");
    permit2 = await MockPermit2Factory.deploy();
    await permit2.waitForDeployment();
    permit2Addr = await permit2.getAddress();

    const SpectrumSettlement = await ethers.getContractFactory("SpectrumSettlement");
    settlement = await SpectrumSettlement.deploy(owner.address, permit2Addr);
    await settlement.waitForDeployment();
    settlementAddr = await settlement.getAddress();

    // FDUSD-like token: 18 decimals, standard ERC20 approve/transferFrom (Permit2 needs no EIP-2612).
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    fdusd = await MockERC20Factory.deploy("First Digital USD", "FDUSD", 18);
    await fdusd.waitForDeployment();
    fdusdAddr = await fdusd.getAddress();

    await fdusd.mint(subscriber.address, SUBSCRIBER_BALANCE);

    // Roles setup.
    const FACILITATOR_MANAGER_ROLE = await settlement.FACILITATOR_MANAGER_ROLE();
    await settlement.grantRole(FACILITATOR_MANAGER_ROLE, admin.address);
    await settlement.connect(admin).addFacilitator(facilitator.address);

    chainId = (await ethers.provider.getNetwork()).chainId;
  });

  describe("Deployment / Permit2 wiring", function () {
    it("Should bind the injected Permit2 address", async function () {
      expect(await settlement.PERMIT2()).to.equal(permit2Addr);
    });

    it("Should expose the canonical singleton constant", async function () {
      expect(await settlement.PERMIT2_SINGLETON()).to.equal(
        "0x000000000022D473030F116dDEE9F6B43aC78BA3"
      );
    });

    it("Should bind the canonical singleton when constructed with address(0)", async function () {
      const Factory = await ethers.getContractFactory("SpectrumSettlement");
      const s = await Factory.deploy(owner.address, ethers.ZeroAddress);
      await s.waitForDeployment();
      expect(await s.PERMIT2()).to.equal("0x000000000022D473030F116dDEE9F6B43aC78BA3");
    });
  });

  describe("registerPermit2Mandate (arm)", function () {
    it("Should arm an allowance and bump the packed nonce", async function () {
      await armMandate();
      const [amount, expiration, nonce] = await permit2.allowance(
        subscriber.address,
        fdusdAddr,
        settlementAddr
      );
      expect(amount).to.equal(CYCLE_AMOUNT * 12n);
      expect(expiration).to.equal(MAX_UINT48);
      expect(nonce).to.equal(1n); // permit() bumped 0 -> 1
    });

    it("Should emit Permit2MandateRegistered", async function () {
      await fdusd.connect(subscriber).approve(permit2Addr, ethers.MaxUint256);
      const [, , nonce0] = await permit2.allowance(subscriber.address, fdusdAddr, settlementAddr);
      const permitSingle = buildSubscriptionPermit({
        token: fdusdAddr,
        spender: settlementAddr,
        cycleAmount: CYCLE_AMOUNT,
        currentNonce: nonce0,
      });
      const sig = await signPermitSingle(subscriber, chainId, permitSingle, permit2Addr);
      await expect(
        settlement.connect(facilitator).registerPermit2Mandate(subscriber.address, permitSingle, sig)
      )
        .to.emit(settlement, "Permit2MandateRegistered")
        .withArgs(subscriber.address, fdusdAddr, CYCLE_AMOUNT * 12n, MAX_UINT48);
    });

    it("Should revert if spender != contract", async function () {
      await fdusd.connect(subscriber).approve(permit2Addr, ethers.MaxUint256);
      const [, , nonce0] = await permit2.allowance(subscriber.address, fdusdAddr, settlementAddr);
      const permitSingle = buildSubscriptionPermit({
        token: fdusdAddr,
        spender: unauthorized.address, // wrong spender
        cycleAmount: CYCLE_AMOUNT,
        currentNonce: nonce0,
      });
      const sig = await signPermitSingle(subscriber, chainId, permitSingle, permit2Addr);
      await expect(
        settlement.connect(facilitator).registerPermit2Mandate(subscriber.address, permitSingle, sig)
      ).to.be.revertedWithCustomError(settlement, "MandateSpenderMismatch");
    });

    it("Should revert if caller is not a facilitator", async function () {
      await fdusd.connect(subscriber).approve(permit2Addr, ethers.MaxUint256);
      const [, , nonce0] = await permit2.allowance(subscriber.address, fdusdAddr, settlementAddr);
      const permitSingle = buildSubscriptionPermit({
        token: fdusdAddr,
        spender: settlementAddr,
        cycleAmount: CYCLE_AMOUNT,
        currentNonce: nonce0,
      });
      const sig = await signPermitSingle(subscriber, chainId, permitSingle, permit2Addr);
      await expect(
        settlement.connect(unauthorized).registerPermit2Mandate(subscriber.address, permitSingle, sig)
      ).to.be.revertedWithCustomError(settlement, "NotFacilitator");
    });

    it("Should block replay of the same permit signature (nonce guard)", async function () {
      const permitSingle = await armMandate();
      const sig = await signPermitSingle(subscriber, chainId, permitSingle, permit2Addr);
      await expect(
        settlement.connect(facilitator).registerPermit2Mandate(subscriber.address, permitSingle, sig)
      ).to.be.revertedWithCustomError(permit2, "InvalidNonce");
    });
  });

  describe("executePermit2Settlement (pull + distribute)", function () {
    beforeEach(async function () {
      await armMandate();
    });

    it("Should pull one cycle, distribute fee, forward residual to client wallet", async function () {
      const instruction = createInstruction();
      await expect(
        settlement
          .connect(facilitator)
          .executePermit2Settlement(fdusdAddr, subscriber.address, CYCLE_AMOUNT, CYCLE_AMOUNT, instruction)
      )
        .to.emit(settlement, "SpectrumSettlementExecuted")
        .withArgs(
          fdusdAddr,
          subscriber.address,
          clientWallet.address,
          "sub-client-001",
          5,
          CYCLE_AMOUNT,
          ethers.parseEther("1"), // 10% fee
          ethers.parseEther("9"), // 90% residual
          "consent-hash-abc"
        );

      expect(await fdusd.balanceOf(recipient1.address)).to.equal(ethers.parseEther("1"));
      expect(await fdusd.balanceOf(clientWallet.address)).to.equal(ethers.parseEther("9"));
      expect(await fdusd.balanceOf(settlementAddr)).to.equal(0); // fully forwarded
    });

    it("Should allow a SECOND pull with no new signature and no nonce change", async function () {
      const instruction = createInstruction();
      await settlement
        .connect(facilitator)
        .executePermit2Settlement(fdusdAddr, subscriber.address, CYCLE_AMOUNT, CYCLE_AMOUNT, instruction);
      await settlement
        .connect(facilitator)
        .executePermit2Settlement(fdusdAddr, subscriber.address, CYCLE_AMOUNT, CYCLE_AMOUNT, instruction);

      const [amount, , nonce] = await permit2.allowance(subscriber.address, fdusdAddr, settlementAddr);
      expect(amount).to.equal(CYCLE_AMOUNT * 10n); // 2 of 12 consumed
      expect(nonce).to.equal(1n); // transferFrom never touches the nonce
      expect(await fdusd.balanceOf(clientWallet.address)).to.equal(ethers.parseEther("18"));
    });

    it("Should revert when value > cycleAmount (over-pull within cap)", async function () {
      const instruction = createInstruction();
      const tooMuch = CYCLE_AMOUNT + 1n;
      await expect(
        settlement
          .connect(facilitator)
          .executePermit2Settlement(fdusdAddr, subscriber.address, tooMuch, CYCLE_AMOUNT, instruction)
      ).to.be.revertedWithCustomError(settlement, "ValueExceedsCycleAmount");
    });

    it("Should revert when attestationHash is empty (validated, emitted for reconciliation)", async function () {
      const instruction = createInstruction({ attestationHash: "" });
      await expect(
        settlement
          .connect(facilitator)
          .executePermit2Settlement(fdusdAddr, subscriber.address, CYCLE_AMOUNT, CYCLE_AMOUNT, instruction)
      ).to.be.revertedWithCustomError(settlement, "EmptyAttestationHash");
    });

    it("Should revert when caller is not a facilitator", async function () {
      const instruction = createInstruction();
      await expect(
        settlement
          .connect(unauthorized)
          .executePermit2Settlement(fdusdAddr, subscriber.address, CYCLE_AMOUNT, CYCLE_AMOUNT, instruction)
      ).to.be.revertedWithCustomError(settlement, "NotFacilitator");
    });

    it("Should revert once the cap is exhausted", async function () {
      // Re-arm with cap = exactly 1 cycle so a second pull exceeds the Permit2 allowance.
      // (Fresh subscriber2 to get a clean nonce-0 allowance slot.)
      const [, , , , , , , , subscriber2] = await ethers.getSigners();
      await fdusd.mint(subscriber2.address, SUBSCRIBER_BALANCE);
      await fdusd.connect(subscriber2).approve(permit2Addr, ethers.MaxUint256);
      const [, , n0] = await permit2.allowance(subscriber2.address, fdusdAddr, settlementAddr);
      const permitSingle = buildSubscriptionPermit({
        token: fdusdAddr,
        spender: settlementAddr,
        cycleAmount: CYCLE_AMOUNT,
        cycles: 1,
        currentNonce: n0,
      });
      const sig = await signPermitSingle(subscriber2, chainId, permitSingle, permit2Addr);
      await settlement.connect(facilitator).registerPermit2Mandate(subscriber2.address, permitSingle, sig);

      const instruction = createInstruction();
      await settlement
        .connect(facilitator)
        .executePermit2Settlement(fdusdAddr, subscriber2.address, CYCLE_AMOUNT, CYCLE_AMOUNT, instruction);
      await expect(
        settlement
          .connect(facilitator)
          .executePermit2Settlement(fdusdAddr, subscriber2.address, CYCLE_AMOUNT, CYCLE_AMOUNT, instruction)
      ).to.be.revertedWithCustomError(permit2, "InsufficientAllowance");
    });

    it("Should handle the maximum of 25 fee recipients", async function () {
      // 25 distinct non-zero recipient addresses, each taking 1% (bp 100) => 25% distributed,
      // 75% residual. Recipients only receive funds (no signing), so synthetic addresses suffice.
      const recipients = [];
      for (let i = 0; i < 25; i++) {
        const addr = ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(i + 1), 20));
        recipients.push({ recipient: addr, basisPoints: 100, flatAmount: 0 });
      }
      const instruction = createInstruction({ recipients });
      await settlement
        .connect(facilitator)
        .executePermit2Settlement(fdusdAddr, subscriber.address, CYCLE_AMOUNT, CYCLE_AMOUNT, instruction);

      // 75% of 10 FDUSD = 7.5 residual to client wallet.
      expect(await fdusd.balanceOf(clientWallet.address)).to.equal(ethers.parseEther("7.5"));
    });
  });
});
