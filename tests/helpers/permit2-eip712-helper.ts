// Permit2 AllowanceTransfer EIP-712 signing helper for the SpectrumSettlement Permit2 test suite.
// The domain-separator source is the single most error-prone part of the rail.
// AUTHORITATIVE FACTS about the real Permit2 singleton (0x000000000022D473030F116dDEE9F6B43aC78BA3),
// mirrored by MockPermit2:
//   - EIP-712 domain = { name: "Permit2", chainId, verifyingContract: PERMIT2 } — NO `version` field.
//   - The domain's verifyingContract is the Permit2 (singleton or mock) address, NOT the token.
//   - PermitSingle nonce is the packed-allowance nonce, bumped by permit(), untouched by transferFrom.
import { ethers } from "ethers";

// uint48 max — a "no expiry within the useful horizon" sentinel Permit2 callers use.
export const MAX_UINT48 = 281474976710655n; // 2**48 - 1
export const MAX_UINT160 = (1n << 160n) - 1n;

export interface PermitDetails {
  token: string;
  amount: bigint; // uint160
  expiration: number | bigint; // uint48
  nonce: number | bigint; // uint48
}

export interface PermitSingle {
  details: PermitDetails;
  spender: string;
  sigDeadline: bigint;
}

// EIP-712 types for PermitSingle exactly as the deployed Permit2 defines them.
export const PERMIT2_TYPES = {
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
  PermitSingle: [
    { name: "details", type: "PermitDetails" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
};

export function permit2Domain(chainId: number | bigint, permit2Address: string) {
  // NOTE: no `version` key — matches real Permit2. Adding one would produce a wrong digest.
  return {
    name: "Permit2",
    chainId,
    verifyingContract: permit2Address,
  };
}

/**
 * Sign a PermitSingle with an EOA (ECDSA) — the MVP owner path (G1: EOA-only).
 * Returns the 65-byte signature Permit2.permit() expects.
 */
export async function signPermitSingle(
  signer: ethers.Signer,
  chainId: number | bigint,
  permitSingle: PermitSingle,
  permit2Address: string
): Promise<string> {
  const domain = permit2Domain(chainId, permit2Address);
  return await (signer as any).signTypedData(domain, PERMIT2_TYPES, permitSingle);
}

/**
 * Build a PermitSingle for a monthly-subscription cap: amount = cycleAmount * cycles (default 12).
 * expiration / sigDeadline default to the uint48 sentinel; callers override for tighter windows.
 */
export function buildSubscriptionPermit(params: {
  token: string;
  spender: string;
  cycleAmount: bigint;
  cycles?: number; // default 12
  currentNonce: number | bigint;
  expiration?: number | bigint;
  sigDeadline?: bigint;
}): PermitSingle {
  const cycles = params.cycles ?? 12;
  const cap = params.cycleAmount * BigInt(cycles);
  return {
    details: {
      token: params.token,
      amount: cap,
      expiration: params.expiration ?? MAX_UINT48,
      nonce: params.currentNonce,
    },
    spender: params.spender,
    sigDeadline: params.sigDeadline ?? MAX_UINT48,
  };
}
