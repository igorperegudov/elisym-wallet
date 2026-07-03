/**
 * Off-chain message signing and verification.
 *
 * Lets a wallet prove ownership of its address without an on-chain
 * transaction - e.g. an agent authenticating to a service, or a service
 * verifying that a job result really came from the agent it paid.
 * Ed25519 over the raw message bytes; signatures are base58.
 */

import {
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  verifySignature,
} from '@solana/kit';
import type { Address, SignatureBytes } from '@solana/kit';

const BASE58_DECODER = getBase58Decoder();
const BASE58_ENCODER = getBase58Encoder();

export function messageToBytes(message: string | Uint8Array): Uint8Array {
  return typeof message === 'string' ? new TextEncoder().encode(message) : message;
}

/** Encode raw signature bytes as base58 for transport. */
export function signatureToBase58(bytes: Uint8Array): string {
  return BASE58_DECODER.decode(bytes);
}

/**
 * Verify a base58 Ed25519 signature over `message` against a wallet address.
 * Returns false for a wrong signer, tampered message, or malformed signature.
 */
export async function verifyMessageSignature(params: {
  address: string;
  message: string | Uint8Array;
  signature: string;
}): Promise<boolean> {
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = new Uint8Array(BASE58_ENCODER.encode(params.signature));
  } catch {
    return false;
  }
  if (signatureBytes.length !== 64) {
    return false;
  }

  // A malformed address must also yield `false` (documented contract), not throw:
  // the base58 address decode and key import reject bad input, so guard them too.
  try {
    // A Solana address IS the raw Ed25519 public key (32 bytes, base58).
    const publicKeyBytes = new Uint8Array(getAddressEncoder().encode(params.address as Address));
    const publicKey = await crypto.subtle.importKey('raw', publicKeyBytes, 'Ed25519', true, [
      'verify',
    ]);
    return await verifySignature(
      publicKey,
      signatureBytes as SignatureBytes,
      messageToBytes(params.message),
    );
  } catch {
    return false;
  }
}
