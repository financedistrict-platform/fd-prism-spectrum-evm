// SPDX-License-Identifier: LicenseRef-Proprietary
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {IERC3009Bytes} from "./interfaces/IERC3009Bytes.sol";
import {IPermit2} from "./interfaces/IPermit2.sol";

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

    /// @notice Upper bound of a Permit2 uint160 pull amount — a settlement `value` must fit this.
    uint256 private constant MAX_UINT160 = type(uint160).max;

    /// @notice Canonical Permit2 singleton (identical bytecode on ETH mainnet/Sepolia + BSC mainnet/Testnet)
    address public constant PERMIT2_SINGLETON = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // ============ State Variables ============

    /// @notice Whitelist of trusted facilitators who can execute settlements
    mapping(address => bool) public facilitators;

    /**
     * @notice Permit2 singleton this contract pulls recurring subscription funds through.
     * @dev Set once at construction. Production deploys pass address(0) to bind the canonical
     *      singleton; tests inject a mock. Immutable => no admin can repoint the pull source.
     */
    IPermit2 public immutable PERMIT2;

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

    /**
     * @notice A Permit2 subscription mandate was armed (or re-armed) via this contract.
     * @param owner Subscriber (token holder) who signed the PermitSingle.
     * @param token Token authorized for recurring pulls.
     * @param amount Allowance cap armed (typically cycleAmount * cycles).
     * @param expiration Allowance expiry timestamp.
     */
    event Permit2MandateRegistered(
        address indexed owner,
        address indexed token,
        uint160 amount,
        uint48 expiration
    );

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

    // Permit2 path errors
    error MandateSpenderMismatch(address spender);
    error ValueExceedsCycleAmount(uint256 value, uint256 cycleAmount);
    error ValueExceedsUint160(uint256 value);

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
     * @notice Initialize the contract with an initial admin and the Permit2 singleton
     * @param initialAdmin Address to grant DEFAULT_ADMIN_ROLE and FACILITATOR_MANAGER_ROLE
     * @param permit2 Permit2 singleton address for the recurring-subscription pull path
     * @dev If initialAdmin is address(0), grants roles to msg.sender (backward compatibility).
     *      If permit2 is address(0), binds the canonical Permit2 singleton (production default);
     *      tests inject a mock address. PERMIT2 is immutable — the pull source can never be repointed.
     */
    constructor(address initialAdmin, address permit2) {
        address admin = initialAdmin == address(0) ? msg.sender : initialAdmin;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FACILITATOR_MANAGER_ROLE, admin);

        PERMIT2 = IPermit2(permit2 == address(0) ? PERMIT2_SINGLETON : permit2);
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
        _validateInstruction(instruction);

        IERC3009(token).receiveWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, v, r, s);

        (distributedAmount, remainingAmount) = _distributeSettlement(
            token,
            instruction.clientWalletAddress,
            value,
            instruction.recipients
        );

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
        _validateInstruction(instruction);

        IERC3009Bytes(token).receiveWithAuthorization(
            from,
            address(this),
            value,
            validAfter,
            validBefore,
            nonce,
            signature
        );

        (distributedAmount, remainingAmount) = _distributeSettlement(
            token,
            instruction.clientWalletAddress,
            value,
            instruction.recipients
        );

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

    // ============ Permit2 Settlement Functions (recurring subscriptions) ============

    /**
     * @notice Arm (or re-arm) a Permit2 subscription mandate for a subscriber.
     * @dev First-charge / re-arm only. Forwards the subscriber's EOA-signed PermitSingle to
     *      Permit2.permit(), which verifies the ECDSA signature and bumps the packed nonce (replay
     *      guard on ARM). The recurring pull (executePermit2Settlement) needs no further signature.
     *
     *      EOA-only for MVP: Permit2 verifies the owner's ECDSA signature internally, so no owner-type
     *      branching is needed here (a smart-account/EIP-1271 owner is a Permit2-internal concern).
     * @param owner Subscriber (token holder) who signed the PermitSingle.
     * @param permitSingle The permit payload the owner signed (spender MUST be this contract).
     * @param signature 65-byte ECDSA signature over the PermitSingle.
     */
    function registerPermit2Mandate(
        address owner,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) external onlyFacilitator nonReentrant {
        // The armed spender must be this contract, else it could arm an allowance for someone else.
        if (permitSingle.spender != address(this)) {
            revert MandateSpenderMismatch(permitSingle.spender);
        }

        PERMIT2.permit(owner, permitSingle, signature);

        emit Permit2MandateRegistered(
            owner,
            permitSingle.details.token,
            permitSingle.details.amount,
            permitSingle.details.expiration
        );
    }

    /**
     * @notice Execute one recurring-subscription pull via Permit2, then distribute per instruction.
     * @dev Pulls `value` from the subscriber into this contract via Permit2.transferFrom (no signature;
     *      does NOT touch the packed nonce), then REUSES the previously-audited _distributeSettlement.
     *
     *      transferFrom has NO on-chain replay guard — the idempotency invariant (no double-charge)
     *      lives off-chain in the facilitator + Prism, NOT here. This function is intentionally
     *      re-callable within the armed allowance; per-cycle uniqueness is a Prism concern.
     *
     *      The `value <= cycleAmount` check is a per-pull sanity bound: a single pull cannot exceed the
     *      agreed cycle amount. Both `value` and `cycleAmount` are facilitator-supplied, so this is not
     *      a cryptographic consent proof — the facilitator is trusted for instruction correctness (same
     *      trust model as the EIP-3009 path). The sole hard on-chain bound against a fully-compromised
     *      facilitator is the subscriber-signed Permit2 allowance cap. attestationHash is emitted for
     *      off-chain reconciliation (detection), not verified on-chain (Permit2 pulls carry no
     *      subscriber signature).
     * @param token Token to pull and distribute.
     * @param from Subscriber (token holder) the allowance was armed by.
     * @param value Amount to pull this cycle (must be <= cycleAmount and fit uint160).
     * @param cycleAmount The agreed per-cycle amount cap (per-pull ceiling).
     * @param instruction Complete settlement instruction (residual destination + fee recipients).
     * @return distributedAmount Total fees distributed to recipients.
     * @return remainingAmount Residual transferred to clientWalletAddress.
     */
    function executePermit2Settlement(
        address token,
        address from,
        uint256 value,
        uint256 cycleAmount,
        SettlementInstruction calldata instruction
    ) external onlyFacilitator nonReentrant returns (uint256 distributedAmount, uint256 remainingAmount) {
        // Per-pull cap: one pull cannot exceed the agreed cycle amount (contains over-pull within cap).
        if (value > cycleAmount) {
            revert ValueExceedsCycleAmount(value, cycleAmount);
        }
        // Permit2.transferFrom takes a uint160 amount — reject values that would truncate.
        if (value > MAX_UINT160) {
            revert ValueExceedsUint160(value);
        }

        _validateInstruction(instruction);

        // No signature: transferFrom pulls against the armed allowance and leaves the packed nonce intact.
        PERMIT2.transferFrom(from, address(this), uint160(value), token);

        (distributedAmount, remainingAmount) = _distributeSettlement(
            token,
            instruction.clientWalletAddress,
            value,
            instruction.recipients
        );

        // attestationHash carried for off-chain reconciliation (Permit2 pulls carry no on-chain proof).
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

        for (uint256 i = 0; i < recipients.length; ++i) {
            RecipientConfig calldata config = recipients[i];

            uint256 feeAmount;

            if (config.basisPoints > 0) {
                feeAmount = (totalAmount * config.basisPoints) / MAX_BASIS_POINTS;
            } else if (config.flatAmount > 0) {
                feeAmount = config.flatAmount;
            }
            // else: both zero — skipped; _validateRecipients enforces exactly one fee type.

            if (feeAmount > 0) {
                uint256 newDistributed = distributedAmount + feeAmount;
                if (newDistributed > totalAmount) {
                    revert DistributionOverflow(newDistributed, totalAmount);
                }
                distributedAmount = newDistributed;
                tokenContract.safeTransfer(config.recipient, feeAmount);
            }
        }

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
        if (instruction.clientWalletAddress == address(0)) {
            revert InvalidDestination(instruction.clientWalletAddress);
        }

        _validateStringFields(instruction.clientId, instruction.attestationHash);

        if (instruction.packageTier == 0 || instruction.packageTier > 99) {
            revert InvalidTier(instruction.packageTier);
        }

        if (instruction.recipients.length == 0) {
            revert EmptyRecipients();
        }
        if (instruction.recipients.length > MAX_RECIPIENTS) {
            revert TooManyRecipients(instruction.recipients.length);
        }

        (uint256 totalBasisPoints, ) = _validateRecipients(instruction.recipients);

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
        // Structural check only — Web2 owns client authorization, this contract never looks a client up.
        if (bytes(clientId).length == 0) {
            revert EmptyClientIdentifier();
        }
        if (bytes(clientId).length > 64) {
            revert ClientIdentifierTooLong();
        }

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

            if (config.recipient == address(0)) {
                revert InvalidDestination(config.recipient);
            }

            // Exactly one fee type must be set: hasBasisPoints == hasFlatAmount means both or neither.
            bool hasBasisPoints = config.basisPoints > 0;
            bool hasFlatAmount = config.flatAmount > 0;

            if (hasBasisPoints == hasFlatAmount) {
                revert InvalidFeeConfig(config.recipient);
            }

            if (hasBasisPoints) {
                totalBasisPoints += config.basisPoints;
            } else {
                totalFlatFees += config.flatAmount;
            }

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
