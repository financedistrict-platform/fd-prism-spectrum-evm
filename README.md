# Spectrum Settlement Protocol

[![Solidity](https://img.shields.io/badge/Solidity-^0.8.20-blue.svg)](https://solidity.readthedocs.io)
[![Hardhat](https://img.shields.io/badge/Built%20with-Hardhat-f6831a.svg)](https://hardhat.org/)
[![OpenZeppelin](https://img.shields.io/badge/Uses-OpenZeppelin-4e5ee4.svg)](https://openzeppelin.com/)
[![License: Proprietary](https://img.shields.io/badge/License-All%20Rights%20Reserved-red.svg)](LICENSE)

> **Deterministic, non-custodial token distribution protocol built on EIP-3009**

Stateless settlement system enabling gasless payments with automatic multi-recipient distribution. Same inputs → identical outputs, every time.

## Philosophy

Traditional payment systems require complex on-chain state management, making multi-recipient distributions expensive and inflexible. Spectrum takes a different approach: all business logic lives off-chain, with the contract serving purely as a deterministic execution engine.

This architecture enables:
- **Zero-cost configuration changes** — Update fees, add recipients, modify logic without gas
- **Unlimited flexibility** — Support any distribution model your business requires
- **Predictable outcomes** — Same instruction always produces identical results
- **True non-custody** — Funds flow through atomically with zero contract balance retention

## Features

- **Stateless Architecture** — All business logic (clients, fees, packages) managed off-chain
- **Atomic Settlement** — Single-transaction distribution using EIP-3009 authorization
- **Flexible Fee Types** — Percentage (basis points) or flat fees per recipient
- **Multi-Recipient Distribution** — Split funds to unlimited recipients in one transaction
- **Deterministic Execution** — Same inputs → identical outputs, guaranteed
- **Non-Custodial Design** — Zero contract balance after settlement
- **Access Control** — Two-tier RBAC with facilitator whitelist
- **Full Transparency** — Comprehensive event logging for audit trails

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              Stateless Settlement Flow                      │
├─────────────────────────────────────────────────────────────┤
│  Client Signs EIP-3009 Authorization (off-chain)           │
│       ↓                                                     │
│  Facilitator Calls executeSpectrumSettlement()             │
│       ↓                                                     │
│  SpectrumSettlement (Deterministic Distribution)           │
│   ├── Call token.receiveWithAuthorization()                │
│   ├── Validate Instruction (stateless)                     │
│   ├── Validate Recipients (format only)                    │
│   ├── Distribute to Recipients (% or flat)                 │
│   ├── Transfer Remainder to Client                         │
│   └── Emit SpectrumSettlementExecuted                      │
└─────────────────────────────────────────────────────────────┘

Principles: Off-chain business logic • On-chain validation & execution
            Same input → Same output • Zero balance guarantee
```

## Quick Start

```bash
# Clone and install
git clone https://github.com/financedistrict-platform/fd-prism-spectrum-evm.git
cd fd-prism-spectrum-evm
npm install

# Configure environment
cp .env.example .env
# Add your RPC URLs and API keys

# Build and test
npm run compile
npm test

# Run local node (optional)
npm run node
```

## Usage

### Basic Example

```typescript
import { SpectrumSettlement } from "./typechain-types";

// Deploy contract
const settlement = await ethers.deployContract("SpectrumSettlement");

// Authorize facilitator
await settlement.addFacilitator(facilitatorAddress);

// Construct settlement instruction (typically done by your backend)
const instruction = {
  clientWalletAddress: clientAddress,
  clientId: "client-123",
  packageTier: 1,
  attestationHash: "settlement-uuid",
  recipients: [
    { recipientAddress: platformFeeAddress, basisPoints: 300, flatAmount: 0 }, // 3% fee
    { recipientAddress: affiliateAddress, basisPoints: 0, flatAmount: parseUnits("10", 6) }, // $10 flat
  ],
};

// Execute settlement with EIP-3009 authorization
await settlement
  .connect(facilitator)
  .executeSpectrumSettlement(
    tokenAddress,
    fromAddress,
    totalAmount,
    validAfter,
    validBefore,
    nonce,
    v,
    r,
    s,
    instruction
  );
```

### Fee Configuration

**Percentage Fees:**
- Use `basisPoints` field (1-10000 representing 0.01%-100%)
- Example: `basisPoints: 500` = 5% of total

**Flat Fees:**
- Use `flatAmount` field in token's smallest unit
- Example: `flatAmount: 1000000` = 1 USDC (6 decimals)

**Important:** Each recipient must use exactly one fee type (either percentage OR flat, not both).

## Testing

Comprehensive test suite with 41 tests covering:
- Deployment and access control
- Facilitator management
- Instruction validation
- Settlement execution
- Security scenarios
- Gas optimization

```bash
npm test                # Run all tests
npm run test:gas        # With gas reporting
npm run test:coverage   # Generate coverage report
```

## API Reference

### Admin Functions

```solidity
function addFacilitator(address facilitator) external onlyRole(FACILITATOR_MANAGER_ROLE)
function removeFacilitator(address facilitator) external onlyRole(FACILITATOR_MANAGER_ROLE)
```

### Settlement Functions

```solidity
// RSV signature variant
function executeSpectrumSettlement(
    address token,
    address from,
    uint256 value,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce,
    uint8 v,
    bytes32 r,
    bytes32 s,
    SettlementInstruction calldata instruction
) external onlyFacilitator nonReentrant returns (uint256, uint256)

// Bytes signature variant (supports EIP-1271)
function executeSpectrumSettlementV2(
    address token,
    address from,
    uint256 value,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce,
    bytes calldata signature,
    SettlementInstruction calldata instruction
) external onlyFacilitator nonReentrant returns (uint256, uint256)
```

### View Functions

```solidity
function isFacilitatorWhitelisted(address) external view returns (bool)
function validateInstruction(SettlementInstruction calldata) external pure
function validateRecipients(FeeRecipient[] calldata) external pure
function simulateDistribution(uint256, FeeRecipient[] calldata) external pure returns (uint256[], uint256)
```

## Development

```bash
npm run compile       # Compile contracts
npm run lint          # Lint TypeScript
npm run lint:sol      # Lint Solidity
npm run format        # Format all code
npm run size          # Analyze contract sizes
npm run clean         # Clean artifacts
```

## Security

This protocol implements multiple security layers:

- **Non-Reentrancy** — OpenZeppelin ReentrancyGuard on all state-changing functions
- **Access Control** — Two-tier RBAC with role-based permissions
- **Input Validation** — Comprehensive stateless validation of all instructions
- **Overflow Protection** — Solidity 0.8+ checked arithmetic
- **Event Auditing** — Complete event trail for all operations
- **Deterministic Execution** — Same inputs always produce identical outputs
- **Zero-Balance Guarantee** — Contract never retains funds after settlement

### Best Practices

For production deployments:
- Use multi-signature wallets for `DEFAULT_ADMIN_ROLE`
- Validate settlement instructions off-chain before execution
- Monitor settlement events for anomalies
- Conduct regular security audits
- Test thoroughly on testnets before mainnet deployment

## Supported Networks

The contract is network-agnostic and can be deployed to any EVM-compatible chain:

- Ethereum and L2s (Arbitrum, Base, Optimism)
- BSC (BNB Smart Chain)
- Polygon
- Avalanche C-Chain
- Other EVM chains

Contract size: **6.161 KiB** (fits within standard deployment limits)

## License

**All Rights Reserved**

This code is made available for transparency, auditing, and educational purposes only.

No permission is granted to copy, modify, distribute, or use this software for any purpose without explicit written permission from 1st Digital.

See the [LICENSE](LICENSE) file for full details.

## Acknowledgments

Built with:
- [Hardhat](https://hardhat.org/) - Ethereum development environment
- [OpenZeppelin](https://openzeppelin.com/) - Secure smart contract library
- [TypeChain](https://github.com/dethcrypto/TypeChain) - TypeScript bindings for Ethereum smart contracts
