// SPDX-License-Identifier: LicenseRef-Proprietary
pragma solidity ^0.8.19;

/**
 * @title IERC3009 (Legacy v,r,s variant)
 * @notice Minimal interface for legacy EIP-3009 style transferWithAuthorization using v,r,s parameters.
 */
interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /**
     * @notice Transfer tokens with authorization from a signed approval
     * @param from Token holder address
     * @param to Recipient address
     * @param value Amount to transfer
     * @param validAfter Timestamp after which authorization is valid
     * @param validBefore Timestamp before which authorization is valid
     * @param nonce Unique authorization nonce
     * @param v Signature component
     * @param r Signature component
     * @param s Signature component
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
