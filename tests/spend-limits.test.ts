import { describe, expect, it } from 'vitest';
import { NATIVE_SOL, USDC_DEVNET } from '../src/core/assets.js';
import { SpendLimitError, SpendTracker, assetKey } from '../src/core/spend-limits.js';
import type { SpendTrackerSnapshot } from '../src/core/spend-limits.js';

describe('assetKey', () => {
  it('keys by chain plus token id (native) or mint (tokens)', () => {
    expect(assetKey(NATIVE_SOL)).toBe('solana:sol');
    expect(assetKey(USDC_DEVNET)).toBe(`solana:${USDC_DEVNET.mint}`);
  });
});

describe('SpendTracker', () => {
  it('allows unlimited spend when no cap is configured', () => {
    const tracker = new SpendTracker();
    tracker.reserve(NATIVE_SOL, 10n ** 18n);
    expect(tracker.spent(NATIVE_SOL)).toBe(10n ** 18n);
    expect(tracker.remaining(NATIVE_SOL)).toBeNull();
  });

  it('accepts caps as human decimal strings', () => {
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: '0.5' }]);
    expect(tracker.limit(NATIVE_SOL)).toBe(500_000_000n);
  });

  it('reserves within the cap and rejects past it', () => {
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: 100n }]);
    tracker.reserve(NATIVE_SOL, 60n);
    expect(() => tracker.reserve(NATIVE_SOL, 41n)).toThrow(SpendLimitError);
    // the failed reserve must not have consumed budget
    expect(tracker.spent(NATIVE_SOL)).toBe(60n);
    tracker.reserve(NATIVE_SOL, 40n);
    expect(tracker.remaining(NATIVE_SOL)).toBe(0n);
  });

  it('reports attempted/spent/limit in the error', () => {
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: '1' }]);
    tracker.reserve(NATIVE_SOL, 900_000_000n);
    try {
      tracker.reserve(NATIVE_SOL, 200_000_000n);
      expect.unreachable();
    } catch (e) {
      const err = e as SpendLimitError;
      expect(err.message).toContain('attempted 0.2 SOL');
      expect(err.message).toContain('already spent 0.9 SOL of 1 SOL');
      expect(err.message).toContain('remaining 0.1 SOL');
    }
  });

  it('tracks assets independently', () => {
    const tracker = new SpendTracker([
      { asset: NATIVE_SOL, limit: 100n },
      { asset: USDC_DEVNET, limit: 200n },
    ]);
    tracker.reserve(NATIVE_SOL, 100n);
    tracker.reserve(USDC_DEVNET, 150n);
    expect(() => tracker.reserve(NATIVE_SOL, 1n)).toThrow(SpendLimitError);
    expect(tracker.remaining(USDC_DEVNET)).toBe(50n);
  });

  it('release returns budget and saturates at zero', () => {
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: 100n }]);
    tracker.reserve(NATIVE_SOL, 80n);
    tracker.release(NATIVE_SOL, 80n);
    expect(tracker.spent(NATIVE_SOL)).toBe(0n);
    tracker.release(NATIVE_SOL, 999n);
    expect(tracker.spent(NATIVE_SOL)).toBe(0n);
  });

  it('release(handle) removes exactly its own reservation, not the newest', () => {
    let time = 0;
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: 100n }], { now: () => time });
    const a = tracker.reserve(NATIVE_SOL, 30n); // older reservation
    time = 10;
    const b = tracker.reserve(NATIVE_SOL, 50n); // newer, must survive A's rollback
    // A fails after B was already reserved; releasing A's handle must not touch B
    tracker.release(a);
    expect(tracker.spent(NATIVE_SOL)).toBe(50n);
    tracker.release(b);
    expect(tracker.spent(NATIVE_SOL)).toBe(0n);
  });

  it('fires 50% and 80% warnings once each', () => {
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: 100n }]);
    tracker.record(NATIVE_SOL, 50n);
    const first = tracker.takeWarnings(NATIVE_SOL);
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('50%');
    // same threshold does not fire twice
    expect(tracker.takeWarnings(NATIVE_SOL)).toHaveLength(0);
    tracker.record(NATIVE_SOL, 30n);
    const second = tracker.takeWarnings(NATIVE_SOL);
    expect(second).toHaveLength(1);
    expect(second[0]).toContain('80%');
  });

  it('fires both warnings at once when a single spend crosses both thresholds', () => {
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: 100n }]);
    tracker.record(NATIVE_SOL, 90n);
    expect(tracker.takeWarnings(NATIVE_SOL)).toHaveLength(2);
  });

  it('emits no warnings without a cap', () => {
    const tracker = new SpendTracker();
    tracker.record(NATIVE_SOL, 10n ** 18n);
    expect(tracker.takeWarnings(NATIVE_SOL)).toHaveLength(0);
  });

  it('reports status for capped and uncapped assets', () => {
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: 100n }]);
    tracker.reserve(NATIVE_SOL, 30n);
    tracker.record(USDC_DEVNET, 5n);
    const status = tracker.status();
    const sol = status.find((s) => s.asset.token === 'sol');
    const usdc = status.find((s) => s.asset.token === 'usdc');
    expect(sol).toMatchObject({ spent: 30n, limit: 100n, remaining: 70n });
    expect(usdc).toMatchObject({ spent: 5n, limit: undefined, remaining: undefined });
  });

  it('reset clears counters and warnings but keeps limits', () => {
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: 100n }]);
    tracker.reserve(NATIVE_SOL, 60n);
    tracker.takeWarnings(NATIVE_SOL);
    tracker.reset();
    expect(tracker.spent(NATIVE_SOL)).toBe(0n);
    expect(tracker.limit(NATIVE_SOL)).toBe(100n);
    tracker.record(NATIVE_SOL, 50n);
    // 50% warning can fire again after reset
    expect(tracker.takeWarnings(NATIVE_SOL)).toHaveLength(1);
  });

  it('setLimit updates and clearLimit removes the cap', () => {
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: 100n }]);
    tracker.setLimit(NATIVE_SOL, 50n);
    expect(() => tracker.reserve(NATIVE_SOL, 60n)).toThrow(SpendLimitError);
    tracker.clearLimit(NATIVE_SOL);
    tracker.reserve(NATIVE_SOL, 60n);
    expect(tracker.spent(NATIVE_SOL)).toBe(60n);
  });
});

describe('SpendTracker rolling windows', () => {
  const HOUR = 3_600_000;

  it('ages spend out of the window', () => {
    let time = 0;
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: 100n, windowMs: HOUR }], {
      now: () => time,
    });
    tracker.reserve(NATIVE_SOL, 100n);
    expect(() => tracker.reserve(NATIVE_SOL, 1n)).toThrow(SpendLimitError);

    time = HOUR + 1;
    expect(tracker.spent(NATIVE_SOL)).toBe(0n);
    tracker.reserve(NATIVE_SOL, 100n); // full budget available again
  });

  it('counts only in-window spend against the cap', () => {
    let time = 0;
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: 100n, windowMs: HOUR }], {
      now: () => time,
    });
    tracker.reserve(NATIVE_SOL, 60n);
    time = HOUR / 2;
    tracker.reserve(NATIVE_SOL, 40n);
    time = HOUR + 1; // the first 60n aged out, the 40n is still in-window
    expect(tracker.spent(NATIVE_SOL)).toBe(40n);
    tracker.reserve(NATIVE_SOL, 60n);
    expect(() => tracker.reserve(NATIVE_SOL, 1n)).toThrow(SpendLimitError);
  });

  it('release removes the newest reservation first', () => {
    let time = 0;
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: 100n, windowMs: HOUR }], {
      now: () => time,
    });
    tracker.reserve(NATIVE_SOL, 30n); // old entry
    time = 10;
    tracker.reserve(NATIVE_SOL, 50n); // failed transfer, will be released
    tracker.release(NATIVE_SOL, 50n);
    expect(tracker.spent(NATIVE_SOL)).toBe(30n);
  });

  it('reports the window in the error message', () => {
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: 100n, windowMs: 24 * HOUR }]);
    tracker.reserve(NATIVE_SOL, 100n);
    expect(() => tracker.reserve(NATIVE_SOL, 1n)).toThrow(/1440 min window/);
  });

  it('rejects invalid windows', () => {
    expect(() => new SpendTracker([{ asset: NATIVE_SOL, limit: 1n, windowMs: 0 }])).toThrow(
      /windowMs/,
    );
    expect(() => new SpendTracker([{ asset: NATIVE_SOL, limit: 1n, windowMs: -5 }])).toThrow(
      /windowMs/,
    );
  });
});

describe('SpendTracker persistence', () => {
  it('round-trips state through toJSON/fromJSON', () => {
    let time = 1_000;
    const tracker = new SpendTracker(
      [
        { asset: NATIVE_SOL, limit: 100n, windowMs: 3_600_000 },
        { asset: USDC_DEVNET, limit: '5' },
      ],
      { now: () => time },
    );
    tracker.reserve(NATIVE_SOL, 60n);
    tracker.reserve(USDC_DEVNET, 1_000_000n);
    tracker.takeWarnings(NATIVE_SOL); // fires 50%

    const snapshot = JSON.parse(JSON.stringify(tracker.toJSON()));
    const restored = SpendTracker.fromJSON(snapshot, { now: () => time });

    expect(restored.spent(NATIVE_SOL)).toBe(60n);
    expect(restored.limit(NATIVE_SOL)).toBe(100n);
    expect(restored.spent(USDC_DEVNET)).toBe(1_000_000n);
    // 50% warning already fired before the snapshot - must not fire again
    expect(restored.takeWarnings(NATIVE_SOL)).toHaveLength(0);
    // caps still enforced
    expect(() => restored.reserve(NATIVE_SOL, 41n)).toThrow(SpendLimitError);

    // window semantics survive: aging out frees the budget
    time += 3_600_001;
    expect(restored.spent(NATIVE_SOL)).toBe(0n);
  });

  it('rejects unknown snapshot versions', () => {
    expect(() => SpendTracker.fromJSON({ version: 2 as never, ledgers: [] })).toThrow(/version/);
  });
});

describe('SpendTracker snapshot validation (untrusted input)', () => {
  function snapshotWithSpend(): SpendTrackerSnapshot {
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: 100n }]);
    tracker.record(NATIVE_SOL, 60n);
    return JSON.parse(JSON.stringify(tracker.toJSON())) as SpendTrackerSnapshot;
  }

  it('rejects a negative entry amount (would under-report spend)', () => {
    const snap = snapshotWithSpend();
    snap.ledgers[0]!.entries[0]!.amount = '-1000';
    expect(() => SpendTracker.fromJSON(snap)).toThrow(/negative/);
  });

  it('rejects a non-integer entry amount', () => {
    const snap = snapshotWithSpend();
    snap.ledgers[0]!.entries[0]!.amount = '1.5';
    expect(() => SpendTracker.fromJSON(snap)).toThrow(/non-integer/);
  });

  it('rejects a non-positive windowMs (would age out all spend)', () => {
    const snap = snapshotWithSpend();
    snap.ledgers[0]!.windowMs = 0;
    expect(() => SpendTracker.fromJSON(snap)).toThrow(/windowMs/);
  });

  it('rejects a malformed ledgers container', () => {
    expect(() => SpendTracker.fromJSON({ version: 1, ledgers: 'nope' } as never)).toThrow(
      /ledgers/,
    );
  });

  it('re-keys ledgers from the asset so a tampered key cannot orphan spend', () => {
    const snap = snapshotWithSpend();
    snap.ledgers[0]!.key = 'solana:evil'; // tampered to dodge the assetKey lookup
    const restored = SpendTracker.fromJSON(snap);
    expect(restored.spent(NATIVE_SOL)).toBe(60n); // still enforced under the true key
  });
});
