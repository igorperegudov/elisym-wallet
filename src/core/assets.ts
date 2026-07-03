/**
 * Asset model and amount math.
 *
 * All amounts move through this module as raw subunits (`bigint`): lamports for SOL,
 * 1e-6 units for USDC. Parsing uses pure integer math; display formatting uses
 * decimal.js-light. Floating point never touches money.
 */

import Decimal from 'decimal.js-light';

export interface Asset {
  /** Chain id: 'solana', 'ethereum', ... */
  chain: string;
  /** Lowercase token id: 'sol', 'usdc', 'eth'. */
  token: string;
  /** Token contract: SPL mint / ERC-20 address. Undefined for a native coin. */
  mint?: string;
  /** Subunits per whole unit (9 for SOL, 6 for USDC, 18 for ETH). */
  decimals: number;
  /** Display symbol: 'SOL', 'USDC'. */
  symbol: string;
}

export const NATIVE_SOL: Asset = {
  chain: 'solana',
  token: 'sol',
  decimals: 9,
  symbol: 'SOL',
};

export const USDC_MAINNET: Asset = {
  chain: 'solana',
  token: 'usdc',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
  symbol: 'USDC',
};

export const USDC_DEVNET: Asset = {
  chain: 'solana',
  token: 'usdc',
  mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  decimals: 6,
  symbol: 'USDC',
};

const DECIMAL_RE = /^(\d+\.\d*|\d*\.\d+|\d+)$/;

/**
 * Upper bound on an amount string. Real amounts are short (u64 raw is 20
 * digits, u128 is 39); this only rejects pathological inputs. `BigInt()` decimal
 * parsing is roughly O(n^2), so an unbounded attacker-supplied amount (a tool
 * argument) could pin the single-threaded process - cap the length first.
 */
const MAX_AMOUNT_STRING_LENGTH = 64;

/**
 * Parse a human amount string ("0.5", "1", ".25") into raw subunits (`bigint`).
 * Integer math only - no floats, no precision loss, no upper bound beyond bigint.
 *
 * Throws on: empty, negative, malformed (scientific notation, hex, `+`, commas),
 * or more fractional digits than the asset supports. Zero is allowed; transfer
 * methods reject it separately.
 */
export function parseAmount(asset: Asset, human: string): bigint {
  const trimmed = human.trim();
  if (!trimmed) {
    throw new Error(`${asset.symbol} amount is empty.`);
  }
  if (trimmed.length > MAX_AMOUNT_STRING_LENGTH) {
    throw new Error(
      `${asset.symbol} amount is too long (max ${MAX_AMOUNT_STRING_LENGTH} characters).`,
    );
  }
  if (trimmed.startsWith('-')) {
    throw new Error(`${asset.symbol} amount cannot be negative.`);
  }
  if (!DECIMAL_RE.test(trimmed)) {
    throw new Error(
      `${asset.symbol} amount must be a non-negative decimal (e.g. "0.5", "1"); got "${human}".`,
    );
  }

  const dotPos = trimmed.indexOf('.');
  let wholePart: string;
  if (dotPos === -1) {
    wholePart = trimmed;
  } else if (dotPos === 0) {
    wholePart = '0';
  } else {
    wholePart = trimmed.slice(0, dotPos);
  }
  const fracPart = dotPos === -1 ? '' : trimmed.slice(dotPos + 1);

  if (fracPart.length > asset.decimals) {
    throw new Error(
      `${asset.symbol} amount has too many decimals (max ${asset.decimals}); got "${human}".`,
    );
  }

  const unit = 10n ** BigInt(asset.decimals);
  const whole = BigInt(wholePart);
  const frac = fracPart ? BigInt(fracPart.padEnd(asset.decimals, '0')) : 0n;
  return whole * unit + frac;
}

// Cloned config keeps `Decimal.toString()` from switching to exponential notation
// for small fractional amounts (e.g. 1 lamport = 1e-9 SOL).
const FormatDecimal = Decimal.clone({ toExpNeg: -100, toExpPos: 100, precision: 50 });

/**
 * Format raw subunits as a plain decimal string (no symbol). Trailing zeros are
 * stripped, so 10000 raw USDC renders as "0.01" rather than "0.010000".
 */
export function formatAmountValue(asset: Asset, raw: bigint): string {
  const value = new FormatDecimal(raw.toString()).div(new FormatDecimal(10).pow(asset.decimals));
  return value.toString();
}

/** Format raw subunits as `"<value> <SYMBOL>"`, e.g. `"0.5 SOL"`. */
export function formatAmount(asset: Asset, raw: bigint): string {
  return `${formatAmountValue(asset, raw)} ${asset.symbol}`;
}

/**
 * Resolve an amount given either raw subunits (`bigint`) or a human decimal
 * string. Used by transfer methods so callers can pass `"0.5"` or `500000000n`.
 */
export function resolveAmount(asset: Asset, amount: bigint | string): bigint {
  if (typeof amount === 'bigint') {
    if (amount < 0n) {
      throw new Error(`${asset.symbol} amount cannot be negative.`);
    }
    return amount;
  }
  return parseAmount(asset, amount);
}
