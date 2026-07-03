/**
 * Wallet policy - hard rules checked before every transfer, independent of
 * spend limits. Where `SpendTracker` bounds HOW MUCH can flow out over time,
 * `WalletPolicy` bounds WHERE and HOW OFTEN individual transfers may go:
 *
 *   - `maxPerTransfer`: cap on a single transfer, per asset;
 *   - `allowedRecipients`: transfers may go ONLY to these addresses;
 *   - `blockedRecipients`: transfers may NEVER go to these addresses;
 *   - `rateLimit`: sliding-window cap on transfer frequency.
 *
 * Violations throw `PolicyViolationError` before anything is signed. For a
 * wallet held by an AI agent, an allowlist is the strongest single defense:
 * a prompt-injected "send everything to X" fails unless X was explicitly
 * pre-approved by the developer.
 */

import { formatAmount, resolveAmount } from './assets.js';
import type { Asset } from './assets.js';
import { assetKey } from './spend-limits.js';

export type PolicyRule =
  | 'max_per_transfer'
  | 'recipient_not_allowed'
  | 'recipient_blocked'
  | 'rate_limit';

export class PolicyViolationError extends Error {
  readonly rule: PolicyRule;

  constructor(rule: PolicyRule, message: string) {
    super(message);
    this.name = 'PolicyViolationError';
    this.rule = rule;
  }
}

export interface PerTransferLimit {
  asset: Asset;
  /** Max single-transfer amount as raw subunits (bigint) or a human decimal string. */
  limit: bigint | string;
}

export interface TransferRateLimit {
  /** Max transfers admitted inside the window. */
  maxTransfers: number;
  /** Window length in seconds. */
  windowSecs: number;
}

export interface WalletPolicy {
  /** Cap on any single transfer, per asset. Assets without an entry are uncapped. */
  maxPerTransfer?: PerTransferLimit[];
  /**
   * If set, transfers are allowed ONLY to these addresses. Strongest guard
   * for agent-held wallets: unknown recipients are rejected outright.
   */
  allowedRecipients?: string[];
  /** Transfers to these addresses are always rejected. Checked before the allowlist. */
  blockedRecipients?: string[];
  /** Sliding-window cap on transfer frequency. */
  rateLimit?: TransferRateLimit;
}

export interface PolicyEngineOptions {
  /** Clock override for tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Chain-specific address-format validator for allow/blocklist entries,
   * usually the wallet's `isValidAddress`. When omitted, list entries are
   * matched verbatim without format validation.
   */
  isValidAddress?: (address: string) => boolean;
}

/**
 * Compiled, validated form of a `WalletPolicy`. Created once per wallet;
 * `checkTransfer` runs before every transfer, `recordTransfer` after the
 * transfer is admitted (rate-limit accounting).
 */
export class PolicyEngine {
  private readonly maxPerTransfer = new Map<string, { asset: Asset; limit: bigint }>();
  private readonly allowed?: Set<string>;
  private readonly blocked: Set<string>;
  private readonly rateLimit?: TransferRateLimit;
  private readonly transferTimestamps: number[] = [];
  private readonly now: () => number;

  constructor(policy: WalletPolicy, options: PolicyEngineOptions = {}) {
    this.now = options.now ?? Date.now;

    for (const entry of policy.maxPerTransfer ?? []) {
      this.maxPerTransfer.set(assetKey(entry.asset), {
        asset: entry.asset,
        limit: resolveAmount(entry.asset, entry.limit),
      });
    }

    const assertPolicyAddress = (field: string, value: string): void => {
      if (options.isValidAddress && !options.isValidAddress(value)) {
        throw new Error(`${field} contains an invalid address: "${value}".`);
      }
    };

    if (policy.allowedRecipients) {
      for (const addr of policy.allowedRecipients) {
        assertPolicyAddress('allowedRecipients', addr);
      }
      this.allowed = new Set(policy.allowedRecipients);
    }

    for (const addr of policy.blockedRecipients ?? []) {
      assertPolicyAddress('blockedRecipients', addr);
    }
    this.blocked = new Set(policy.blockedRecipients ?? []);

    if (policy.rateLimit) {
      const { maxTransfers, windowSecs } = policy.rateLimit;
      if (!Number.isInteger(maxTransfers) || maxTransfers <= 0) {
        throw new Error(`rateLimit.maxTransfers must be a positive integer; got ${maxTransfers}.`);
      }
      if (!Number.isFinite(windowSecs) || windowSecs <= 0) {
        throw new Error(`rateLimit.windowSecs must be positive; got ${windowSecs}.`);
      }
      this.rateLimit = policy.rateLimit;
    }
  }

  /**
   * Throw `PolicyViolationError` if the transfer breaks any rule. Does NOT
   * count the transfer against the rate limit - call `recordTransfer()` once
   * the transfer is actually admitted, so rejected attempts cannot starve the
   * budget.
   */
  checkTransfer(asset: Asset, amount: bigint, recipient: string): void {
    if (this.blocked.has(recipient)) {
      throw new PolicyViolationError(
        'recipient_blocked',
        `Recipient ${recipient} is on the wallet's blocklist.`,
      );
    }
    if (this.allowed && !this.allowed.has(recipient)) {
      throw new PolicyViolationError(
        'recipient_not_allowed',
        `Recipient ${recipient} is not on the wallet's allowlist. ` +
          'Transfers are restricted to pre-approved addresses.',
      );
    }

    const cap = this.maxPerTransfer.get(assetKey(asset));
    if (cap && amount > cap.limit) {
      throw new PolicyViolationError(
        'max_per_transfer',
        `Transfer of ${formatAmount(asset, amount)} exceeds the per-transfer cap of ` +
          `${formatAmount(asset, cap.limit)}. Split the payment or raise the per-transfer cap.`,
      );
    }

    if (this.rateLimit) {
      const cutoff = this.now() - this.rateLimit.windowSecs * 1000;
      const recent = this.transferTimestamps.filter((t) => t > cutoff);
      if (recent.length >= this.rateLimit.maxTransfers) {
        throw new PolicyViolationError(
          'rate_limit',
          `Transfer rate limit reached: max ${this.rateLimit.maxTransfers} transfers ` +
            `per ${this.rateLimit.windowSecs}s. Try again shortly.`,
        );
      }
    }
  }

  /** Count an admitted transfer against the rate limit. */
  recordTransfer(): void {
    if (!this.rateLimit) {
      return;
    }
    const cutoff = this.now() - this.rateLimit.windowSecs * 1000;
    // Compact in place: drop timestamps that fell out of the window.
    const keep = this.transferTimestamps.filter((t) => t > cutoff);
    keep.push(this.now());
    this.transferTimestamps.length = 0;
    this.transferTimestamps.push(...keep);
  }
}
