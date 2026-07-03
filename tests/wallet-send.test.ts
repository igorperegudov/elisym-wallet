/**
 * Success-path tests for transfers. The network send is mocked at the kit
 * boundary (sendAndConfirmTransactionFactory), but everything up to it is
 * real: guardrails, instruction assembly (system transfer, ATA creation,
 * checked token transfer, memo), message compilation, and Ed25519 signing.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@solana/kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/kit')>();
  return {
    ...actual,
    createSolanaRpcSubscriptions: vi.fn(() => ({}) as never),
    sendAndConfirmTransactionFactory: vi.fn(() => async () => {}),
  };
});

import { sendAndConfirmTransactionFactory } from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { NATIVE_SOL, USDC_DEVNET } from '../src/core/assets.js';
import { PolicyViolationError } from '../src/core/policy.js';
import { SpendLimitError, SpendTracker } from '../src/core/spend-limits.js';
import { SolanaWallet } from '../src/solana/wallet.js';

// 32 zero bytes in base58 - a structurally valid blockhash.
const BLOCKHASH = '11111111111111111111111111111111';

function fakeRpc(overrides: Record<string, unknown> = {}): Rpc<SolanaRpcApi> {
  return {
    getLatestBlockhash: () => ({
      send: async () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    }),
    // Default: the recipient token account does not exist yet, so a token
    // transfer creates it and pays ATA rent.
    getAccountInfo: () => ({ send: async () => ({ value: null }) }),
    ...overrides,
  } as unknown as Rpc<SolanaRpcApi>;
}

// Fee (5000) + new-ATA rent (2039280) charged against the SOL cap per token
// transfer that creates the recipient account.
const TOKEN_SOL_COST = 2_044_280n;

describe('transfer success path', () => {
  it('signs, sends, keeps the reservation, and reports warnings', async () => {
    const wallet = await SolanaWallet.generate({
      rpc: fakeRpc(),
      spendLimits: [{ asset: NATIVE_SOL, limit: '1' }],
    });
    const other = await SolanaWallet.generate();

    const result = await wallet.transferSol({ to: other.address, amount: '0.5', memo: 'job #1' });

    expect(result.signature.length).toBeGreaterThan(30); // real base58 Ed25519 signature
    expect(result.explorerUrl).toContain(result.signature);
    // 0.5 of 1 SOL crosses the 50% threshold exactly once
    expect(result.spendWarnings).toHaveLength(1);
    expect(result.spendWarnings[0]).toContain('50%');
    // a confirmed transfer KEEPS its reservation (only failures release)
    expect(wallet.spendTracker.spent(NATIVE_SOL)).toBe(500_000_000n);

    // second transfer produces a fresh signature and the 80% warning
    const second = await wallet.transferSol({ to: other.address, amount: '0.4' });
    expect(second.signature).not.toBe(result.signature);
    expect(second.spendWarnings[0]).toContain('80%');
    expect(wallet.spendTracker.spent(NATIVE_SOL)).toBe(900_000_000n);
  });

  it('assembles and signs an SPL token transfer (ATA + checked transfer + memo)', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    const other = await SolanaWallet.generate();

    const result = await wallet.transferToken({
      to: other.address,
      asset: USDC_DEVNET,
      amount: '1.25',
      memo: 'invoice 7',
    });

    expect(result.signature.length).toBeGreaterThan(30);
    expect(wallet.spendTracker.spent(USDC_DEVNET)).toBe(1_250_000n);
    // creating the recipient ATA charges fee + rent against the SOL cap
    expect(wallet.spendTracker.spent(NATIVE_SOL)).toBe(TOKEN_SOL_COST);
  });

  it('charges only the tx fee against SOL when the recipient ATA already exists', async () => {
    const wallet = await SolanaWallet.generate({
      rpc: fakeRpc({ getAccountInfo: () => ({ send: async () => ({ value: { lamports: 1n } }) }) }),
    });
    const other = await SolanaWallet.generate();

    await wallet.transferToken({ to: other.address, asset: USDC_DEVNET, amount: '1' });
    // no ATA creation -> only the 5000-lamport fee, not the rent
    expect(wallet.spendTracker.spent(NATIVE_SOL)).toBe(5_000n);
  });

  it('counts token-transfer SOL cost against the SOL cap (blocks ATA-rent drain)', async () => {
    const wallet = await SolanaWallet.generate({
      rpc: fakeRpc(), // recipient ATA missing -> each transfer pays fee + rent
      spendLimits: [{ asset: NATIVE_SOL, limit: 3_000_000n }], // ~0.003 SOL
    });
    const a = await SolanaWallet.generate();
    const b = await SolanaWallet.generate();

    // first token transfer costs TOKEN_SOL_COST (< cap) -> allowed
    await wallet.transferToken({ to: a.address, asset: USDC_DEVNET, amount: '1' });
    expect(wallet.spendTracker.spent(NATIVE_SOL)).toBe(TOKEN_SOL_COST);

    // second would need another TOKEN_SOL_COST, pushing past the 0.003 SOL cap
    await expect(
      wallet.transferToken({ to: b.address, asset: USDC_DEVNET, amount: '1' }),
    ).rejects.toThrow(SpendLimitError);

    // the rejected transfer released BOTH of its reservations
    expect(wallet.spendTracker.spent(NATIVE_SOL)).toBe(TOKEN_SOL_COST);
    expect(wallet.spendTracker.spent(USDC_DEVNET)).toBe(1_000_000n);
  });

  it('KEEPS the reservation when confirmation fails after broadcast (ambiguous outcome)', async () => {
    // A confirmation timeout / websocket drop throws AFTER the transaction may
    // already have landed on-chain. Releasing here would let that landed spend
    // be made a second time against the cap, so the reservation must stand.
    vi.mocked(sendAndConfirmTransactionFactory).mockReturnValueOnce((async () => {
      throw new Error('confirmation timed out');
    }) as never);

    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: '1' }]);
    const persistedSpend: bigint[] = [];
    const wallet = await SolanaWallet.generate({
      rpc: fakeRpc(),
      spendTracker: tracker,
      onSpendChange: () => {
        persistedSpend.push(tracker.spent(NATIVE_SOL));
      },
    });
    const other = await SolanaWallet.generate();

    await expect(wallet.transferSol({ to: other.address, amount: '0.5' })).rejects.toThrow(
      /confirmation timed out/,
    );
    // reservation retained despite the failure
    expect(tracker.spent(NATIVE_SOL)).toBe(500_000_000n);
    // and it was persisted write-ahead, before the (doomed) broadcast
    expect(persistedSpend).toContain(500_000_000n);
  });

  it('RELEASES the reservation when the transaction fails before broadcast', async () => {
    // getLatestBlockhash fails, so nothing was ever signed or sent: the budget
    // must be returned.
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: '1' }]);
    const wallet = await SolanaWallet.generate({
      rpc: {
        getLatestBlockhash: () => ({
          send: async () => {
            throw new Error('rpc unavailable');
          },
        }),
      } as unknown as Rpc<SolanaRpcApi>,
      spendTracker: tracker,
    });
    const other = await SolanaWallet.generate();

    await expect(wallet.transferSol({ to: other.address, amount: '0.5' })).rejects.toThrow(
      /rpc unavailable/,
    );
    expect(tracker.spent(NATIVE_SOL)).toBe(0n);
  });

  it('aborts the transfer when the write-ahead persist fails (fail-closed)', async () => {
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: '1' }]);
    const wallet = await SolanaWallet.generate({
      rpc: fakeRpc(),
      spendTracker: tracker,
      onSpendChange: () => {
        throw new Error('disk full');
      },
    });
    const other = await SolanaWallet.generate();

    await expect(wallet.transferSol({ to: other.address, amount: '0.5' })).rejects.toThrow(
      /disk full/,
    );
    // the reservation is rolled back: we could not durably record it, so we did
    // not broadcast
    expect(tracker.spent(NATIVE_SOL)).toBe(0n);
  });

  it('counts only admitted transfers against the policy rate limit', async () => {
    const wallet = await SolanaWallet.generate({
      rpc: fakeRpc(),
      policy: { rateLimit: { maxTransfers: 1, windowSecs: 3600 } },
    });
    const other = await SolanaWallet.generate();

    await wallet.transferSol({ to: other.address, amount: '0.1' });
    await expect(wallet.transferSol({ to: other.address, amount: '0.1' })).rejects.toThrow(
      PolicyViolationError,
    );
  });
});
