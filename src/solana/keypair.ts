/**
 * Ed25519 keypair helpers on top of @solana/kit signers.
 *
 * The interchange format is the standard 64-byte secret key
 * (32-byte private seed + 32-byte public key) used by solana-keygen,
 * Phantom exports, and `createKeyPairSignerFromBytes`. Base58 helpers
 * encode/decode that same 64-byte layout.
 */

import {
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase58Encoder,
} from '@solana/kit';
import type { KeyPairSigner } from '@solana/kit';

export const SECRET_KEY_LENGTH = 64;

const BASE58_DECODER = getBase58Decoder();
const BASE58_ENCODER = getBase58Encoder();

/** Generate a fresh extractable keypair signer. */
export async function generateSigner(): Promise<KeyPairSigner> {
  return generateKeyPairSigner(true);
}

/**
 * Extract the 64-byte secret key (32-byte private seed + 32-byte public key)
 * from an extractable KeyPairSigner. Throws if the signer was created
 * non-extractable (the WebCrypto key cannot be exported).
 */
export async function exportSecretKeyBytes(signer: KeyPairSigner): Promise<Uint8Array> {
  const { privateKey, publicKey } = signer.keyPair;
  const [pkcs8, rawPub] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', privateKey),
    crypto.subtle.exportKey('raw', publicKey),
  ]);
  // PKCS#8 has a fixed 16-byte Ed25519 header; the raw 32-byte seed follows.
  const privateBytes = new Uint8Array(pkcs8).slice(16);
  const publicBytes = new Uint8Array(rawPub);
  const bytes = new Uint8Array(SECRET_KEY_LENGTH);
  bytes.set(privateBytes, 0);
  bytes.set(publicBytes, 32);
  return bytes;
}

/** Build an extractable signer from a 64-byte secret key. */
export async function signerFromSecretKeyBytes(bytes: Uint8Array): Promise<KeyPairSigner> {
  assertSecretKeyLength(bytes.length);
  return createKeyPairSignerFromBytes(bytes, true);
}

/** Encode a 64-byte secret key as base58 (solana-keygen compatible). */
export function secretKeyToBase58(bytes: Uint8Array): string {
  assertSecretKeyLength(bytes.length);
  return BASE58_DECODER.decode(bytes);
}

/**
 * Decode a base58 secret key string back to its 64 bytes.
 *
 * A decode failure throws a message that deliberately does NOT include the
 * input: the kit decoder echoes the offending string verbatim, and this input
 * is a secret key, so surfacing it (to stderr, shell history, or CI logs) would
 * leak a near-complete key. The generic message keeps the secret out of errors.
 */
export function secretKeyFromBase58(base58: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(BASE58_ENCODER.encode(base58));
  } catch {
    throw new Error('Invalid base58 secret key.');
  }
  assertSecretKeyLength(bytes.length);
  return bytes;
}

function assertSecretKeyLength(length: number): void {
  if (length !== SECRET_KEY_LENGTH) {
    throw new Error(
      `Secret key must be exactly ${SECRET_KEY_LENGTH} bytes ` +
        `(32-byte seed + 32-byte public key); got ${length}.`,
    );
  }
}
