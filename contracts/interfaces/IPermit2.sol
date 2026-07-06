// SPDX-License-Identifier: LicenseRef-Proprietary
pragma solidity ^0.8.20;

/**
 * @title IPermit2 (AllowanceTransfer subset)
 * @notice Minimal interface for the canonical Permit2 singleton's AllowanceTransfer surface used by
 *         the Spectrum recurring-subscription settlement path.
 * @dev Canonical Permit2 singleton (identical bytecode on ETH mainnet, ETH Sepolia, BSC, BSC Testnet):
 *      0x000000000022D473030F116dDEE9F6B43aC78BA3
 *
 *      Only the three functions Spectrum calls are declared (subset of Uniswap's IAllowanceTransfer):
 *      - permit()       : arms an allowance from an EOA-signed PermitSingle (bumps the packed nonce).
 *      - transferFrom() : pulls tokens against an armed allowance (NO signature; does NOT touch nonce).
 *      - allowance()    : reads the packed (amount, expiration, nonce) tuple.
 *
 *      Nonce semantics (the on-chain fact behind the recurring-pull / anti-double-charge invariant):
 *      permit() consumes+bumps the packed-allowance nonce (replay guard on ARM); transferFrom() only
 *      decrements the amount and leaves the nonce untouched, so a second in-cap pull needs no new
 *      signature. Idempotency therefore lives off-chain (facilitator + Prism), never on-chain here.
 */
interface IPermit2 {
    /**
     * @notice The per-token allowance details a subscriber signs when arming a mandate.
     * @param token FDUSD (or other ERC20) token being authorized.
     * @param amount Maximum spendable allowance (the cap = cycleAmount * cycles), fits uint160.
     * @param expiration Timestamp after which the allowance is no longer usable (uint48).
     * @param nonce Packed-allowance nonce; must equal the current stored nonce, then permit() bumps it.
     */
    struct PermitDetails {
        address token;
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    /**
     * @notice A single-token permit the subscriber (owner) signs off-chain via EIP-712.
     * @param details The token/amount/expiration/nonce being authorized.
     * @param spender The address allowed to pull — MUST be the Spectrum settlement contract.
     * @param sigDeadline Deadline after which the signature itself is no longer valid.
     */
    struct PermitSingle {
        PermitDetails details;
        address spender;
        uint256 sigDeadline;
    }

    /**
     * @notice Arm (or re-arm) an allowance from an owner-signed PermitSingle.
     * @dev Verifies the EIP-712 signature against `owner` and bumps the packed nonce (replay guard).
     * @param owner The token holder (subscriber) who signed the PermitSingle.
     * @param permitSingle The permit payload the owner signed.
     * @param signature 65-byte ECDSA signature (EOA owner — MVP path) or EIP-1271 bytes.
     */
    function permit(address owner, PermitSingle memory permitSingle, bytes calldata signature) external;

    /**
     * @notice Pull tokens from `from` to `to` against a previously-armed allowance.
     * @dev Caller (msg.sender) must be the armed spender. NO signature required; does NOT touch the
     *      nonce. Decrements the allowance amount unless it is the infinite-allowance sentinel.
     * @param from Token holder the allowance was armed by.
     * @param to Recipient of the pulled tokens (the settlement contract).
     * @param amount Amount to pull (uint160).
     * @param token Token to pull.
     */
    function transferFrom(address from, address to, uint160 amount, address token) external;

    /**
     * @notice Read the current packed allowance for (user, token, spender).
     * @param user Token holder (subscriber).
     * @param token Authorized token.
     * @param spender The armed spender (the settlement contract).
     * @return amount Remaining spendable allowance.
     * @return expiration Allowance expiry timestamp.
     * @return nonce Current packed-allowance nonce.
     */
    function allowance(
        address user,
        address token,
        address spender
    ) external view returns (uint160 amount, uint48 expiration, uint48 nonce);
}
