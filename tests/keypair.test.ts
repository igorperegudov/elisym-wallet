import { describe, expect, it } from 'vitest';
import {
  exportSecretKeyBytes,
  generateSigner,
  SECRET_KEY_LENGTH,
  secretKeyFromBase58,
  secretKeyToBase58,
  signerFromSecretKeyBytes,
} from '../src/solana/keypair.js';

describe('keypair', () => {
  it('exports a 64-byte secret key from a generated signer', async () => {
    const signer = await generateSigner();
    const bytes = await exportSecretKeyBytes(signer);
    expect(bytes).toHaveLength(SECRET_KEY_LENGTH);
  });

  it('round-trips bytes -> signer -> bytes preserving the address', async () => {
    const original = await generateSigner();
    const bytes = await exportSecretKeyBytes(original);

    const restored = await signerFromSecretKeyBytes(bytes);
    expect(restored.address).toBe(original.address);

    const reExported = await exportSecretKeyBytes(restored);
    expect(reExported).toEqual(bytes);
  });

  it('round-trips base58 encoding', async () => {
    const signer = await generateSigner();
    const bytes = await exportSecretKeyBytes(signer);
    const base58 = secretKeyToBase58(bytes);
    expect(secretKeyFromBase58(base58)).toEqual(bytes);
  });

  it('rejects secret keys that are not 64 bytes', async () => {
    await expect(signerFromSecretKeyBytes(new Uint8Array(32))).rejects.toThrow(/64 bytes/);
    expect(() => secretKeyToBase58(new Uint8Array(63))).toThrow(/64 bytes/);
  });

  it('does not echo the input into the decode error (a mistyped secret must not leak)', () => {
    const almostAKey = 'bad!secret!value';
    expect(() => secretKeyFromBase58(almostAKey)).toThrow(/Invalid base58 secret key/);
    try {
      secretKeyFromBase58(almostAKey);
    } catch (e) {
      expect((e as Error).message).not.toContain(almostAKey);
    }
  });
});
