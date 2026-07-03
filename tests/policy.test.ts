import { isAddress } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { NATIVE_SOL, USDC_DEVNET } from '../src/core/assets.js';
import { PolicyEngine, PolicyViolationError } from '../src/core/policy.js';

// Real base58 addresses (system program and token program) used as stand-ins.
const ADDR_A = '11111111111111111111111111111111';
const ADDR_B = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ADDR_C = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

describe('PolicyEngine', () => {
  it('caps single transfers per asset', () => {
    const engine = new PolicyEngine({
      maxPerTransfer: [{ asset: NATIVE_SOL, limit: '0.1' }],
    });
    engine.checkTransfer(NATIVE_SOL, 100_000_000n, ADDR_A); // exactly at cap: ok
    expect(() => engine.checkTransfer(NATIVE_SOL, 100_000_001n, ADDR_A)).toThrow(
      PolicyViolationError,
    );
    // other assets are uncapped
    engine.checkTransfer(USDC_DEVNET, 10n ** 12n, ADDR_A);
  });

  it('enforces the recipient allowlist', () => {
    const engine = new PolicyEngine({ allowedRecipients: [ADDR_A] });
    engine.checkTransfer(NATIVE_SOL, 1n, ADDR_A);
    try {
      engine.checkTransfer(NATIVE_SOL, 1n, ADDR_B);
      expect.unreachable();
    } catch (e) {
      expect((e as PolicyViolationError).rule).toBe('recipient_not_allowed');
    }
  });

  it('blocklist wins over allowlist', () => {
    const engine = new PolicyEngine({
      allowedRecipients: [ADDR_A],
      blockedRecipients: [ADDR_A],
    });
    try {
      engine.checkTransfer(NATIVE_SOL, 1n, ADDR_A);
      expect.unreachable();
    } catch (e) {
      expect((e as PolicyViolationError).rule).toBe('recipient_blocked');
    }
  });

  it('rejects invalid addresses when a chain validator is provided', () => {
    expect(
      () =>
        new PolicyEngine({ allowedRecipients: ['not-an-address'] }, { isValidAddress: isAddress }),
    ).toThrow(/invalid address/);
    expect(
      () => new PolicyEngine({ blockedRecipients: ['nope'] }, { isValidAddress: isAddress }),
    ).toThrow(/invalid address/);
    // without a validator, entries are matched verbatim (chain-agnostic mode)
    const lax = new PolicyEngine({ blockedRecipients: ['anything-goes'] });
    expect(() => lax.checkTransfer(NATIVE_SOL, 1n, 'anything-goes')).toThrow(PolicyViolationError);
  });

  it('rate-limits transfers over a sliding window', () => {
    let time = 0;
    const engine = new PolicyEngine(
      { rateLimit: { maxTransfers: 2, windowSecs: 60 } },
      { now: () => time },
    );
    engine.checkTransfer(NATIVE_SOL, 1n, ADDR_A);
    engine.recordTransfer();
    engine.checkTransfer(NATIVE_SOL, 1n, ADDR_A);
    engine.recordTransfer();
    try {
      engine.checkTransfer(NATIVE_SOL, 1n, ADDR_A);
      expect.unreachable();
    } catch (e) {
      expect((e as PolicyViolationError).rule).toBe('rate_limit');
    }
    // window slides: after 61s the first two age out
    time = 61_000;
    engine.checkTransfer(NATIVE_SOL, 1n, ADDR_A);
  });

  it('rejected attempts do not consume the rate budget', () => {
    const engine = new PolicyEngine({
      rateLimit: { maxTransfers: 1, windowSecs: 60 },
      allowedRecipients: [ADDR_A],
    });
    // a rejected (not allowlisted) attempt does not call recordTransfer
    expect(() => engine.checkTransfer(NATIVE_SOL, 1n, ADDR_C)).toThrow(PolicyViolationError);
    engine.checkTransfer(NATIVE_SOL, 1n, ADDR_A); // still admitted
  });

  it('validates rate limit config', () => {
    expect(() => new PolicyEngine({ rateLimit: { maxTransfers: 0, windowSecs: 60 } })).toThrow(
      /positive integer/,
    );
    expect(() => new PolicyEngine({ rateLimit: { maxTransfers: 1, windowSecs: 0 } })).toThrow(
      /must be positive/,
    );
  });
});
