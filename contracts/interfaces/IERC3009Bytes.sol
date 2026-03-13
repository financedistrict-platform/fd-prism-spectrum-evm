// SPDX-License-Identifier: LicenseRef-Proprietary
pragma solidity ^0.8.19;

/**
 * @title IERC3009Bytes (Bytes signature variant)
 * @notice Minimal interface for EIP-3009 style authorization that packs signature into a single bytes parameter.
 * @dev Supports EOA (65-byte) and smart contract (EIP-1271) signatures.
 */
interface IERC3009Bytes {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    /**
     * @notice Transfer tokens with authorization from a signed approval
     * @dev Executes transfer using packed signature bytes
     * @param from Token holder address
     * @param to Recipient address
     * @param value Amount to transfer
     * @param validAfter Timestamp after which authorization is valid
     * @param validBefore Timestamp before which authorization is valid
     * @param nonce Unique authorization nonce
     * @param signature Packed signature bytes
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}
