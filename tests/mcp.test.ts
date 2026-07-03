import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { USDC_DEVNET } from '../src/core/assets.js';
import type { WalletTool } from '../src/core/tools.js';
import { encryptSecret } from '../src/keystore.js';
import { runMcpServer, walletFromEnv } from '../src/mcp.js';
import { SolanaWallet } from '../src/solana/wallet.js';

const echoTool: WalletTool = {
  name: 'echo',
  description: 'Echo the input back.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: async (input) => `echo: ${String(input.text)}`,
};

const failTool: WalletTool = {
  name: 'fail',
  description: 'Always fails.',
  parameters: { type: 'object', properties: {} },
  execute: async () => 'Error: something broke',
};

/** Drive the server with raw JSON-RPC lines; returns parsed responses. */
async function drive(lines: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = runMcpServer({
    name: 'test-wallet',
    version: '0.0.1',
    tools: [echoTool, failTool],
    input,
    output,
  });
  for (const line of lines) {
    input.write(`${JSON.stringify(line)}\n`);
  }
  input.write('not-json\n');
  input.end();
  await done;
  const raw = output.read()?.toString() ?? '';
  return raw
    .split('\n')
    .filter((line: string) => line.trim().length > 0)
    .map((line: string) => JSON.parse(line) as Record<string, unknown>);
}

describe('runMcpServer', () => {
  it('speaks the MCP tools surface end-to-end', async () => {
    const responses = await drive([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test' } },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: 'hi' } },
      },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fail', arguments: {} } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } },
      { jsonrpc: '2.0', id: 6, method: 'no/such/method' },
      { jsonrpc: '2.0', id: 7, method: 'ping' },
    ]);

    const byId = new Map(responses.map((r) => [r.id, r]));

    const init = byId.get(1)!.result as Record<string, unknown>;
    expect(init.protocolVersion).toBe('2025-03-26'); // echoes older client versions
    expect((init.serverInfo as Record<string, unknown>).name).toBe('test-wallet');

    const list = byId.get(2)!.result as { tools: { name: string; inputSchema: unknown }[] };
    expect(list.tools.map((t) => t.name)).toEqual(['echo', 'fail']);
    expect(list.tools[0]!.inputSchema).toMatchObject({ type: 'object' });

    const call = byId.get(3)!.result as { content: { text: string }[]; isError: boolean };
    expect(call.content[0]!.text).toBe('echo: hi');
    expect(call.isError).toBe(false);

    const failed = byId.get(4)!.result as { isError: boolean };
    expect(failed.isError).toBe(true);

    expect((byId.get(5)!.error as Record<string, unknown>).code).toBe(-32602);
    expect((byId.get(6)!.error as Record<string, unknown>).code).toBe(-32601);
    expect(byId.get(7)!.result).toEqual({});

    // the malformed line produced a parse error with a null id
    const parseError = responses.find((r) => r.id === null);
    expect((parseError!.error as Record<string, unknown>).code).toBe(-32700);

    // the notification got no response
    expect(responses).toHaveLength(8);
  });
});

describe('walletFromEnv', () => {
  it('builds a guarded wallet from environment variables', async () => {
    const source = await SolanaWallet.generate();
    const { wallet, tools } = await walletFromEnv({
      ELISYM_WALLET_SECRET: source.exportBase58(),
      ELISYM_WALLET_NETWORK: 'devnet',
      ELISYM_WALLET_SPEND_LIMIT: '0.5',
      ELISYM_WALLET_SPEND_WINDOW_HOURS: '24',
      ELISYM_WALLET_MAX_PER_TRANSFER: '0.1',
      ELISYM_WALLET_USDC: '1',
    });
    expect(wallet.address).toBe(source.address);
    expect(wallet.spendTracker.limit(wallet.nativeAsset)).toBe(500_000_000n);
    expect(wallet.spendTracker.status()[0]!.windowMs).toBe(86_400_000);
    expect(tools.map((t) => t.name)).toContain('transfer_token');
  });

  it('applies USDC spend and per-transfer caps from the environment', async () => {
    const source = await SolanaWallet.generate();
    const { wallet } = await walletFromEnv({
      ELISYM_WALLET_SECRET: source.exportBase58(),
      ELISYM_WALLET_NETWORK: 'devnet',
      ELISYM_WALLET_USDC_SPEND_LIMIT: '100',
      ELISYM_WALLET_USDC_MAX_PER_TRANSFER: '25',
      ELISYM_WALLET_USDC: '1',
    });
    // USDC now has its own cap instead of being silently unbounded
    expect(wallet.spendTracker.limit(USDC_DEVNET)).toBe(100_000_000n); // 100 * 1e6
    const stranger = await SolanaWallet.generate();
    expect(() => wallet.checkTransfer(USDC_DEVNET, '30', stranger.address)).toThrow(
      /per-transfer cap/,
    );
    expect(() => wallet.checkTransfer(USDC_DEVNET, '20', stranger.address)).not.toThrow();
  });

  it('decrypts an encrypted secret with the passphrase', async () => {
    const source = await SolanaWallet.generate();
    const { wallet } = await walletFromEnv({
      ELISYM_WALLET_SECRET: encryptSecret(source.exportBase58(), 'pass'),
      ELISYM_WALLET_PASSPHRASE: 'pass',
    });
    expect(wallet.address).toBe(source.address);
  });

  it('fails clearly without a secret or passphrase', async () => {
    await expect(walletFromEnv({})).rejects.toThrow(/No wallet secret configured/);
    const source = await SolanaWallet.generate();
    await expect(
      walletFromEnv({ ELISYM_WALLET_SECRET: encryptSecret(source.exportBase58(), 'pass') }),
    ).rejects.toThrow(/ELISYM_WALLET_PASSPHRASE/);
  });

  it('validates network and rate limit formats', async () => {
    const source = await SolanaWallet.generate();
    const secret = source.exportBase58();
    await expect(
      walletFromEnv({ ELISYM_WALLET_SECRET: secret, ELISYM_WALLET_NETWORK: 'sepolia' }),
    ).rejects.toThrow(/Invalid ELISYM_WALLET_NETWORK/);
    await expect(
      walletFromEnv({ ELISYM_WALLET_SECRET: secret, ELISYM_WALLET_RATE_LIMIT: 'often' }),
    ).rejects.toThrow(/Invalid ELISYM_WALLET_RATE_LIMIT/);
  });

  it('reads the secret from a file, trimming whitespace', async () => {
    const source = await SolanaWallet.generate();
    const file = join(tmpdir(), `elisym-wallet-test-${Math.random().toString(36).slice(2)}.key`);
    await writeFile(file, `${source.exportBase58()}\n`);
    try {
      const { wallet } = await walletFromEnv({ ELISYM_WALLET_SECRET_FILE: file });
      expect(wallet.address).toBe(source.address);
    } finally {
      await rm(file, { force: true });
    }
  });

  it('wires the allowlist into the policy and validates its entries', async () => {
    const source = await SolanaWallet.generate();
    const approved = await SolanaWallet.generate();
    const stranger = await SolanaWallet.generate();

    // valid allowlist: transfers to strangers are rejected by policy
    const { wallet } = await walletFromEnv({
      ELISYM_WALLET_SECRET: source.exportBase58(),
      ELISYM_WALLET_ALLOWED_RECIPIENTS: ` ${approved.address} , `,
    });
    expect(() => wallet.checkTransfer(wallet.nativeAsset, 1n, approved.address)).not.toThrow();
    expect(() => wallet.checkTransfer(wallet.nativeAsset, 1n, stranger.address)).toThrow(
      /not on the wallet's allowlist/,
    );

    // malformed entries are rejected at startup, not silently ignored
    await expect(
      walletFromEnv({
        ELISYM_WALLET_SECRET: source.exportBase58(),
        ELISYM_WALLET_ALLOWED_RECIPIENTS: 'not-an-address',
      }),
    ).rejects.toThrow(/invalid address/);
  });

  it('ELISYM_WALLET_CONFIRM=0 removes the two-step confirmation from tools', async () => {
    const source = await SolanaWallet.generate();
    const { tools } = await walletFromEnv({
      ELISYM_WALLET_SECRET: source.exportBase58(),
      ELISYM_WALLET_CONFIRM: '0',
    });
    const transfer = tools.find((t) => t.name === 'transfer_sol')!;
    const properties = (transfer.parameters as { properties: Record<string, unknown> }).properties;
    expect(properties.confirm_nonce).toBeUndefined();
    expect(transfer.description).not.toContain('TWO-STEP');
  });
});
