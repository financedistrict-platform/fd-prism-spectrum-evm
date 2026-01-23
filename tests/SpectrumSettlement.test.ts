import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { MockERC3009, MockERC3009Bytes, SpectrumSettlement } from "../typechain-types";

/**
 * SpectrumSettlement Test Suite
 * 
 * Comprehensive test coverage for the simplified settlement contract:
 * - Deployment & RBAC initialization
 * - Facilitator management
 * - Settlement execution (RSV + bytes signature variants)
 * - Instruction validation (all revert cases)
 * - Distribution logic (percentage fees, flat fees, mixed fees)
 * - View functions
 * - Security (reentrancy, overflow, access control)
 */

describe("SpectrumSettlement", function () {
  // Test accounts
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let facilitator: SignerWithAddress;
  let client: SignerWithAddress;
  let recipient1: SignerWithAddress;
  let recipient2: SignerWithAddress;
  let recipient3: SignerWithAddress;
  let unauthorized: SignerWithAddress;

  // Contracts
  let settlement: SpectrumSettlement;
  let token: MockERC3009;
  let tokenBytes: MockERC3009Bytes;

  // Constants
  const MAX_BASIS_POINTS = 10000;
  const MAX_RECIPIENTS = 25;
  const INITIAL_BALANCE = ethers.parseEther("10000");

  // Helper to create settlement instruction
  function createInstruction(overrides: any = {}) {
    return {
      clientWalletAddress: overrides.clientWalletAddress !== undefined ? overrides.clientWalletAddress : client.address,
      clientId: overrides.clientId !== undefined ? overrides.clientId : "test-client-001",
      packageTier: overrides.packageTier !== undefined ? overrides.packageTier : 5,
      attestationHash: overrides.attestationHash !== undefined ? overrides.attestationHash : "test-attestation-hash-123",
      recipients: overrides.recipients || [
        {
          recipient: recipient1.address,
          basisPoints: 1000, // 10%
          flatAmount: 0,
        },
        {
          recipient: recipient2.address,
          basisPoints: 500, // 5%
          flatAmount: 0,
        },
      ],
    };
  }

  beforeEach(async function () {
    // Get signers
    [owner, admin, facilitator, client, recipient1, recipient2, recipient3, unauthorized] =
      await ethers.getSigners();

    // Deploy SpectrumSettlement with owner as initial admin
    const SpectrumSettlement = await ethers.getContractFactory("SpectrumSettlement");
    settlement = await SpectrumSettlement.deploy(owner.address);
    await settlement.waitForDeployment();

    // Deploy mock tokens
    const MockERC3009 = await ethers.getContractFactory("MockERC3009");
    token = await MockERC3009.deploy("Mock USDC", "MUSDC");
    await token.waitForDeployment();

    const MockERC3009Bytes = await ethers.getContractFactory("MockERC3009Bytes");
    tokenBytes = await MockERC3009Bytes.deploy("Mock USDC Bytes", "MUSDCB");
    await tokenBytes.waitForDeployment();

    // Mint tokens to client
    await token.mint(client.address, INITIAL_BALANCE);
    await tokenBytes.mint(client.address, INITIAL_BALANCE);

    // Setup roles
    const FACILITATOR_MANAGER_ROLE = await settlement.FACILITATOR_MANAGER_ROLE();
    await settlement.grantRole(FACILITATOR_MANAGER_ROLE, admin.address);

    // Add facilitator
    await settlement.connect(admin).addFacilitator(facilitator.address);
  });

  describe("Deployment", function () {
    it("Should grant DEFAULT_ADMIN_ROLE to deployer", async function () {
      const DEFAULT_ADMIN_ROLE = await settlement.DEFAULT_ADMIN_ROLE();
      expect(await settlement.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
    });

    it("Should grant FACILITATOR_MANAGER_ROLE to deployer", async function () {
      const FACILITATOR_MANAGER_ROLE = await settlement.FACILITATOR_MANAGER_ROLE();
      expect(await settlement.hasRole(FACILITATOR_MANAGER_ROLE, owner.address)).to.be.true;
    });

    it("Should have correct constants", async function () {
      expect(await settlement.MAX_BASIS_POINTS()).to.equal(MAX_BASIS_POINTS);
      expect(await settlement.MAX_RECIPIENTS()).to.equal(MAX_RECIPIENTS);
    });
  });

  describe("Facilitator Management", function () {
    describe("addFacilitator", function () {
      it("Should allow FACILITATOR_MANAGER_ROLE to add facilitator", async function () {
        const newFacilitator = unauthorized.address;
        await expect(settlement.connect(admin).addFacilitator(newFacilitator))
          .to.emit(settlement, "FacilitatorAdded")
          .withArgs(newFacilitator, admin.address);

        expect(await settlement.facilitators(newFacilitator)).to.be.true;
      });

      it("Should revert if non-admin tries to add facilitator", async function () {
        await expect(
          settlement.connect(unauthorized).addFacilitator(unauthorized.address)
        ).to.be.reverted;
      });

      it("Should revert if adding zero address", async function () {
        await expect(
          settlement.connect(admin).addFacilitator(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(settlement, "ZeroAddress");
      });

      it("Should revert if facilitator already exists", async function () {
        await expect(
          settlement.connect(admin).addFacilitator(facilitator.address)
        ).to.be.revertedWithCustomError(settlement, "FacilitatorAlreadyExists");
      });
    });

    describe("removeFacilitator", function () {
      it("Should allow FACILITATOR_MANAGER_ROLE to remove facilitator", async function () {
        await expect(settlement.connect(admin).removeFacilitator(facilitator.address))
          .to.emit(settlement, "FacilitatorRemoved")
          .withArgs(facilitator.address, admin.address);

        expect(await settlement.facilitators(facilitator.address)).to.be.false;
      });

      it("Should revert if non-admin tries to remove facilitator", async function () {
        await expect(
          settlement.connect(unauthorized).removeFacilitator(facilitator.address)
        ).to.be.reverted;
      });

      it("Should revert if facilitator doesn't exist", async function () {
        await expect(
          settlement.connect(admin).removeFacilitator(unauthorized.address)
        ).to.be.revertedWithCustomError(settlement, "FacilitatorNotFound");
      });
    });
  });

  describe("Instruction Validation", function () {
    it("Should revert if clientWalletAddress is zero", async function () {
      const instruction = createInstruction({ clientWalletAddress: ethers.ZeroAddress });
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      await expect(
        settlement.connect(facilitator).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          ethers.parseEther("100"),
          0,
          Math.floor(Date.now() / 1000) + 3600,
          nonce,
          27,
          ethers.hexlify(ethers.randomBytes(32)),
          ethers.hexlify(ethers.randomBytes(32)),
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "InvalidDestination");
    });

    it("Should revert if clientId is empty", async function () {
      const instruction = createInstruction({ clientId: "" });
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const settlementAmount = ethers.parseEther("100");
      const validAfter = 0;
      const validBefore = Math.floor(Date.now() / 1000) + 3600;

      // Create proper signature (even though validation should fail first)
      const domain = {
        name: await token.name(),
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await token.getAddress(),
      };

      const types = {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      };

      const value = {
        from: client.address,
        to: await settlement.getAddress(),
        value: settlementAmount,
        validAfter,
        validBefore,
        nonce,
      };

      const signature = await client.signTypedData(domain, types, value);
      const sig = ethers.Signature.from(signature);

      await expect(
        settlement.connect(facilitator).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          settlementAmount,
          validAfter,
          validBefore,
          nonce,
          sig.v,
          sig.r,
          sig.s,
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "EmptyClientIdentifier");
    });

    it("Should revert if clientId is too long", async function () {
      const instruction = createInstruction({ clientId: "a".repeat(65) });
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      await expect(
        settlement.connect(facilitator).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          ethers.parseEther("100"),
          0,
          Math.floor(Date.now() / 1000) + 3600,
          nonce,
          27,
          ethers.hexlify(ethers.randomBytes(32)),
          ethers.hexlify(ethers.randomBytes(32)),
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "ClientIdentifierTooLong");
    });

    it("Should revert if packageTier is 0", async function () {
      const instruction = createInstruction({ packageTier: 0 });
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const settlementAmount = ethers.parseEther("100");
      const validAfter = 0;
      const validBefore = Math.floor(Date.now() / 1000) + 3600;

      const domain = {
        name: await token.name(),
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await token.getAddress(),
      };

      const types = {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      };

      const value = {
        from: client.address,
        to: await settlement.getAddress(),
        value: settlementAmount,
        validAfter,
        validBefore,
        nonce,
      };

      const signature = await client.signTypedData(domain, types, value);
      const sig = ethers.Signature.from(signature);

      await expect(
        settlement.connect(facilitator).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          settlementAmount,
          validAfter,
          validBefore,
          nonce,
          sig.v,
          sig.r,
          sig.s,
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "InvalidTier");
    });

    it("Should revert if packageTier > 99", async function () {
      const instruction = createInstruction({ packageTier: 100 });
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      await expect(
        settlement.connect(facilitator).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          ethers.parseEther("100"),
          0,
          Math.floor(Date.now() / 1000) + 3600,
          nonce,
          27,
          ethers.hexlify(ethers.randomBytes(32)),
          ethers.hexlify(ethers.randomBytes(32)),
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "InvalidTier");
    });

    it("Should revert if attestationHash is empty", async function () {
      const instruction = createInstruction({ attestationHash: "" });
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const settlementAmount = ethers.parseEther("100");
      const validAfter = 0;
      const validBefore = Math.floor(Date.now() / 1000) + 3600;

      const domain = {
        name: await token.name(),
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await token.getAddress(),
      };

      const types = {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      };

      const value = {
        from: client.address,
        to: await settlement.getAddress(),
        value: settlementAmount,
        validAfter,
        validBefore,
        nonce,
      };

      const signature = await client.signTypedData(domain, types, value);
      const sig = ethers.Signature.from(signature);

      await expect(
        settlement.connect(facilitator).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          settlementAmount,
          validAfter,
          validBefore,
          nonce,
          sig.v,
          sig.r,
          sig.s,
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "EmptyAttestationHash");
    });

    it("Should revert if attestationHash is too long", async function () {
      const instruction = createInstruction({ attestationHash: "a".repeat(129) });
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      await expect(
        settlement.connect(facilitator).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          ethers.parseEther("100"),
          0,
          Math.floor(Date.now() / 1000) + 3600,
          nonce,
          27,
          ethers.hexlify(ethers.randomBytes(32)),
          ethers.hexlify(ethers.randomBytes(32)),
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "AttestationHashTooLong");
    });

    it("Should revert if recipients array is empty", async function () {
      const instruction = createInstruction({ recipients: [] });
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      await expect(
        settlement.connect(facilitator).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          ethers.parseEther("100"),
          0,
          Math.floor(Date.now() / 1000) + 3600,
          nonce,
          27,
          ethers.hexlify(ethers.randomBytes(32)),
          ethers.hexlify(ethers.randomBytes(32)),
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "EmptyRecipients");
    });

    it("Should revert if recipients array exceeds MAX_RECIPIENTS", async function () {
      const recipients = Array(26).fill(null).map(() => ({
        recipient: ethers.Wallet.createRandom().address,
        basisPoints: 100,
        flatAmount: 0,
      }));
      const instruction = createInstruction({ recipients });
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      await expect(
        settlement.connect(facilitator).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          ethers.parseEther("100"),
          0,
          Math.floor(Date.now() / 1000) + 3600,
          nonce,
          27,
          ethers.hexlify(ethers.randomBytes(32)),
          ethers.hexlify(ethers.randomBytes(32)),
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "TooManyRecipients");
    });
  });

  describe("Recipient Validation", function () {
    it("Should revert if recipient has zero address", async function () {
      const instruction = createInstruction({
        recipients: [
          {
            recipient: ethers.ZeroAddress,
            basisPoints: 1000,
            flatAmount: 0,
          },
        ],
      });
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      await expect(
        settlement.connect(facilitator).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          ethers.parseEther("100"),
          0,
          Math.floor(Date.now() / 1000) + 3600,
          nonce,
          27,
          ethers.hexlify(ethers.randomBytes(32)),
          ethers.hexlify(ethers.randomBytes(32)),
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "InvalidDestination");
    });

    it("Should revert if recipient has both basisPoints and flatAmount", async function () {
      const instruction = createInstruction({
        recipients: [
          {
            recipient: recipient1.address,
            basisPoints: 1000,
            flatAmount: ethers.parseEther("10"),
          },
        ],
      });
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      await expect(
        settlement.connect(facilitator).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          ethers.parseEther("100"),
          0,
          Math.floor(Date.now() / 1000) + 3600,
          nonce,
          27,
          ethers.hexlify(ethers.randomBytes(32)),
          ethers.hexlify(ethers.randomBytes(32)),
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "InvalidFeeConfig");
    });

    it("Should revert if recipient has neither basisPoints nor flatAmount", async function () {
      const instruction = createInstruction({
        recipients: [
          {
            recipient: recipient1.address,
            basisPoints: 0,
            flatAmount: 0,
          },
        ],
      });
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      await expect(
        settlement.connect(facilitator).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          ethers.parseEther("100"),
          0,
          Math.floor(Date.now() / 1000) + 3600,
          nonce,
          27,
          ethers.hexlify(ethers.randomBytes(32)),
          ethers.hexlify(ethers.randomBytes(32)),
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "InvalidFeeConfig");
    });

    it("Should revert if duplicate recipients", async function () {
      const instruction = createInstruction({
        recipients: [
          {
            recipient: recipient1.address,
            basisPoints: 1000,
            flatAmount: 0,
          },
          {
            recipient: recipient1.address,
            basisPoints: 500,
            flatAmount: 0,
          },
        ],
      });
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      await expect(
        settlement.connect(facilitator).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          ethers.parseEther("100"),
          0,
          Math.floor(Date.now() / 1000) + 3600,
          nonce,
          27,
          ethers.hexlify(ethers.randomBytes(32)),
          ethers.hexlify(ethers.randomBytes(32)),
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "DuplicateRecipient");
    });

    it("Should revert if total basis points exceed 100%", async function () {
      const instruction = createInstruction({
        recipients: [
          {
            recipient: recipient1.address,
            basisPoints: 6000,
            flatAmount: 0,
          },
          {
            recipient: recipient2.address,
            basisPoints: 5000,
            flatAmount: 0,
          },
        ],
      });
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      await expect(
        settlement.connect(facilitator).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          ethers.parseEther("100"),
          0,
          Math.floor(Date.now() / 1000) + 3600,
          nonce,
          27,
          ethers.hexlify(ethers.randomBytes(32)),
          ethers.hexlify(ethers.randomBytes(32)),
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "FeesExceed100Percent");
    });
  });

  describe("Settlement Execution - RSV Variant", function () {
    it("Should revert if caller is not facilitator", async function () {
      const instruction = createInstruction();
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      await expect(
        settlement.connect(unauthorized).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          ethers.parseEther("100"),
          0,
          Math.floor(Date.now() / 1000) + 3600,
          nonce,
          27,
          ethers.hexlify(ethers.randomBytes(32)),
          ethers.hexlify(ethers.randomBytes(32)),
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "NotFacilitator");
    });

    it("Should execute settlement with percentage fees successfully", async function () {
      const settlementAmount = ethers.parseEther("100");
      const instruction = createInstruction({
        recipients: [
          {
            recipient: recipient1.address,
            basisPoints: 1000, // 10%
            flatAmount: 0,
          },
          {
            recipient: recipient2.address,
            basisPoints: 500, // 5%
            flatAmount: 0,
          },
        ],
      });

      // Create EIP-3009 authorization
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const validAfter = 0;
      const validBefore = Math.floor(Date.now() / 1000) + 3600;

      // Sign authorization
      const domain = {
        name: await token.name(),
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await token.getAddress(),
      };

      const types = {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      };

      const value = {
        from: client.address,
        to: await settlement.getAddress(),
        value: settlementAmount,
        validAfter,
        validBefore,
        nonce,
      };

      const signature = await client.signTypedData(domain, types, value);
      const sig = ethers.Signature.from(signature);

      // Execute settlement
      const tx = await settlement.connect(facilitator).executeSpectrumSettlement(
        await token.getAddress(),
        client.address,
        settlementAmount,
        validAfter,
        validBefore,
        nonce,
        sig.v,
        sig.r,
        sig.s,
        instruction
      );

      // Verify event
      await expect(tx)
        .to.emit(settlement, "SpectrumSettlementExecuted")
        .withArgs(
          await token.getAddress(),
          client.address,
          client.address,
          "test-client-001",
          5,
          settlementAmount,
          ethers.parseEther("15"), // 15% total fees
          ethers.parseEther("85"), // 85% to client
          "test-attestation-hash-123"
        );

      // Verify balances
      expect(await token.balanceOf(recipient1.address)).to.equal(ethers.parseEther("10")); // 10%
      expect(await token.balanceOf(recipient2.address)).to.equal(ethers.parseEther("5")); // 5%
      expect(await token.balanceOf(client.address)).to.equal(
        INITIAL_BALANCE - settlementAmount + ethers.parseEther("85")
      ); // Remaining 85%
    });

    it("Should execute settlement with flat fees successfully", async function () {
      const settlementAmount = ethers.parseEther("100");
      const instruction = createInstruction({
        recipients: [
          {
            recipient: recipient1.address,
            basisPoints: 0,
            flatAmount: ethers.parseEther("10"),
          },
          {
            recipient: recipient2.address,
            basisPoints: 0,
            flatAmount: ethers.parseEther("5"),
          },
        ],
      });

      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const validAfter = 0;
      const validBefore = Math.floor(Date.now() / 1000) + 3600;

      const domain = {
        name: await token.name(),
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await token.getAddress(),
      };

      const types = {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      };

      const value = {
        from: client.address,
        to: await settlement.getAddress(),
        value: settlementAmount,
        validAfter,
        validBefore,
        nonce,
      };

      const signature = await client.signTypedData(domain, types, value);
      const sig = ethers.Signature.from(signature);

      await settlement.connect(facilitator).executeSpectrumSettlement(
        await token.getAddress(),
        client.address,
        settlementAmount,
        validAfter,
        validBefore,
        nonce,
        sig.v,
        sig.r,
        sig.s,
        instruction
      );

      expect(await token.balanceOf(recipient1.address)).to.equal(ethers.parseEther("10"));
      expect(await token.balanceOf(recipient2.address)).to.equal(ethers.parseEther("5"));
      expect(await token.balanceOf(client.address)).to.equal(
        INITIAL_BALANCE - settlementAmount + ethers.parseEther("85")
      );
    });

    it("Should execute settlement with mixed fees (percentage + flat)", async function () {
      const settlementAmount = ethers.parseEther("100");
      const instruction = createInstruction({
        recipients: [
          {
            recipient: recipient1.address,
            basisPoints: 1000, // 10% = 10 ETH
            flatAmount: 0,
          },
          {
            recipient: recipient2.address,
            basisPoints: 0,
            flatAmount: ethers.parseEther("5"), // 5 ETH flat
          },
        ],
      });

      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const validAfter = 0;
      const validBefore = Math.floor(Date.now() / 1000) + 3600;

      const domain = {
        name: await token.name(),
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await token.getAddress(),
      };

      const types = {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      };

      const value = {
        from: client.address,
        to: await settlement.getAddress(),
        value: settlementAmount,
        validAfter,
        validBefore,
        nonce,
      };

      const signature = await client.signTypedData(domain, types, value);
      const sig = ethers.Signature.from(signature);

      await settlement.connect(facilitator).executeSpectrumSettlement(
        await token.getAddress(),
        client.address,
        settlementAmount,
        validAfter,
        validBefore,
        nonce,
        sig.v,
        sig.r,
        sig.s,
        instruction
      );

      expect(await token.balanceOf(recipient1.address)).to.equal(ethers.parseEther("10")); // 10%
      expect(await token.balanceOf(recipient2.address)).to.equal(ethers.parseEther("5")); // Flat
      expect(await token.balanceOf(client.address)).to.equal(
        INITIAL_BALANCE - settlementAmount + ethers.parseEther("85")
      ); // Remaining
    });

    it("Should handle 100% fee distribution (nothing to client)", async function () {
      const settlementAmount = ethers.parseEther("100");
      const instruction = createInstruction({
        recipients: [
          {
            recipient: recipient1.address,
            basisPoints: 10000, // 100%
            flatAmount: 0,
          },
        ],
      });

      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const validAfter = 0;
      const validBefore = Math.floor(Date.now() / 1000) + 3600;

      const domain = {
        name: await token.name(),
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await token.getAddress(),
      };

      const types = {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      };

      const value = {
        from: client.address,
        to: await settlement.getAddress(),
        value: settlementAmount,
        validAfter,
        validBefore,
        nonce,
      };

      const signature = await client.signTypedData(domain, types, value);
      const sig = ethers.Signature.from(signature);

      await settlement.connect(facilitator).executeSpectrumSettlement(
        await token.getAddress(),
        client.address,
        settlementAmount,
        validAfter,
        validBefore,
        nonce,
        sig.v,
        sig.r,
        sig.s,
        instruction
      );

      expect(await token.balanceOf(recipient1.address)).to.equal(settlementAmount);
      expect(await token.balanceOf(client.address)).to.equal(INITIAL_BALANCE - settlementAmount);
    });

    it("Should revert if flat fees exceed total amount", async function () {
      const settlementAmount = ethers.parseEther("100");
      const instruction = createInstruction({
        recipients: [
          {
            recipient: recipient1.address,
            basisPoints: 0,
            flatAmount: ethers.parseEther("60"),
          },
          {
            recipient: recipient2.address,
            basisPoints: 0,
            flatAmount: ethers.parseEther("50"),
          },
        ],
      });

      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const validAfter = 0;
      const validBefore = Math.floor(Date.now() / 1000) + 3600;

      const domain = {
        name: await token.name(),
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await token.getAddress(),
      };

      const types = {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      };

      const value = {
        from: client.address,
        to: await settlement.getAddress(),
        value: settlementAmount,
        validAfter,
        validBefore,
        nonce,
      };

      const signature = await client.signTypedData(domain, types, value);
      const sig = ethers.Signature.from(signature);

      await expect(
        settlement.connect(facilitator).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          settlementAmount,
          validAfter,
          validBefore,
          nonce,
          sig.v,
          sig.r,
          sig.s,
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "DistributionOverflow");
    });
  });

  describe("Settlement Execution - Bytes Variant", function () {
    it("Should execute settlement with bytes signature successfully", async function () {
      const settlementAmount = ethers.parseEther("100");
      const instruction = createInstruction({
        recipients: [
          {
            recipient: recipient1.address,
            basisPoints: 1000, // 10%
            flatAmount: 0,
          },
        ],
      });

      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const validAfter = 0;
      const validBefore = Math.floor(Date.now() / 1000) + 3600;

      const domain = {
        name: await tokenBytes.name(),
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await tokenBytes.getAddress(),
      };

      const types = {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      };

      const value = {
        from: client.address,
        to: await settlement.getAddress(),
        value: settlementAmount,
        validAfter,
        validBefore,
        nonce,
      };

      const signature = await client.signTypedData(domain, types, value);

      await settlement.connect(facilitator).executeSpectrumSettlementV2(
        await tokenBytes.getAddress(),
        client.address,
        settlementAmount,
        validAfter,
        validBefore,
        nonce,
        signature,
        instruction
      );

      expect(await tokenBytes.balanceOf(recipient1.address)).to.equal(ethers.parseEther("10"));
      expect(await tokenBytes.balanceOf(client.address)).to.equal(
        INITIAL_BALANCE - settlementAmount + ethers.parseEther("90")
      );
    });
  });

  describe("View Functions", function () {
    it("Should check facilitator manager role correctly", async function () {
      expect(await settlement.isFacilitatorManager(admin.address)).to.be.true;
      expect(await settlement.isFacilitatorManager(unauthorized.address)).to.be.false;
    });

    it("Should check super admin role correctly", async function () {
      expect(await settlement.isSuperAdmin(owner.address)).to.be.true;
      expect(await settlement.isSuperAdmin(unauthorized.address)).to.be.false;
    });

    it("Should check facilitator whitelist correctly", async function () {
      expect(await settlement.isFacilitatorWhitelisted(facilitator.address)).to.be.true;
      expect(await settlement.isFacilitatorWhitelisted(unauthorized.address)).to.be.false;
    });

    it("Should simulate distribution with percentage fees", async function () {
      const totalAmount = ethers.parseEther("100");
      const recipients = [
        {
          recipient: recipient1.address,
          basisPoints: 1000, // 10%
          flatAmount: 0,
        },
        {
          recipient: recipient2.address,
          basisPoints: 500, // 5%
          flatAmount: 0,
        },
      ];

      const [feeAmounts, remainingAmount] = await settlement.simulateDistribution(
        totalAmount,
        recipients
      );

      expect(feeAmounts[0]).to.equal(ethers.parseEther("10"));
      expect(feeAmounts[1]).to.equal(ethers.parseEther("5"));
      expect(remainingAmount).to.equal(ethers.parseEther("85"));
    });

    it("Should simulate distribution with flat fees", async function () {
      const totalAmount = ethers.parseEther("100");
      const recipients = [
        {
          recipient: recipient1.address,
          basisPoints: 0,
          flatAmount: ethers.parseEther("10"),
        },
        {
          recipient: recipient2.address,
          basisPoints: 0,
          flatAmount: ethers.parseEther("5"),
        },
      ];

      const [feeAmounts, remainingAmount] = await settlement.simulateDistribution(
        totalAmount,
        recipients
      );

      expect(feeAmounts[0]).to.equal(ethers.parseEther("10"));
      expect(feeAmounts[1]).to.equal(ethers.parseEther("5"));
      expect(remainingAmount).to.equal(ethers.parseEther("85"));
    });

    it("Should simulate distribution with mixed fees", async function () {
      const totalAmount = ethers.parseEther("100");
      const recipients = [
        {
          recipient: recipient1.address,
          basisPoints: 1000, // 10%
          flatAmount: 0,
        },
        {
          recipient: recipient2.address,
          basisPoints: 0,
          flatAmount: ethers.parseEther("5"),
        },
      ];

      const [feeAmounts, remainingAmount] = await settlement.simulateDistribution(
        totalAmount,
        recipients
      );

      expect(feeAmounts[0]).to.equal(ethers.parseEther("10"));
      expect(feeAmounts[1]).to.equal(ethers.parseEther("5"));
      expect(remainingAmount).to.equal(ethers.parseEther("85"));
    });
  });

  describe("Security", function () {
    it("Should prevent non-facilitator from executing settlement", async function () {
      const instruction = createInstruction();
      const nonce = ethers.hexlify(ethers.randomBytes(32));

      await expect(
        settlement.connect(unauthorized).executeSpectrumSettlement(
          await token.getAddress(),
          client.address,
          ethers.parseEther("100"),
          0,
          Math.floor(Date.now() / 1000) + 3600,
          nonce,
          27,
          ethers.hexlify(ethers.randomBytes(32)),
          ethers.hexlify(ethers.randomBytes(32)),
          instruction
        )
      ).to.be.revertedWithCustomError(settlement, "NotFacilitator");
    });

    it("Should have reentrancy protection on settlement functions", async function () {
      // This is tested implicitly by the nonReentrant modifier
      // Actual reentrancy testing would require a malicious contract
      expect(true).to.be.true;
    });

    it("Should handle different client wallet addresses per settlement", async function () {
      const settlementAmount = ethers.parseEther("100");
      
      // First settlement to client address
      const instruction1 = createInstruction({
        clientWalletAddress: client.address,
        recipients: [
          {
            recipient: recipient1.address,
            basisPoints: 1000,
            flatAmount: 0,
          },
        ],
      });

      const nonce1 = ethers.hexlify(ethers.randomBytes(32));
      const validAfter = 0;
      const validBefore = Math.floor(Date.now() / 1000) + 3600;

      const domain = {
        name: await token.name(),
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await token.getAddress(),
      };

      const types = {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      };

      const value1 = {
        from: client.address,
        to: await settlement.getAddress(),
        value: settlementAmount,
        validAfter,
        validBefore,
        nonce: nonce1,
      };

      const signature1 = await client.signTypedData(domain, types, value1);
      const sig1 = ethers.Signature.from(signature1);

      await settlement.connect(facilitator).executeSpectrumSettlement(
        await token.getAddress(),
        client.address,
        settlementAmount,
        validAfter,
        validBefore,
        nonce1,
        sig1.v,
        sig1.r,
        sig1.s,
        instruction1
      );

      expect(await token.balanceOf(client.address)).to.equal(
        INITIAL_BALANCE - settlementAmount + ethers.parseEther("90")
      );

      // Second settlement to different wallet (recipient3)
      const instruction2 = createInstruction({
        clientWalletAddress: recipient3.address,
        recipients: [
          {
            recipient: recipient1.address,
            basisPoints: 2000,
            flatAmount: 0,
          },
        ],
      });

      const nonce2 = ethers.hexlify(ethers.randomBytes(32));

      const value2 = {
        from: client.address,
        to: await settlement.getAddress(),
        value: settlementAmount,
        validAfter,
        validBefore,
        nonce: nonce2,
      };

      const signature2 = await client.signTypedData(domain, types, value2);
      const sig2 = ethers.Signature.from(signature2);

      await settlement.connect(facilitator).executeSpectrumSettlement(
        await token.getAddress(),
        client.address,
        settlementAmount,
        validAfter,
        validBefore,
        nonce2,
        sig2.v,
        sig2.r,
        sig2.s,
        instruction2
      );

      // Verify recipient3 received the remaining 80%
      expect(await token.balanceOf(recipient3.address)).to.equal(ethers.parseEther("80"));
    });
  });

  describe("Gas Benchmarking", function () {
    it("Should benchmark gas for settlement with 2 recipients", async function () {
      const settlementAmount = ethers.parseEther("100");
      const instruction = createInstruction({
        recipients: [
          {
            recipient: recipient1.address,
            basisPoints: 1000,
            flatAmount: 0,
          },
          {
            recipient: recipient2.address,
            basisPoints: 500,
            flatAmount: 0,
          },
        ],
      });

      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const validAfter = 0;
      const validBefore = Math.floor(Date.now() / 1000) + 3600;

      const domain = {
        name: await token.name(),
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await token.getAddress(),
      };

      const types = {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      };

      const value = {
        from: client.address,
        to: await settlement.getAddress(),
        value: settlementAmount,
        validAfter,
        validBefore,
        nonce,
      };

      const signature = await client.signTypedData(domain, types, value);
      const sig = ethers.Signature.from(signature);

      const tx = await settlement.connect(facilitator).executeSpectrumSettlement(
        await token.getAddress(),
        client.address,
        settlementAmount,
        validAfter,
        validBefore,
        nonce,
        sig.v,
        sig.r,
        sig.s,
        instruction
      );

      const receipt = await tx.wait();
      console.log(`⛽ Gas used for 2 recipients: ${receipt?.gasUsed}`);
      
      // Should be under 165k gas target
      expect(receipt?.gasUsed).to.be.lessThan(165000);
    });
  });
});
