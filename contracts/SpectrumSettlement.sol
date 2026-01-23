// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {IERC3009Bytes} from "./interfaces/IERC3009Bytes.sol";

/**
 * @title SpectrumSettlement
 * @author Prism Spectrum Team
 * @notice Simplified settlement contract for deterministic, non-custodial token distribution
 * @dev Ground-up rebuild that shifts all client/package management to Web2 services.
 *      Maintains only facilitator whitelist on-chain. All settlement instructions passed
 *      as calldata per-transaction with no on-chain storage lookups.
 *
 * Architecture:
 * - Zero on-chain state beyond facilitator whitelist
 * - Instruction-based settlement (no package/client storage)
 * - Supports both percentage and flat fee recipients
 * - Dual EIP-3009 variants (RSV + bytes signatures)
 * - Deterministic distribution with overflow protection
 *
 * Security Model:
 * - Facilitators fully trusted for instruction correctness
 * - Web2 service validates client authorization
 * - Contract validates instruction structure only
 * - Reentrancy protection on settlement functions
 * - 2-tier RBAC (DEFAULT_ADMIN + ADMIN roles only)
 */

contract SpectrumSettlement is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Structs ============

    /**
     * @notice Individual fee recipient configuration
     * @dev Supports both percentage-based and flat fee amounts
     * @param recipient Fee recipient address
     * @param basisPoints Percentage in basis points (0-10000, 0 if using flat fee)
     * @param flatAmount Flat fee amount (0 if using percentage)
     */
    struct RecipientConfig {
        address recipient;
        uint16 basisPoints;
        uint256 flatAmount;
    }

    /**
     * @notice Comprehensive settlement instruction (replaces on-chain package lookup)
     * @dev Passed as calldata per transaction - no on-chain storage
     *      Struct field ordering optimized for calldata (not storage) - packing warning can be ignored
     * @param clientWalletAddress Destination wallet for residual funds after fee distribution
     * @param clientId Human-readable client identifier (e.g., UUID or business name)
     * @param packageTier Fee tier level (1-99 range for internal categorization)
     * @param attestationHash Unique settlement correlation ID for audit trail
     * @param recipients Array of fee recipient configurations (deterministic distribution)
     */
    struct SettlementInstruction {
        address clientWalletAddress; // 20 bytes (calldata struct, not stored)
        uint8 packageTier; // 1 byte - packed with address for clarity
        string clientId; // dynamic
        string attestationHash; // dynamic
        RecipientConfig[] recipients; // dynamic array
    }

    // ============ Constants ============

    /// @notice Maximum basis points (100%)
    uint256 public constant MAX_BASIS_POINTS = 10000;

    /// @notice Maximum number of fee recipients per settlement
    uint256 public constant MAX_RECIPIENTS = 25;

    /// @notice Admin role for facilitator management
    bytes32 public constant FACILITATOR_MANAGER_ROLE = keccak256("FACILITATOR_MANAGER_ROLE");

    // ============ State Variables ============

    /// @notice Whitelist of trusted facilitators who can execute settlements
    mapping(address => bool) public facilitators;

    // ============ Events ============

    /**
     * @notice Settlement execution event (enhanced with new terminology)
     * @param token ERC20 token address
     * @param from Authorization signer (token holder)
     * @param clientWalletAddress Residual funds destination (client wallet)
     * @param client Client identifier (was provider address)
     * @param packageTier Fee tier applied
     * @param totalAmount Total settlement amount
     * @param distributedAmount Sum of fee transfers
     * @param remainingAmount Residual to clientWalletAddress
     * @param attestationHash Settlement correlation ID
     */
    event SpectrumSettlementExecuted(
        address indexed token,
        address indexed from,
        address indexed clientWalletAddress,
        string client,
        uint8 packageTier,
        uint256 totalAmount,
        uint256 distributedAmount,
        uint256 remainingAmount,
        string attestationHash
    ); /**
     * @notice Facilitator added to whitelist
     * @param facilitator Address added
     * @param addedBy Admin who performed the action
     */
    event FacilitatorAdded(address indexed facilitator, address indexed addedBy);

    /**
     * @notice Facilitator removed from whitelist
     * @param facilitator Address removed
     * @param removedBy Admin who performed the action
     */
    event FacilitatorRemoved(address indexed facilitator, address indexed removedBy);

    // ============ Custom Errors ============

    error InvalidDestination(address destination);
    error EmptyClientIdentifier();
    error InvalidTier(uint8 tier);
    error EmptyAttestationHash();
    error ClientIdentifierTooLong();
    error AttestationHashTooLong();
    error InvalidFeeConfig(address recipient);
    error DuplicateRecipient(address recipient);
    error EmptyRecipients();
    error TooManyRecipients(uint256 count);
    error FeesExceed100Percent(uint256 totalBasisPoints);
    error DistributionOverflow(uint256 distributed, uint256 total);
    error NotFacilitator(address caller);
    error FacilitatorAlreadyExists(address facilitator);
    error FacilitatorNotFound(address facilitator);
    error ZeroAddress();

    // ============ Modifiers ============

    /**
     * @notice Restricts function access to whitelisted facilitators
     */
    modifier onlyFacilitator() {
        if (!facilitators[msg.sender]) {
            revert NotFacilitator(msg.sender);
        }
        _;
    }

    // ============ Constructor ============

    /**
     * @notice Initialize the contract with an initial admin
     * @param initialAdmin Address to grant DEFAULT_ADMIN_ROLE and FACILITATOR_MANAGER_ROLE
     * @dev If initialAdmin is address(0), grants roles to msg.sender (for backward compatibility)
     */
    constructor(address initialAdmin) {
        address admin = initialAdmin == address(0) ? msg.sender : initialAdmin;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FACILITATOR_MANAGER_ROLE, admin);
    }

    // ============ Facilitator Management ============

    /**
     * @notice Add a facilitator to the whitelist
     * @dev Only callable by FACILITATOR_MANAGER_ROLE
     * @param facilitator Address to add
     */
    function addFacilitator(address facilitator) external onlyRole(FACILITATOR_MANAGER_ROLE) {
        if (facilitator == address(0)) revert ZeroAddress();
        if (facilitators[facilitator]) revert FacilitatorAlreadyExists(facilitator);

        facilitators[facilitator] = true;
        emit FacilitatorAdded(facilitator, msg.sender);
    }

    /**
     * @notice Remove a facilitator from the whitelist
     * @dev Only callable by FACILITATOR_MANAGER_ROLE
     * @param facilitator Address to remove
     */
    function removeFacilitator(address facilitator) external onlyRole(FACILITATOR_MANAGER_ROLE) {
        if (!facilitators[facilitator]) revert FacilitatorNotFound(facilitator);

        facilitators[facilitator] = false;
        emit FacilitatorRemoved(facilitator, msg.sender);
    }

    // ============ Settlement Functions ============

    /**
     * @notice Execute EIP-3009 settlement with RSV signature
     * @dev Executes token transfer with authorization where caller must be recipient
     * @param token ERC-3009 compatible token
     * @param from Token holder authorizing transfer
     * @param value Total settlement amount
     * @param validAfter Authorization valid after timestamp
     * @param validBefore Authorization valid before timestamp
     * @param nonce EIP-3009 authorization nonce
     * @param v Signature component
     * @param r Signature component
     * @param s Signature component
     * @param instruction Complete settlement instruction
     * @return distributedAmount Total fees distributed to recipients
     * @return remainingAmount Residual transferred to clientWalletAddress
     */
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
    ) external onlyFacilitator nonReentrant returns (uint256 distributedAmount, uint256 remainingAmount) {
        // Validate instruction structure
        _validateInstruction(instruction);

        // Execute token transfer with authorization
        IERC3009(token).receiveWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, v, r, s);

        // Distribute fees and residual
        (distributedAmount, remainingAmount) = _distributeSettlement(
            token,
            instruction.clientWalletAddress,
            value,
            instruction.recipients
        );

        // Emit settlement event
        emit SpectrumSettlementExecuted(
            token,
            from,
            instruction.clientWalletAddress,
            instruction.clientId,
            instruction.packageTier,
            value,
            distributedAmount,
            remainingAmount,
            instruction.attestationHash
        );
    }

    /**
     * @notice Execute EIP-3009 settlement with bytes signature (supports EIP-1271)
     * @dev Uses receiveWithAuthorization
     * @param token ERC-3009Bytes compatible token
     * @param from Token holder authorizing transfer
     * @param value Total settlement amount
     * @param validAfter Authorization valid after timestamp
     * @param validBefore Authorization valid before timestamp
     * @param nonce EIP-3009 authorization nonce
     * @param signature Packed signature (65-byte EOA or arbitrary EIP-1271)
     * @param instruction Complete settlement instruction
     * @return distributedAmount Total fees distributed to recipients
     * @return remainingAmount Residual transferred to clientWalletAddress
     */
    function executeSpectrumSettlementV2(
        address token,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature,
        SettlementInstruction calldata instruction
    ) external onlyFacilitator nonReentrant returns (uint256 distributedAmount, uint256 remainingAmount) {
        // Validate instruction structure
        _validateInstruction(instruction);

        // Execute token transfer with authorization
        IERC3009Bytes(token).receiveWithAuthorization(
            from,
            address(this),
            value,
            validAfter,
            validBefore,
            nonce,
            signature
        );

        // Distribute fees and residual
        (distributedAmount, remainingAmount) = _distributeSettlement(
            token,
            instruction.clientWalletAddress,
            value,
            instruction.recipients
        );

        // Emit settlement event
        emit SpectrumSettlementExecuted(
            token,
            from,
            instruction.clientWalletAddress,
            instruction.clientId,
            instruction.packageTier,
            value,
            distributedAmount,
            remainingAmount,
            instruction.attestationHash
        );

        return (distributedAmount, remainingAmount);
    }

    // ============ View Functions ============

    /**
     * @notice Check if account has FACILITATOR_MANAGER_ROLE
     * @param account Address to check
     * @return True if account has FACILITATOR_MANAGER_ROLE
     */
    function isFacilitatorManager(address account) external view returns (bool) {
        return hasRole(FACILITATOR_MANAGER_ROLE, account);
    }

    /**
     * @notice Check if account has DEFAULT_ADMIN_ROLE
     * @param account Address to check
     * @return True if account has DEFAULT_ADMIN_ROLE
     */
    function isSuperAdmin(address account) external view returns (bool) {
        return hasRole(DEFAULT_ADMIN_ROLE, account);
    }

    /**
     * @notice Check if address is a whitelisted facilitator
     * @param facilitator Address to check
     * @return True if facilitator is whitelisted
     */
    function isFacilitatorWhitelisted(address facilitator) external view returns (bool) {
        return facilitators[facilitator];
    }

    /**
     * @notice Simulate distribution for given instruction (gas estimation helper)
     * @dev Pure function for off-chain simulation - does not modify state
     * @param totalAmount Total settlement amount
     * @param recipients Recipient configurations
     * @return feeAmounts Array of fee amounts per recipient
     * @return remainingAmount Residual for clientWalletAddress
     */
    function simulateDistribution(
        uint256 totalAmount,
        RecipientConfig[] calldata recipients
    ) external pure returns (uint256[] memory feeAmounts, uint256 remainingAmount) {
        feeAmounts = new uint256[](recipients.length);
        uint256 distributedAmount;

        for (uint256 i = 0; i < recipients.length; ++i) {
            RecipientConfig calldata config = recipients[i];

            uint256 feeAmount;

            // Calculate fee based on type (percentage or flat)
            if (config.basisPoints > 0) {
                feeAmount = (totalAmount * config.basisPoints) / MAX_BASIS_POINTS;
            } else if (config.flatAmount > 0) {
                feeAmount = config.flatAmount;
            }

            feeAmounts[i] = feeAmount;
            distributedAmount += feeAmount;
        }

        remainingAmount = totalAmount - distributedAmount;
    }

    // ============ Internal Functions ============

    /**
     * @notice Distribute settlement fees per instruction
     * @dev Iterates recipients, calculates fees (percentage or flat), transfers atomically
     * @param token ERC20 token address
     * @param clientWalletAddress Destination for residual funds
     * @param totalAmount Total settlement amount
     * @param recipients Recipient configurations from instruction
     * @return distributedAmount Total fees distributed
     * @return remainingAmount Residual transferred to clientWalletAddress
     */
    function _distributeSettlement(
        address token,
        address clientWalletAddress,
        uint256 totalAmount,
        RecipientConfig[] calldata recipients
    ) internal returns (uint256 distributedAmount, uint256 remainingAmount) {
        IERC20 tokenContract = IERC20(token);

        // Iterate recipients, calculate fees, transfer atomically
        for (uint256 i = 0; i < recipients.length; ++i) {
            RecipientConfig calldata config = recipients[i];

            uint256 feeAmount;

            // Calculate fee based on type (percentage or flat)
            if (config.basisPoints > 0) {
                // Percentage-based fee calculation
                feeAmount = (totalAmount * config.basisPoints) / MAX_BASIS_POINTS;
            } else if (config.flatAmount > 0) {
                // Flat fee amount
                feeAmount = config.flatAmount;
            }
            // else: both zero, skip (validation should have caught this)

            if (feeAmount > 0) {
                uint256 newDistributed = distributedAmount + feeAmount;
                if (newDistributed > totalAmount) {
                    revert DistributionOverflow(newDistributed, totalAmount);
                }
                distributedAmount = newDistributed;
                tokenContract.safeTransfer(config.recipient, feeAmount);
            }
        }

        // Transfer remaining to clientWalletAddress
        remainingAmount = totalAmount - distributedAmount;
        if (remainingAmount > 0) {
            tokenContract.safeTransfer(clientWalletAddress, remainingAmount);
        }
    }

    /**
     * @notice Validate settlement instruction integrity
     * @dev Reverts if instruction is invalid (NO client lookup - Web2 validates authorization)
     * @param instruction Settlement instruction to validate
     */
    function _validateInstruction(SettlementInstruction calldata instruction) internal pure {
        // Destination validation
        if (instruction.clientWalletAddress == address(0)) {
            revert InvalidDestination(instruction.clientWalletAddress);
        }

        // Client and attestation validation (extracted to reduce complexity)
        _validateStringFields(instruction.clientId, instruction.attestationHash);

        // PackageTier validation (1-99 range)
        if (instruction.packageTier == 0 || instruction.packageTier > 99) {
            revert InvalidTier(instruction.packageTier);
        }

        // Recipients validation
        if (instruction.recipients.length == 0) {
            revert EmptyRecipients();
        }
        if (instruction.recipients.length > MAX_RECIPIENTS) {
            revert TooManyRecipients(instruction.recipients.length);
        }

        // Validate recipients array (no duplicates, valid fee configs)
        (uint256 totalBasisPoints, ) = _validateRecipients(instruction.recipients);

        // Validate percentage fees don't exceed 100%
        if (totalBasisPoints > MAX_BASIS_POINTS) {
            revert FeesExceed100Percent(totalBasisPoints);
        }
    }

    /**
     * @notice Validate clientId and attestationHash string fields
     * @dev Helper function to reduce cyclomatic complexity of _validateInstruction
     * @param clientId Client identifier string
     * @param attestationHash Settlement correlation ID string
     */
    function _validateStringFields(string calldata clientId, string calldata attestationHash) internal pure {
        // Client validation (basic format check only - Web2 handles authorization)
        if (bytes(clientId).length == 0) {
            revert EmptyClientIdentifier();
        }
        if (bytes(clientId).length > 64) {
            revert ClientIdentifierTooLong();
        }

        // Attestation validation
        if (bytes(attestationHash).length == 0) {
            revert EmptyAttestationHash();
        }
        if (bytes(attestationHash).length > 128) {
            revert AttestationHashTooLong();
        }
    }

    /**
     * @notice Validate recipients array for duplicates and fee configuration
     * @dev Checks that each recipient has exactly one fee type and no duplicates exist
     * @param recipients Array of recipient configurations
     * @return totalBasisPoints Sum of all percentage-based fees
     * @return totalFlatFees Sum of all flat fees
     */
    function _validateRecipients(
        RecipientConfig[] calldata recipients
    ) internal pure returns (uint256 totalBasisPoints, uint256 totalFlatFees) {
        for (uint256 i = 0; i < recipients.length; ++i) {
            RecipientConfig calldata config = recipients[i];

            // Check for zero address
            if (config.recipient == address(0)) {
                revert InvalidDestination(config.recipient);
            }

            // Validate exactly one fee type is set (XOR logic)
            bool hasBasisPoints = config.basisPoints > 0;
            bool hasFlatAmount = config.flatAmount > 0;

            if (hasBasisPoints == hasFlatAmount) {
                // Both true or both false - invalid
                revert InvalidFeeConfig(config.recipient);
            }

            // Accumulate totals
            if (hasBasisPoints) {
                totalBasisPoints += config.basisPoints;
            } else {
                totalFlatFees += config.flatAmount;
            }

            // Check for duplicate recipients (extracted for complexity reduction)
            _checkDuplicateRecipient(recipients, i);
        }
    }

    /**
     * @notice Check for duplicate recipient addresses
     * @dev Helper function to reduce cyclomatic complexity of _validateRecipients
     * @param recipients Array of recipient configurations
     * @param currentIndex Index of current recipient being validated
     */
    function _checkDuplicateRecipient(RecipientConfig[] calldata recipients, uint256 currentIndex) internal pure {
        address currentRecipient = recipients[currentIndex].recipient;
        for (uint256 j = currentIndex + 1; j < recipients.length; ++j) {
            if (recipients[j].recipient == currentRecipient) {
                revert DuplicateRecipient(currentRecipient);
            }
        }
    }
}
