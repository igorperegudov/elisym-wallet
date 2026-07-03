import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, isEncrypted } from '../src/keystore.js';

describe('keystore', () => {
  it('round-trips a secret', () => {
    const encrypted = encryptSecret('my-secret-key', 'correct horse battery staple');
    expect(isEncrypted(encrypted)).toBe(true);
    expect(decryptSecret(encrypted, 'correct horse battery staple')).toBe('my-secret-key');
  });

  it('produces different ciphertexts for the same input (random salt/iv)', () => {
    const a = encryptSecret('secret', 'pass');
    const b = encryptSecret('secret', 'pass');
    expect(a).not.toBe(b);
  });

  it('rejects the wrong passphrase', () => {
    const encrypted = encryptSecret('secret', 'right');
    expect(() => decryptSecret(encrypted, 'wrong')).toThrow(/Wrong passphrase or corrupted/);
  });

  it('rejects tampered payloads', () => {
    const encrypted = encryptSecret('secret', 'pass');
    const body = encrypted.slice('encrypted:v1:'.length);
    const flipped = body[10] === 'A' ? 'B' : 'A';
    const tampered = `encrypted:v1:${body.slice(0, 10)}${flipped}${body.slice(11)}`;
    expect(() => decryptSecret(tampered, 'pass')).toThrow();
  });

  it('rejects empty passphrases', () => {
    expect(() => encryptSecret('secret', '')).toThrow(/empty/);
    expect(() => decryptSecret('encrypted:v1:abc', '')).toThrow(/empty/);
  });

  it('rejects values without the prefix', () => {
    expect(isEncrypted('plaintext')).toBe(false);
    expect(() => decryptSecret('plaintext', 'pass')).toThrow(/not encrypted/);
  });
});
