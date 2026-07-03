import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { NATIVE_SOL, USDC_DEVNET } from '../src/core/assets.js';
import { PolicyViolationError } from '../src/core/policy.js';
import { SpendLimitError, SpendTracker } from '../src/core/spend-limits.js';
import { SolanaWallet } from '../src/solana/wallet.js';

/** Minimal fake RPC: only the methods the tests exercise. */
function fakeRpc(overrides: Record<string, unknown> = {}): Rpc<SolanaRpcApi> {
  return {
    getBalance: () => ({ send: async () => ({ value: 1_500_000_000n }) }),
    getTokenAccountsByOwner: () => ({
      send: async () => ({
        value: [
          { account: { data: { parsed: { info: { tokenAmount: { amount: '2500000' } } } } } },
          { account: { data: { parsed: { info: { tokenAmount: { amount: '500000' } } } } } },
        ],
      }),
    }),
    getAccountInfo: () => ({ send: async () => ({ value: null }) }),
    ...overrides,
  } as unknown as Rpc<SolanaRpcApi>;
}

describe('SolanaWallet', () => {
  it('generates a wallet and restores it from exported bytes', async () => {
    const wallet = await SolanaWallet.generate();
    const restored = await SolanaWallet.fromSecretKeyBytes(wallet.exportSecretKeyBytes());
    expect(restored.address).toBe(wallet.address);
  });

  it('restores a wallet from base58', async () => {
    const wallet = await SolanaWallet.generate();
    const restored = await SolanaWallet.fromBase58(wallet.exportBase58());
    expect(restored.address).toBe(wallet.address);
  });

  it('defaults to mainnet-beta', async () => {
    const wallet = await SolanaWallet.generate();
    expect(wallet.network).toBe('mainnet-beta');
  });

  it('zeroes exported bytes after scrub()', async () => {
    const wallet = await SolanaWallet.generate();
    wallet.scrub();
    expect(wallet.exportSecretKeyBytes()).toEqual(new Uint8Array(64));
  });

  it('reads the SOL balance in lamports', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    expect(await wallet.getBalance()).toBe(1_500_000_000n);
  });

  it('sums token balances across accounts', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    expect(await wallet.getTokenBalance(USDC_DEVNET)).toBe(3_000_000n);
  });

  it('returns 0n when no token account exists', async () => {
    const rpc = fakeRpc({
      getTokenAccountsByOwner: () => ({ send: async () => ({ value: [] }) }),
    });
    const wallet = await SolanaWallet.generate({ rpc });
    expect(await wallet.getTokenBalance(USDC_DEVNET)).toBe(0n);
  });

  it('rejects getTokenBalance for assets without a mint', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    await expect(
      wallet.getTokenBalance({ chain: 'solana', token: 'sol', decimals: 9, symbol: 'SOL' }),
    ).rejects.toThrow(/no mint/);
  });

  it('rejects transfers to invalid addresses before touching the network', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    await expect(wallet.transferSol({ to: 'not-an-address', amount: '0.1' })).rejects.toThrow(
      /not a valid Solana address/,
    );
  });

  it('rejects zero-amount transfers before touching the network', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    const other = await SolanaWallet.generate();
    await expect(wallet.transferSol({ to: other.address, amount: '0' })).rejects.toThrow(
      /must be positive/,
    );
    await expect(
      wallet.transferToken({ to: other.address, asset: USDC_DEVNET, amount: 0n }),
    ).rejects.toThrow(/must be positive/);
  });

  it('rejects token transfers for assets without a mint', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    const other = await SolanaWallet.generate();
    await expect(
      wallet.transferToken({
        to: other.address,
        asset: { chain: 'solana', token: 'sol', decimals: 9, symbol: 'SOL' },
        amount: 1n,
      }),
    ).rejects.toThrow(/no mint/);
  });

  it('builds explorer URLs for the configured network', async () => {
    const devnet = await SolanaWallet.generate({ network: 'devnet' });
    expect(devnet.explorerUrl('sig123')).toBe(
      'https://explorer.solana.com/tx/sig123?cluster=devnet',
    );
    const mainnet = await SolanaWallet.generate(); // mainnet-beta is the default
    expect(mainnet.explorerUrl('sig123')).toBe('https://explorer.solana.com/tx/sig123');
  });
});

describe('SolanaWallet spend limits', () => {
  it('rejects a transfer that would exceed the session cap before touching the network', async () => {
    const rpc = fakeRpc({
      getLatestBlockhash: () => {
        throw new Error('network must not be touched');
      },
    });
    const wallet = await SolanaWallet.generate({
      rpc,
      spendLimits: [{ asset: NATIVE_SOL, limit: '0.5' }],
    });
    const other = await SolanaWallet.generate();
    await expect(wallet.transferSol({ to: other.address, amount: '0.6' })).rejects.toThrow(
      SpendLimitError,
    );
    // nothing was reserved by the failed attempt
    expect(wallet.spendTracker.spent(NATIVE_SOL)).toBe(0n);
  });

  it('releases the reservation when the send fails', async () => {
    const rpc = fakeRpc({
      getLatestBlockhash: () => ({
        send: async () => {
          throw new Error('rpc down');
        },
      }),
    });
    const wallet = await SolanaWallet.generate({
      rpc,
      spendLimits: [{ asset: NATIVE_SOL, limit: '1' }],
    });
    const other = await SolanaWallet.generate();
    await expect(wallet.transferSol({ to: other.address, amount: '0.4' })).rejects.toThrow(
      /rpc down/,
    );
    expect(wallet.spendTracker.spent(NATIVE_SOL)).toBe(0n);
    expect(wallet.spendTracker.remaining(NATIVE_SOL)).toBe(1_000_000_000n);
  });

  it('caps SPL token transfers independently of SOL', async () => {
    const rpc = fakeRpc({
      getLatestBlockhash: () => {
        throw new Error('network must not be touched');
      },
    });
    const wallet = await SolanaWallet.generate({
      rpc,
      spendLimits: [{ asset: USDC_DEVNET, limit: '10' }],
    });
    const other = await SolanaWallet.generate();
    await expect(
      wallet.transferToken({ to: other.address, asset: USDC_DEVNET, amount: '10.01' }),
    ).rejects.toThrow(SpendLimitError);
    expect(wallet.spendTracker.spent(USDC_DEVNET)).toBe(0n);
  });

  it('shares one budget across wallets via a shared tracker', async () => {
    const rpc = fakeRpc({
      getLatestBlockhash: () => {
        throw new Error('network must not be touched');
      },
    });
    const shared = new SpendTracker([{ asset: NATIVE_SOL, limit: 100n }]);
    const a = await SolanaWallet.generate({ rpc, spendTracker: shared });
    const b = await SolanaWallet.generate({ rpc, spendTracker: shared });
    const other = await SolanaWallet.generate();

    shared.record(NATIVE_SOL, 100n); // budget fully consumed elsewhere
    await expect(a.transferSol({ to: other.address, amount: 1n })).rejects.toThrow(SpendLimitError);
    await expect(b.transferSol({ to: other.address, amount: 1n })).rejects.toThrow(SpendLimitError);
  });
});

describe('SolanaWallet policy', () => {
  const noNetworkRpc = () =>
    fakeRpc({
      getLatestBlockhash: () => {
        throw new Error('network must not be touched');
      },
    });

  it('rejects recipients outside the allowlist before signing', async () => {
    const approved = await SolanaWallet.generate();
    const wallet = await SolanaWallet.generate({
      rpc: noNetworkRpc(),
      policy: { allowedRecipients: [approved.address] },
    });
    const stranger = await SolanaWallet.generate();
    await expect(wallet.transferSol({ to: stranger.address, amount: '0.1' })).rejects.toThrow(
      PolicyViolationError,
    );
    // policy rejection must not consume spend budget
    expect(wallet.spendTracker.spent(NATIVE_SOL)).toBe(0n);
  });

  it('enforces per-transfer caps', async () => {
    const wallet = await SolanaWallet.generate({
      rpc: noNetworkRpc(),
      policy: { maxPerTransfer: [{ asset: NATIVE_SOL, limit: '0.1' }] },
    });
    const other = await SolanaWallet.generate();
    await expect(wallet.transferSol({ to: other.address, amount: '0.2' })).rejects.toThrow(
      /per-transfer cap/,
    );
  });

  it('enforces the transfer rate limit only on admitted transfers', async () => {
    const wallet = await SolanaWallet.generate({
      rpc: noNetworkRpc(),
      policy: { rateLimit: { maxTransfers: 1, windowSecs: 3600 } },
    });
    const other = await SolanaWallet.generate();
    // first transfer is admitted by policy, then fails at the network layer
    await expect(wallet.transferSol({ to: other.address, amount: '0.1' })).rejects.toThrow(
      /network must not be touched/,
    );
    // second transfer trips the rate limit (the first was admitted)
    await expect(wallet.transferSol({ to: other.address, amount: '0.1' })).rejects.toThrow(
      PolicyViolationError,
    );
  });
});

describe('SolanaWallet extended surface', () => {
  it('validates memos before touching the network', async () => {
    const rpc = fakeRpc({
      getLatestBlockhash: () => {
        throw new Error('network must not be touched');
      },
    });
    const wallet = await SolanaWallet.generate({ rpc });
    const other = await SolanaWallet.generate();
    await expect(
      wallet.transferSol({ to: other.address, amount: '0.1', memo: '' }),
    ).rejects.toThrow(/memo must not be empty/);
    await expect(
      wallet.transferSol({ to: other.address, amount: '0.1', memo: 'x'.repeat(600) }),
    ).rejects.toThrow(/memo too long/);
  });

  it('computes max transferable SOL with the fee reserve', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    expect(await wallet.getMaxTransferableSol()).toBe(1_500_000_000n - 5_000n);
    const broke = await SolanaWallet.generate({
      rpc: fakeRpc({ getBalance: () => ({ send: async () => ({ value: 100n }) }) }),
    });
    expect(await broke.getMaxTransferableSol()).toBe(0n);
  });

  it('summarizes recent transactions', async () => {
    const rpc = fakeRpc({
      getSignaturesForAddress: () => ({
        send: async () => [
          {
            signature: 'okSig',
            slot: 5n,
            blockTime: 1_700_000_000n,
            err: null,
            memo: 'paid job',
            confirmationStatus: 'finalized',
          },
          {
            signature: 'badSig',
            slot: 4n,
            blockTime: null,
            err: { InstructionError: [0, 'Custom'] },
            memo: null,
            confirmationStatus: 'confirmed',
          },
        ],
      }),
    });
    const wallet = await SolanaWallet.generate({ rpc });
    const txs = await wallet.getRecentTransactions(2);
    expect(txs[0]).toMatchObject({
      signature: 'okSig',
      blockTime: 1_700_000_000,
      err: null,
      memo: 'paid job',
    });
    expect(txs[0]!.explorerUrl).toContain('okSig');
    expect(txs[1]!.err).toContain('InstructionError');
    await expect(wallet.getRecentTransactions(0)).rejects.toThrow(/between 1 and 1000/);
  });

  it('waitForDeposit resolves once the balance reaches the target', async () => {
    let balance = 0n;
    const rpc = fakeRpc({
      getBalance: () => ({ send: async () => ({ value: balance }) }),
    });
    const wallet = await SolanaWallet.generate({ rpc });
    const waiting = wallet.waitForDeposit({ amount: '0.001', pollIntervalMs: 10, timeoutMs: 5000 });
    setTimeout(() => {
      balance = 1_000_000n;
    }, 30);
    await expect(waiting).resolves.toBe(1_000_000n);
  });

  it('waitForDeposit times out with a clear error', async () => {
    const wallet = await SolanaWallet.generate({
      rpc: fakeRpc({ getBalance: () => ({ send: async () => ({ value: 0n }) }) }),
    });
    await expect(
      wallet.waitForDeposit({ amount: 1n, pollIntervalMs: 10, timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
  });

  it('waitForDeposit can be aborted mid-wait', async () => {
    const wallet = await SolanaWallet.generate({
      rpc: fakeRpc({ getBalance: () => ({ send: async () => ({ value: 0n }) }) }),
    });
    const controller = new AbortController();
    const waiting = wallet.waitForDeposit({
      amount: 1n,
      pollIntervalMs: 100,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(waiting).rejects.toThrow(/aborted/);
  });

  it('fromSigner wraps an external signer without secret key access', async () => {
    const inner = await SolanaWallet.generate();
    const wallet = SolanaWallet.fromSigner(inner.signer, { rpc: fakeRpc() });
    expect(wallet.address).toBe(inner.address);
    expect(wallet.canExportSecretKey).toBe(false);
    expect(() => wallet.exportBase58()).toThrow(/external signer/);
    expect(() => wallet.exportSecretKeyBytes()).toThrow(/external signer/);
    // a keypair-backed signer still supports message signing through the wrapper
    const signature = await wallet.signMessage('proof');
    expect(typeof signature).toBe('string');
  });

  it('signMessage rejects signers without message support', async () => {
    const inner = await SolanaWallet.generate();
    const transactionOnlySigner = {
      address: inner.signer.address,
      signTransactions: async () => [],
    };
    const wallet = SolanaWallet.fromSigner(transactionOnlySigner, { rpc: fakeRpc() });
    await expect(wallet.signMessage('proof')).rejects.toThrow(/does not support message signing/);
  });
});
