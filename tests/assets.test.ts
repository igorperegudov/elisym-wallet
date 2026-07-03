import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  formatAmountValue,
  NATIVE_SOL,
  parseAmount,
  resolveAmount,
  USDC_DEVNET,
} from '../src/core/assets.js';

describe('parseAmount', () => {
  it('parses whole SOL', () => {
    expect(parseAmount(NATIVE_SOL, '1')).toBe(1_000_000_000n);
  });

  it('parses fractional SOL', () => {
    expect(parseAmount(NATIVE_SOL, '0.5')).toBe(500_000_000n);
    expect(parseAmount(NATIVE_SOL, '.5')).toBe(500_000_000n);
    expect(parseAmount(NATIVE_SOL, '1.')).toBe(1_000_000_000n);
  });

  it('parses one lamport', () => {
    expect(parseAmount(NATIVE_SOL, '0.000000001')).toBe(1n);
  });

  it('parses USDC with 6 decimals', () => {
    expect(parseAmount(USDC_DEVNET, '1.25')).toBe(1_250_000n);
  });

  it('handles amounts beyond Number.MAX_SAFE_INTEGER', () => {
    expect(parseAmount(NATIVE_SOL, '10000000')).toBe(10_000_000_000_000_000n);
  });

  it('allows zero (transfers reject it separately)', () => {
    expect(parseAmount(NATIVE_SOL, '0')).toBe(0n);
  });

  it('rejects empty input', () => {
    expect(() => parseAmount(NATIVE_SOL, '')).toThrow(/empty/);
    expect(() => parseAmount(NATIVE_SOL, '   ')).toThrow(/empty/);
  });

  it('rejects negative amounts', () => {
    expect(() => parseAmount(NATIVE_SOL, '-1')).toThrow(/negative/);
  });

  it('rejects malformed input', () => {
    for (const bad of ['1e9', '0x5', '+5', '1,000', 'abc', '.']) {
      expect(() => parseAmount(NATIVE_SOL, bad)).toThrow(/decimal/);
    }
  });

  it('rejects too many decimal places', () => {
    expect(() => parseAmount(NATIVE_SOL, '0.0000000001')).toThrow(/decimals/);
    expect(() => parseAmount(USDC_DEVNET, '0.0000001')).toThrow(/decimals/);
  });

  it('rejects pathologically long inputs before BigInt parsing (DoS guard)', () => {
    const huge = '9'.repeat(500_000);
    expect(() => parseAmount(NATIVE_SOL, huge)).toThrow(/too long/);
    // a realistic long value (u128-scale with full decimals) is still accepted
    const realistic = `${'9'.repeat(39)}.${'1'.repeat(9)}`;
    expect(parseAmount(NATIVE_SOL, realistic)).toBeTypeOf('bigint');
  });
});

describe('formatAmount', () => {
  it('formats lamports with symbol', () => {
    expect(formatAmount(NATIVE_SOL, 1_500_000_000n)).toBe('1.5 SOL');
  });

  it('formats one lamport without exponential notation', () => {
    expect(formatAmount(NATIVE_SOL, 1n)).toBe('0.000000001 SOL');
  });

  it('strips trailing zeros', () => {
    expect(formatAmount(USDC_DEVNET, 10_000n)).toBe('0.01 USDC');
    expect(formatAmountValue(USDC_DEVNET, 1_000_000n)).toBe('1');
  });

  it('round-trips with parseAmount', () => {
    for (const human of ['0.5', '1', '123.456789', '0.000000001']) {
      const raw = parseAmount(NATIVE_SOL, human);
      expect(parseAmount(NATIVE_SOL, formatAmountValue(NATIVE_SOL, raw))).toBe(raw);
    }
  });
});

describe('resolveAmount', () => {
  it('passes bigint subunits through', () => {
    expect(resolveAmount(NATIVE_SOL, 42n)).toBe(42n);
  });

  it('parses decimal strings', () => {
    expect(resolveAmount(USDC_DEVNET, '2.5')).toBe(2_500_000n);
  });

  it('rejects negative bigints', () => {
    expect(() => resolveAmount(NATIVE_SOL, -1n)).toThrow(/negative/);
  });
});
