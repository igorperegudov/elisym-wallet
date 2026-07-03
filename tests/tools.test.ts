import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { NATIVE_SOL, USDC_DEVNET } from '../src/core/assets.js';
import { redactSecrets, walletTools } from '../src/core/tools.js';
import { SolanaWallet } from '../src/solana/wallet.js';

function fakeRpc(overrides: Record<string, unknown> = {}): Rpc<SolanaRpcApi> {
  return {
    getBalance: () => ({ send: async () => ({ value: 1_500_000_000n }) }),
    getTokenAccountsByOwner: () => ({
      send: async () => ({
        value: [
          { account: { data: { parsed: { info: { tokenAmount: { amount: '2500000' } } } } } },
        ],
      }),
    }),
    getSignaturesForAddress: () => ({
      send: async () => [
        {
          signature: 'sig1',
          slot: 100n,
          blockTime: 1_700_000_000n,
          err: null,
          memo: 'job-42',
          confirmationStatus: 'finalized',
        },
      ],
    }),
    getLatestBlockhash: () => ({
      send: async () => {
        throw new Error('network must not be touched');
      },
    }),
    ...overrides,
  } as unknown as Rpc<SolanaRpcApi>;
}

async function toolByName(name: string, wallet: SolanaWallet, options = {}) {
  const tools = walletTools(wallet, options);
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`tool ${name} not found: ${tools.map((t) => t.name).join(', ')}`);
  }
  return tool;
}

describe('walletTools', () => {
  it('exposes SOL-only tools by default and adds transfer_token with assets', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    const base = walletTools(wallet).map((t) => t.name);
    expect(base).toEqual([
      'get_wallet_address',
      'get_balance',
      'transfer_sol',
      'get_recent_transactions',
    ]);
    const withAssets = walletTools(wallet, { assets: [USDC_DEVNET] }).map((t) => t.name);
    expect(withAssets).toContain('transfer_token');
  });

  it('applies the name prefix', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    const names = walletTools(wallet, { namePrefix: 'wallet_' }).map((t) => t.name);
    expect(names).toContain('wallet_get_balance');
  });

  it('returns address and network', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    const tool = await toolByName('get_wallet_address', wallet);
    const out = await tool.execute({});
    expect(out).toContain(wallet.address);
    expect(out).toContain('mainnet-beta');
  });

  it('reports balances and spend status', async () => {
    const wallet = await SolanaWallet.generate({
      rpc: fakeRpc(),
      spendLimits: [{ asset: NATIVE_SOL, limit: '1' }],
    });
    const tool = await toolByName('get_balance', wallet, { assets: [USDC_DEVNET] });
    const out = await tool.execute({});
    expect(out).toContain('SOL balance: 1.5 SOL');
    expect(out).toContain('USDC balance: 2.5 USDC');
    expect(out).toContain('Spend status:');
    expect(out).toContain('1 SOL cap');
  });

  it('lists recent transactions with memos', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    const tool = await toolByName('get_recent_transactions', wallet);
    const out = await tool.execute({});
    expect(out).toContain('sig1');
    expect(out).toContain('Memo: job-42');
    expect(out).toContain('finalized');
  });

  it('previews a transfer first and requires the nonce to execute', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    const other = await SolanaWallet.generate();
    const tool = await toolByName('transfer_sol', wallet);

    const preview = await tool.execute({ to: other.address, amount: '0.1' });
    expect(preview).toContain('NOT yet executed');
    expect(preview).toContain('Amount: 0.1 SOL');
    const nonce = /confirm_nonce="([0-9a-f]+)"/.exec(preview)?.[1];
    expect(nonce).toBeDefined();

    // wrong params with a valid nonce are rejected (and the nonce is consumed)
    const mismatched = await tool.execute({
      to: other.address,
      amount: '99',
      confirm_nonce: nonce,
    });
    expect(mismatched).toContain('does not match');

    // consumed nonce cannot be replayed
    const replay = await tool.execute({ to: other.address, amount: '0.1', confirm_nonce: nonce });
    expect(replay).toContain('invalid or expired');
  });

  it('executes on the second call with the matching nonce', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    const other = await SolanaWallet.generate();
    const tool = await toolByName('transfer_sol', wallet);

    const preview = await tool.execute({ to: other.address, amount: '0.1' });
    const nonce = /confirm_nonce="([0-9a-f]+)"/.exec(preview)?.[1];

    // the fake rpc throws on getLatestBlockhash - proving the confirmed call
    // got past the nonce gate and reached the actual transfer path
    const out = await tool.execute({ to: other.address, amount: '0.1', confirm_nonce: nonce });
    expect(out).toContain('Error: network must not be touched');
  });

  it('expires nonces after the ttl', async () => {
    let time = 0;
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    const other = await SolanaWallet.generate();
    const tool = await toolByName('transfer_sol', wallet, { now: () => time, confirmTtlMs: 1000 });

    const preview = await tool.execute({ to: other.address, amount: '0.1' });
    const nonce = /confirm_nonce="([0-9a-f]+)"/.exec(preview)?.[1];
    time = 2000;
    const out = await tool.execute({ to: other.address, amount: '0.1', confirm_nonce: nonce });
    expect(out).toContain('invalid or expired');
  });

  it('executes immediately when confirmation is disabled', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    const other = await SolanaWallet.generate();
    const tool = await toolByName('transfer_sol', wallet, { confirmTransfers: false });
    const out = await tool.execute({ to: other.address, amount: '0.1' });
    // straight to the transfer path, no preview step
    expect(out).toContain('Error: network must not be touched');
  });

  it('returns validation problems as agent-readable errors', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    const tool = await toolByName('transfer_sol', wallet);
    expect(await tool.execute({ to: 'bad', amount: 'abc' })).toContain('Error:');
    expect(await tool.execute({})).toContain('Error: "to" is required');
  });

  it('resolves tokens by id, mint, or symbol and rejects unknown tokens', async () => {
    const wallet = await SolanaWallet.generate({ rpc: fakeRpc() });
    const other = await SolanaWallet.generate();
    const tool = await toolByName('transfer_token', wallet, { assets: [USDC_DEVNET] });

    const preview = await tool.execute({ to: other.address, token: 'USDC', amount: '1' });
    expect(preview).toContain('Amount: 1 USDC');

    const unknown = await tool.execute({ to: other.address, token: 'wif', amount: '1' });
    expect(unknown).toContain('Unknown token "wif"');
  });

  it('rejects doomed transfers at the preview step (no wasted confirmation round-trip)', async () => {
    const wallet = await SolanaWallet.generate({
      rpc: fakeRpc(),
      spendLimits: [{ asset: NATIVE_SOL, limit: '0.05' }],
      policy: { maxPerTransfer: [{ asset: NATIVE_SOL, limit: '0.04' }] },
    });
    const other = await SolanaWallet.generate();
    const tool = await toolByName('transfer_sol', wallet);

    // policy violation surfaces directly in the preview call
    const policyRejected = await tool.execute({ to: other.address, amount: '0.045' });
    expect(policyRejected).toContain('Error:');
    expect(policyRejected).toContain('per-transfer cap');

    // spend-limit violation too: 0.04 passes the per-transfer cap but, with
    // 0.02 already spent, would push the 0.05 session cap over the line
    wallet.spendTracker.record(NATIVE_SOL, 20_000_000n);
    const capRejected = await tool.execute({ to: other.address, amount: '0.04' });
    expect(capRejected).toContain('would exceed the SOL spend limit');

    // and the rejected previews reserved nothing beyond the seeded 0.02
    expect(wallet.spendTracker.spent(NATIVE_SOL)).toBe(20_000_000n);
  });

  it('redacts RPC secrets from agent-facing error text', async () => {
    const wallet = await SolanaWallet.generate({
      rpc: {
        getBalance: () => ({
          send: async () => {
            throw new Error('fetch failed: https://rpc.example.com/?api-key=do-not-log-this');
          },
        }),
      } as never,
    });
    const tool = await toolByName('get_balance', wallet);
    const out = await tool.execute({});
    expect(out).toContain('Error:');
    expect(out).not.toContain('do-not-log-this');
    expect(out).toContain('[redacted]');
  });

  it('surfaces spend-limit changes between preview and confirm', async () => {
    const wallet = await SolanaWallet.generate({
      rpc: fakeRpc(),
      spendLimits: [{ asset: NATIVE_SOL, limit: '0.15' }],
    });
    const other = await SolanaWallet.generate();
    const tool = await toolByName('transfer_sol', wallet);
    const preview = await tool.execute({ to: other.address, amount: '0.1' });
    expect(preview).toContain('NOT yet executed');
    // budget shrinks between the two steps (e.g. another wallet on a shared tracker)
    wallet.spendTracker.record(NATIVE_SOL, 100_000_000n);
    const nonce = /confirm_nonce="([0-9a-f]+)"/.exec(preview)?.[1];
    const out = await tool.execute({ to: other.address, amount: '0.1', confirm_nonce: nonce });
    expect(out).toContain('would exceed the SOL spend limit');
  });
});

describe('redactSecrets', () => {
  it('strips a query-string API key from an RPC URL', () => {
    expect(redactSecrets('failed to fetch https://rpc.example.com/?api-key=do-not-log boom')).toBe(
      'failed to fetch https://rpc.example.com/[redacted] boom',
    );
  });

  it('strips a path-segment API key from an RPC URL', () => {
    expect(redactSecrets('error at https://solana-mainnet.example.com/v2/do-not-log-this')).toBe(
      'error at https://solana-mainnet.example.com/[redacted]',
    );
  });

  it('strips a key from a ws:// / wss:// subscription URL', () => {
    expect(redactSecrets('subscribe wss://rpc.example.com/?api-key=do-not-log-this failed')).toBe(
      'subscribe wss://rpc.example.com/[redacted] failed',
    );
  });

  it('strips inline user:pass credentials from a URL', () => {
    expect(redactSecrets('connect https://user:pass@host/path')).toBe(
      'connect https://host/[redacted]',
    );
  });

  it('leaves plain messages and bare hosts untouched', () => {
    expect(redactSecrets('Spend limit exceeded for SOL')).toBe('Spend limit exceeded for SOL');
    expect(redactSecrets('cannot reach https://rpc.example.com')).toBe(
      'cannot reach https://rpc.example.com',
    );
  });
});
