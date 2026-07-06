// SPDX-License-Identifier: LicenseRef-Proprietary
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockPermit2
 * @notice Test double for the canonical Permit2 singleton's AllowanceTransfer surface.
 * @dev Faithfully reproduces the double-charge-relevant semantics of the real Permit2:
 *      - permit() verifies the EIP-712 signature, requires the signed nonce == stored nonce, then
 *        bumps the nonce (replay guard on ARM).
 *      - transferFrom() decrements the allowance amount but DOES NOT touch the nonce, so a second
 *        in-cap pull needs no new signature (the on-chain fact behind the anti-double-charge invariant).
 *      - expiration == 0 sentinel => expire at the current block timestamp.
 *      - amount == type(uint160).max sentinel => infinite allowance (skip the decrement).
 *
 *      EIP-712 domain matches the real Permit2 EXACTLY: name = "Permit2", NO version field, and the
 *      verifyingContract is this Permit2 (mock) address — NOT the token. The authoritative proof runs
 *      against the deployed singleton on testnet; this mock is for deterministic local unit tests only.
 */
contract MockPermit2 {
    struct PermitDetails {
        address token;
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct PermitSingle {
        PermitDetails details;
        address spender;
        uint256 sigDeadline;
    }

    struct PackedAllowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    /// @notice owner => token => spender => packed allowance
    mapping(address => mapping(address => mapping(address => PackedAllowance))) public allowances;

    // Real Permit2 domain: NO version field.
    bytes32 private constant _TYPE_HASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 private constant _HASHED_NAME = keccak256("Permit2");

    bytes32 private constant _PERMIT_DETAILS_TYPEHASH =
        keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)");
    bytes32 private constant _PERMIT_SINGLE_TYPEHASH = keccak256(
        "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
    );

    error SignatureExpired();
    error InvalidNonce();
    error InvalidSigner();
    error AllowanceExpired();
    error InsufficientAllowance();

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(_TYPE_HASH, _HASHED_NAME, block.chainid, address(this)));
    }

    function allowance(
        address user,
        address token,
        address spender
    ) external view returns (uint160 amount, uint48 expiration, uint48 nonce) {
        PackedAllowance memory a = allowances[user][token][spender];
        return (a.amount, a.expiration, a.nonce);
    }

    function permit(address owner, PermitSingle memory permitSingle, bytes calldata signature) external {
        if (block.timestamp > permitSingle.sigDeadline) revert SignatureExpired();

        bytes32 detailsHash = keccak256(
            abi.encode(
                _PERMIT_DETAILS_TYPEHASH,
                permitSingle.details.token,
                permitSingle.details.amount,
                permitSingle.details.expiration,
                permitSingle.details.nonce
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(_PERMIT_SINGLE_TYPEHASH, detailsHash, permitSingle.spender, permitSingle.sigDeadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));

        if (ECDSA.recover(digest, signature) != owner) revert InvalidSigner();

        PackedAllowance storage stored = allowances[owner][permitSingle.details.token][permitSingle.spender];
        // Replay guard: signed nonce must equal the current stored nonce, then it is bumped.
        if (permitSingle.details.nonce != stored.nonce) revert InvalidNonce();

        stored.amount = permitSingle.details.amount;
        // Real Permit2 sentinel: expiration == 0 means "expire at the current block timestamp".
        stored.expiration = permitSingle.details.expiration == 0
            ? uint48(block.timestamp)
            : permitSingle.details.expiration;
        stored.nonce = permitSingle.details.nonce + 1;
    }

    /**
     * @notice The recurring pull. NO signature, and it DOES NOT touch the nonce — this is the exact
     *         on-chain fact the anti-double-charge invariant relies on.
     */
    function transferFrom(address from, address to, uint160 amount, address token) external {
        PackedAllowance storage allowed = allowances[from][token][msg.sender];

        if (block.timestamp > allowed.expiration) revert AllowanceExpired();
        if (allowed.amount < amount) revert InsufficientAllowance();

        // Infinite-allowance sentinel skips the decrement (matches real Permit2).
        if (allowed.amount != type(uint160).max) {
            allowed.amount -= amount;
        }
        // Note: allowed.nonce is intentionally NOT modified.

        require(IERC20(token).transferFrom(from, to, amount), "erc20 transferFrom failed");
    }
}
