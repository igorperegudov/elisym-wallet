/**
 * Spend limits - a safety rail for autonomous spenders (AI agents, bots)
 * holding a self-custodied wallet.
 *
 * A `SpendTracker` keeps a per-asset ledger of committed plus in-flight
 * outflow and enforces optional per-asset caps. Two cap shapes:
 *
 *   - session cap (no `windowMs`): bounds total outflow for the tracker's
 *     lifetime;
 *   - rolling-window cap (`windowMs`): bounds outflow inside a sliding time
 *     window, e.g. "max 1 SOL per 24 hours" - old spend ages out.
 *
 * Transfers reserve their amount atomically (check-then-increment) BEFORE
 * signing, so two concurrent transfers cannot both pass the cap against a
 * stale counter; a failed send releases the reservation.
 *
 * State is in-memory; use `toJSON()` / `SpendTracker.fromJSON()` to persist a
 * budget across process restarts (essential for rolling windows - an agent
 * that crashes and restarts must not get a fresh daily budget).
 *
 * One tracker can be shared by several wallets to enforce a single budget
 * across all of them.
 */

import { formatAmount, resolveAmount } from './assets.js';
import type { Asset } from './assets.js';

/** Stable per-asset counter key: chain plus mint (tokens) or token id (native coins). */
export function assetKey(asset: Asset): string {
  return `${asset.chain}:${asset.mint ?? asset.token}`;
}

/**
 * Percent-of-cap thresholds that emit a soft warning the first time committed
 * spend crosses them. Each threshold fires at most once per asset per tracker.
 */
export const SPEND_WARN_THRESHOLDS: readonly number[] = [50, 80];

export interface SpendLimit {
  asset: Asset;
  /** Cap as raw subunits (bigint) or a human decimal string (e.g. "0.5" SOL). */
  limit: bigint | string;
  /**
   * Rolling window in milliseconds (e.g. 86_400_000 for a daily budget).
   * Spend older than the window no longer counts against the cap.
   * Omit for a cap on the tracker's whole lifetime.
   */
  windowMs?: number;
}

export interface SpendStatus {
  asset: Asset;
  /** Outflow currently counted against the cap, in raw subunits. */
  spent: bigint;
  /** Configured cap in raw subunits. Undefined when the asset has no cap. */
  limit?: bigint;
  /** Subunits still spendable under the cap. Undefined when there is no cap. */
  remaining?: bigint;
  /** Rolling window in ms. Undefined for session-lifetime caps. */
  windowMs?: number;
}

export class SpendLimitError extends Error {
  readonly asset: Asset;
  readonly attempted: bigint;
  readonly spent: bigint;
  readonly limit: bigint;
  readonly windowMs?: number;

  constructor(asset: Asset, attempted: bigint, spent: bigint, limit: bigint, windowMs?: number) {
    const remaining = limit > spent ? limit - spent : 0n;
    const scope =
      windowMs === undefined ? 'session' : `${Math.round(windowMs / 60_000)} min window`;
    super(
      `Spend limit reached for ${asset.symbol} (${scope}): ` +
        `attempted ${formatAmount(asset, attempted)}, ` +
        `already spent ${formatAmount(asset, spent)} of ${formatAmount(asset, limit)} ` +
        `(remaining ${formatAmount(asset, remaining)}).`,
    );
    this.name = 'SpendLimitError';
    this.asset = asset;
    this.attempted = attempted;
    this.spent = spent;
    this.limit = limit;
    this.windowMs = windowMs;
  }
}

interface SpendEntry {
  /** Per-tracker unique id so a reservation can be released by identity. */
  id: number;
  amount: bigint;
  at: number;
}

/**
 * Handle for a specific reservation, returned by `reserve()`/`record()`. Pass it
 * back to `release()` to undo exactly that entry - safe under concurrency, where
 * "newest entry" is not necessarily the one that failed.
 */
export interface SpendReservation {
  readonly asset: Asset;
  readonly id: number;
  readonly amount: bigint;
}

interface AssetLedger {
  asset: Asset;
  entries: SpendEntry[];
  limit?: bigint;
  windowMs?: number;
  firedWarnings: Set<number>;
}

export interface SpendTrackerOptions {
  /** Clock override for tests. Defaults to Date.now. */
  now?: () => number;
}

/** Serialized tracker state. Format is versioned; treat as opaque. */
export interface SpendTrackerSnapshot {
  version: 1;
  ledgers: {
    key: string;
    asset: Asset;
    entries: { amount: string; at: number }[];
    limit?: string;
    windowMs?: number;
    firedWarnings: number[];
  }[];
}

export class SpendTracker {
  private readonly ledgers = new Map<string, AssetLedger>();
  private readonly now: () => number;
  /** Monotonic id source for reservation entries (unique within this tracker). */
  private reservationSeq = 0;

  constructor(limits: SpendLimit[] = [], options: SpendTrackerOptions = {}) {
    this.now = options.now ?? Date.now;
    for (const entry of limits) {
      this.setLimit(entry.asset, entry.limit, entry.windowMs);
    }
  }

  /**
   * Set or replace the cap for an asset. Does not reset recorded spend.
   * Pass `windowMs` for a rolling-window budget.
   */
  setLimit(asset: Asset, limit: bigint | string, windowMs?: number): void {
    if (windowMs !== undefined && (!Number.isFinite(windowMs) || windowMs <= 0)) {
      throw new Error(`windowMs must be a positive number of milliseconds; got ${windowMs}`);
    }
    const ledger = this.ledger(asset);
    ledger.limit = resolveAmount(asset, limit);
    ledger.windowMs = windowMs;
  }

  /** Remove the cap for an asset. Spending becomes unlimited again. */
  clearLimit(asset: Asset): void {
    const ledger = this.ledgers.get(assetKey(asset));
    if (ledger) {
      ledger.limit = undefined;
      ledger.windowMs = undefined;
    }
  }

  /** Configured cap in subunits, or undefined when the asset has no cap. */
  limit(asset: Asset): bigint | undefined {
    return this.ledgers.get(assetKey(asset))?.limit;
  }

  /**
   * Outflow currently counted against the cap, in subunits. For windowed caps
   * this is the spend inside the current window; for session caps, the total.
   */
  spent(asset: Asset): bigint {
    const ledger = this.ledgers.get(assetKey(asset));
    if (!ledger) {
      return 0n;
    }
    this.prune(ledger);
    return sumEntries(ledger.entries);
  }

  /** Subunits still spendable under the cap. Null when no cap is configured. */
  remaining(asset: Asset): bigint | null {
    const ledger = this.ledgers.get(assetKey(asset));
    if (ledger?.limit === undefined) {
      return null;
    }
    const spent = this.spent(asset);
    return ledger.limit > spent ? ledger.limit - spent : 0n;
  }

  /** Throw `SpendLimitError` if spending `amount` would exceed the asset's cap. */
  assertCanSpend(asset: Asset, amount: bigint): void {
    const ledger = this.ledgers.get(assetKey(asset));
    if (ledger?.limit === undefined) {
      return;
    }
    const spent = this.spent(asset);
    if (spent + amount > ledger.limit) {
      throw new SpendLimitError(asset, amount, spent, ledger.limit, ledger.windowMs);
    }
  }

  /**
   * Atomic check-then-increment. Throws `SpendLimitError` if the cap would be
   * exceeded; otherwise reserves the amount immediately so a concurrent caller
   * sees the updated counter. Returns a `SpendReservation` handle; pass it to
   * `release()` on the failure path so a crashed transaction returns exactly
   * this reservation (correct even when other transfers are in flight).
   */
  reserve(asset: Asset, amount: bigint): SpendReservation {
    this.assertCanSpend(asset, amount);
    return this.record(asset, amount);
  }

  /** Add `amount` to the ledger without a cap check. Prefer `reserve()` for payment flows. */
  record(asset: Asset, amount: bigint): SpendReservation {
    const ledger = this.ledger(asset);
    this.reservationSeq += 1;
    const id = this.reservationSeq;
    ledger.entries.push({ id, amount, at: this.now() });
    return { asset, id, amount };
  }

  /**
   * Undo a prior `reserve()` / `record()`.
   *
   * Preferred form `release(reservation)`: removes exactly the entry that
   * `reserve()` returned, by id. This is concurrency-safe - a failed transfer
   * releases its OWN reservation and never a different in-flight one, even
   * though its entry may no longer be the newest.
   *
   * Legacy form `release(asset, amount)`: removes `amount` from the newest
   * entries first. Kept for manual budget adjustments; do NOT use it to roll
   * back a specific reservation when transfers can overlap - use the handle.
   * Saturates at zero so an over-release cannot drive the ledger negative.
   */
  release(reservation: SpendReservation): void;
  release(asset: Asset, amount: bigint): void;
  release(target: SpendReservation | Asset, amount?: bigint): void {
    if (isSpendReservation(target)) {
      const ledger = this.ledgers.get(assetKey(target.asset));
      if (!ledger) {
        return;
      }
      const index = ledger.entries.findIndex((e) => e.id === target.id);
      if (index >= 0) {
        ledger.entries.splice(index, 1);
      }
      return;
    }
    const ledger = this.ledgers.get(assetKey(target));
    if (!ledger) {
      return;
    }
    let left = amount ?? 0n;
    for (let i = ledger.entries.length - 1; i >= 0 && left > 0n; i -= 1) {
      const entry = ledger.entries[i]!;
      if (entry.amount <= left) {
        left -= entry.amount;
        ledger.entries.splice(i, 1);
      } else {
        entry.amount -= left;
        left = 0n;
      }
    }
  }

  /**
   * One-shot warning lines for any threshold newly crossed by the current
   * spend. Call AFTER a payment has committed on-chain (not after `reserve()`),
   * so a rolled-back reservation does not consume the warning budget.
   */
  takeWarnings(asset: Asset): string[] {
    const ledger = this.ledgers.get(assetKey(asset));
    if (!ledger || ledger.limit === undefined || ledger.limit === 0n) {
      return [];
    }
    const spent = this.spent(asset);
    const lines: string[] = [];
    for (const threshold of SPEND_WARN_THRESHOLDS) {
      if (ledger.firedWarnings.has(threshold)) {
        continue;
      }
      // Integer compare to avoid float rounding at the boundary.
      if (spent * 100n >= ledger.limit * BigInt(threshold)) {
        ledger.firedWarnings.add(threshold);
        lines.push(
          `Warning: spend reached ${threshold}% of the ${asset.symbol} cap ` +
            `(${formatAmount(asset, spent)} of ${formatAmount(asset, ledger.limit)}).`,
        );
      }
    }
    return lines;
  }

  /** Snapshot of every asset with spend activity or a configured cap. */
  status(): SpendStatus[] {
    const result: SpendStatus[] = [];
    for (const ledger of this.ledgers.values()) {
      this.prune(ledger);
      const spent = sumEntries(ledger.entries);
      result.push({
        asset: ledger.asset,
        spent,
        limit: ledger.limit,
        remaining:
          ledger.limit === undefined ? undefined : ledger.limit > spent ? ledger.limit - spent : 0n,
        windowMs: ledger.windowMs,
      });
    }
    return result;
  }

  /** Reset recorded spend and fired warnings. Configured limits stay. */
  reset(): void {
    for (const ledger of this.ledgers.values()) {
      ledger.entries = [];
      ledger.firedWarnings.clear();
    }
  }

  /**
   * Serialize the full tracker state (ledgers, caps, windows, fired warnings)
   * for persistence. Restore with `SpendTracker.fromJSON()`. Persisting and
   * restoring keeps rolling-window budgets honest across process restarts.
   */
  toJSON(): SpendTrackerSnapshot {
    return {
      version: 1,
      ledgers: [...this.ledgers.entries()].map(([key, ledger]) => ({
        key,
        asset: ledger.asset,
        entries: ledger.entries.map((e) => ({ amount: e.amount.toString(), at: e.at })),
        limit: ledger.limit?.toString(),
        windowMs: ledger.windowMs,
        firedWarnings: [...ledger.firedWarnings],
      })),
    };
  }

  /**
   * Restore a tracker from a `toJSON()` snapshot.
   *
   * The snapshot is treated as UNTRUSTED input: it usually comes from a file on
   * disk (e.g. `~/.elisym-wallet/<profile>/spend.json`). Every field is
   * validated - amounts must be non-negative integers, timestamps finite,
   * `windowMs` positive, and each ledger is re-keyed from its own asset - so
   * malformed or accidentally-corrupt data is rejected (fail-closed) rather than
   * silently under-reporting, and a negative-amount or key-orphan trick cannot
   * reopen the budget.
   *
   * This does NOT make the ledger tamper-proof: a writer with access to the file
   * can still reset the budget with a crafted-but-valid snapshot (an empty
   * ledger, or back-dated `at` timestamps that age out under a rolling window).
   * The persisted cap/window are re-applied from config on load, but the spend
   * entries are not, so file integrity ultimately rests on its `0600`
   * permissions - keep the wallet home out of an untrusted agent's reach.
   */
  static fromJSON(snapshot: SpendTrackerSnapshot, options: SpendTrackerOptions = {}): SpendTracker {
    if (!snapshot || snapshot.version !== 1) {
      throw new Error(`Unsupported SpendTracker snapshot version: ${snapshot?.version}`);
    }
    if (!Array.isArray(snapshot.ledgers)) {
      throw new Error('SpendTracker snapshot is malformed: "ledgers" must be an array.');
    }
    const tracker = new SpendTracker([], options);
    for (const entry of snapshot.ledgers) {
      const asset = entry?.asset;
      if (!asset || typeof asset.chain !== 'string' || typeof asset.token !== 'string') {
        throw new Error('SpendTracker snapshot has a ledger with a malformed asset.');
      }
      if (
        entry.windowMs !== undefined &&
        (!Number.isFinite(entry.windowMs) || entry.windowMs <= 0)
      ) {
        throw new Error(`SpendTracker snapshot has an invalid windowMs: ${entry.windowMs}`);
      }
      if (!Array.isArray(entry.entries)) {
        throw new Error('SpendTracker snapshot has a ledger with malformed entries.');
      }
      const entries = entry.entries.map((e) => {
        if (!e || !Number.isFinite(e.at)) {
          throw new Error(`SpendTracker snapshot has an invalid entry timestamp: ${e?.at}`);
        }
        tracker.reservationSeq += 1;
        return {
          id: tracker.reservationSeq,
          amount: toLedgerAmount(e.amount, 'entry amount'),
          at: e.at,
        };
      });
      // Re-key from the asset itself: the on-disk `key` is not trusted to match.
      tracker.ledgers.set(assetKey(asset), {
        asset,
        entries,
        limit: entry.limit === undefined ? undefined : toLedgerAmount(entry.limit, 'limit'),
        windowMs: entry.windowMs,
        firedWarnings: new Set(Array.isArray(entry.firedWarnings) ? entry.firedWarnings : []),
      });
    }
    return tracker;
  }

  private ledger(asset: Asset): AssetLedger {
    const key = assetKey(asset);
    let ledger = this.ledgers.get(key);
    if (!ledger) {
      ledger = { asset, entries: [], firedWarnings: new Set() };
      this.ledgers.set(key, ledger);
    }
    return ledger;
  }

  /** Drop entries that aged out of the rolling window. No-op for session caps. */
  private prune(ledger: AssetLedger): void {
    if (ledger.windowMs === undefined || ledger.entries.length === 0) {
      return;
    }
    const cutoff = this.now() - ledger.windowMs;
    ledger.entries = ledger.entries.filter((e) => e.at > cutoff);
  }
}

function sumEntries(entries: SpendEntry[]): bigint {
  let total = 0n;
  for (const entry of entries) {
    total += entry.amount;
  }
  return total;
}

/** Distinguish a reservation handle from an `Asset` for the `release` overload. */
function isSpendReservation(value: SpendReservation | Asset): value is SpendReservation {
  return typeof (value as { id?: unknown }).id === 'number';
}

/**
 * Parse an amount from an untrusted snapshot into a non-negative bigint. Throws
 * on non-integer or negative values so a tampered ledger cannot inject negative
 * spend (which would reduce the counted total and reopen the cap).
 */
function toLedgerAmount(value: string, label: string): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`SpendTracker snapshot has a non-integer ${label}: ${value}`);
  }
  if (parsed < 0n) {
    throw new Error(`SpendTracker snapshot has a negative ${label}: ${value}`);
  }
  return parsed;
}
