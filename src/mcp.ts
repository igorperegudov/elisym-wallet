/**
 * MCP (Model Context Protocol) stdio server over wallet tools - Node.js/Bun
 * only, exposed as the '@elisym/wallet/mcp' subpath and the `elisym-wallet
 * mcp` CLI command.
 *
 * Implements the tools-only MCP surface (initialize, tools/list, tools/call,
 * ping) as newline-delimited JSON-RPC 2.0 over stdio - deliberately without
 * the MCP SDK dependency, so the wallet library stays lean. `WalletTool`
 * descriptors already carry exactly what MCP needs: name, description, JSON
 * Schema, and a text-returning execute.
 *
 * `walletFromEnv()` builds a guarded wallet from environment variables, which
 * is how MCP clients (Claude Desktop/Code, Cursor, Windsurf) pass config.
 */

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { NATIVE_SOL, USDC_DEVNET, USDC_MAINNET } from './core/assets.js';
import type { Asset } from './core/assets.js';
import type { WalletPolicy } from './core/policy.js';
import type { SpendLimit, SpendTracker } from './core/spend-limits.js';
import { redactSecrets, walletTools } from './core/tools.js';
import type { WalletTool, WalletToolsOptions } from './core/tools.js';
import { decryptSecret, isEncrypted } from './keystore.js';
import type { SolanaNetwork } from './solana/network.js';
import { SolanaWallet } from './solana/wallet.js';

/** Latest MCP protocol revision this server knows; echoed when the client asks for it or newer. */
const PROTOCOL_VERSION = '2025-06-18';

export interface McpServerOptions {
  /** Server name reported to the client. */
  name: string;
  /** Server version reported to the client. */
  version: string;
  /** Tools to expose, e.g. from `walletTools(wallet)`. */
  tools: WalletTool[];
  /** Input stream. Default: process.stdin. */
  input?: Readable;
  /** Output stream. Default: process.stdout. */
  output?: Writable;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Serve MCP over stdio (newline-delimited JSON-RPC). Resolves when the input
 * stream ends. Everything written to `output` is protocol traffic - log to
 * stderr only.
 */
export async function runMcpServer(options: McpServerOptions): Promise<void> {
  const input: Readable = options.input ?? process.stdin;
  const output: Writable = options.output ?? process.stdout;
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));

  function send(message: Record<string, unknown>): void {
    output.write(`${JSON.stringify(message)}\n`);
  }

  function reply(id: number | string | null, result: Record<string, unknown>): void {
    send({ jsonrpc: '2.0', id, result });
  }

  function replyError(id: number | string | null, code: number, message: string): void {
    // Error text can reach the model (isError responses, surfaced internal
    // errors); redact any secret-bearing URL before it leaves the server.
    send({ jsonrpc: '2.0', id, error: { code, message: redactSecrets(message) } });
  }

  async function handle(request: JsonRpcRequest): Promise<void> {
    const { id, method, params } = request;
    // Notifications (no id) never get a response.
    if (id === undefined || id === null) {
      return;
    }
    switch (method) {
      case 'initialize': {
        const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
        reply(id, {
          protocolVersion: requested < PROTOCOL_VERSION && requested ? requested : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.name, version: options.version },
        });
        return;
      }
      case 'ping': {
        reply(id, {});
        return;
      }
      case 'tools/list': {
        reply(id, {
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          })),
        });
        return;
      }
      case 'tools/call': {
        const name = typeof params?.name === 'string' ? params.name : '';
        const tool = toolsByName.get(name);
        if (!tool) {
          replyError(id, -32602, `Unknown tool: ${name}`);
          return;
        }
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        const text = await tool.execute(args);
        reply(id, {
          content: [{ type: 'text', text }],
          isError: text.startsWith('Error:'),
        });
        return;
      }
      default:
        replyError(id, -32601, `Method not found: ${method}`);
    }
  }

  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      replyError(null, -32700, 'Parse error');
      continue;
    }
    try {
      await handle(request);
    } catch (e) {
      replyError(request.id ?? null, -32603, e instanceof Error ? e.message : String(e));
    }
  }
}

/**
 * Environment variables understood by `walletFromEnv` / `elisym-wallet mcp`:
 *
 *   ELISYM_WALLET_SECRET              base58 secret key, or "encrypted:v1:..." keystore blob
 *   ELISYM_WALLET_SECRET_FILE         path to a file holding the same (wins over SECRET)
 *   ELISYM_WALLET_PASSPHRASE          passphrase for an encrypted secret
 *   ELISYM_WALLET_NETWORK             mainnet-beta (default) | devnet | testnet
 *   ELISYM_WALLET_RPC_URL             custom RPC endpoint
 *   ELISYM_WALLET_SPEND_LIMIT         session/window spend cap in SOL, e.g. "0.5"
 *   ELISYM_WALLET_SPEND_WINDOW_HOURS  makes the SOL and USDC caps rolling windows, e.g. "24"
 *   ELISYM_WALLET_MAX_PER_TRANSFER    per-transfer cap in SOL
 *   ELISYM_WALLET_USDC_SPEND_LIMIT    session/window spend cap in USDC, e.g. "100"
 *   ELISYM_WALLET_USDC_MAX_PER_TRANSFER  per-transfer cap in USDC
 *   ELISYM_WALLET_ALLOWED_RECIPIENTS  comma-separated allowlist of addresses
 *   ELISYM_WALLET_RATE_LIMIT          "N/SECONDS", e.g. "5/60" = 5 transfers per minute
 *   ELISYM_WALLET_USDC                "1" to expose USDC tools for the network
 *   ELISYM_WALLET_CONFIRM             "0" to disable two-step transfer confirmation
 */
export async function walletFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: WalletFromEnvOptions = {},
): Promise<{ wallet: SolanaWallet; tools: WalletTool[] }> {
  let secret = env.ELISYM_WALLET_SECRET;
  if (env.ELISYM_WALLET_SECRET_FILE) {
    secret = (await readFile(env.ELISYM_WALLET_SECRET_FILE, 'utf8')).trim();
  }
  if (!secret) {
    throw new Error(
      'No wallet secret configured. Set ELISYM_WALLET_SECRET (base58 or encrypted:v1:...) ' +
        'or ELISYM_WALLET_SECRET_FILE. Generate one with: elisym-wallet generate',
    );
  }
  if (isEncrypted(secret)) {
    const passphrase = env.ELISYM_WALLET_PASSPHRASE;
    if (!passphrase) {
      throw new Error('Secret is encrypted; set ELISYM_WALLET_PASSPHRASE to decrypt it.');
    }
    secret = decryptSecret(secret, passphrase);
  }

  const network = networkFromEnv(env);
  const spendLimits = spendLimitsFromEnv(env);
  const policy = policyFromEnv(env);

  // A caller-provided tracker (e.g. the CLI's persisted budget) still gets the
  // limits configured in the environment applied on top of its restored state.
  if (options.spendTracker) {
    for (const limit of spendLimits) {
      options.spendTracker.setLimit(limit.asset, limit.limit, limit.windowMs);
    }
  }

  const wallet = await SolanaWallet.fromBase58(secret, {
    network,
    rpcUrl: env.ELISYM_WALLET_RPC_URL,
    spendLimits,
    spendTracker: options.spendTracker,
    policy,
    onSpendChange: options.onSpendChange,
  });

  const toolsOptions: WalletToolsOptions = {
    assets: assetsFromEnv(env, network),
    confirmTransfers: env.ELISYM_WALLET_CONFIRM !== '0',
  };
  return { wallet, tools: walletTools(wallet, toolsOptions) };
}

export interface WalletFromEnvOptions {
  /**
   * Shared/restored spend tracker (e.g. a budget persisted across CLI runs).
   * Limits from the environment are applied to it on top of its state.
   */
  spendTracker?: SpendTracker;
  /**
   * Host hook invoked when the spend tracker changes, forwarded to the wallet
   * so a host (CLI, MCP loop) can persist the budget write-ahead. See
   * `SolanaWalletConfig.onSpendChange`.
   */
  onSpendChange?: () => void | Promise<void>;
}

/** Resolve and validate the network from ELISYM_WALLET_NETWORK. */
export function networkFromEnv(env: Record<string, string | undefined>): SolanaNetwork {
  const network = (env.ELISYM_WALLET_NETWORK ?? 'mainnet-beta') as SolanaNetwork;
  if (!['devnet', 'mainnet-beta', 'testnet'].includes(network)) {
    throw new Error(
      `Invalid ELISYM_WALLET_NETWORK "${network}". Expected devnet, mainnet-beta, or testnet.`,
    );
  }
  return network;
}

/**
 * Parse ELISYM_WALLET_SPEND_LIMIT / _USDC_SPEND_LIMIT / _SPEND_WINDOW_HOURS into
 * spend limits. The window (when set) applies to both the SOL and the USDC cap.
 */
export function spendLimitsFromEnv(env: Record<string, string | undefined>): SpendLimit[] {
  const hasSol = !!env.ELISYM_WALLET_SPEND_LIMIT;
  const hasUsdc = !!env.ELISYM_WALLET_USDC_SPEND_LIMIT;
  if (!hasSol && !hasUsdc) {
    return [];
  }
  const windowHours = env.ELISYM_WALLET_SPEND_WINDOW_HOURS
    ? Number(env.ELISYM_WALLET_SPEND_WINDOW_HOURS)
    : undefined;
  if (windowHours !== undefined && (!Number.isFinite(windowHours) || windowHours <= 0)) {
    throw new Error(
      `Invalid ELISYM_WALLET_SPEND_WINDOW_HOURS "${env.ELISYM_WALLET_SPEND_WINDOW_HOURS}".`,
    );
  }
  const windowMs = windowHours === undefined ? undefined : windowHours * 3_600_000;
  const limits: SpendLimit[] = [];
  if (hasSol) {
    limits.push({ asset: NATIVE_SOL, limit: env.ELISYM_WALLET_SPEND_LIMIT!, windowMs });
  }
  if (hasUsdc) {
    limits.push({
      asset: usdcAssetFor(networkFromEnv(env)),
      limit: env.ELISYM_WALLET_USDC_SPEND_LIMIT!,
      windowMs,
    });
  }
  return limits;
}

/** The USDC asset (mint) for a network. */
function usdcAssetFor(network: SolanaNetwork): Asset {
  return network === 'mainnet-beta' ? USDC_MAINNET : USDC_DEVNET;
}

/** Parse policy-related ELISYM_WALLET_* variables. Undefined when no rule is set. */
export function policyFromEnv(env: Record<string, string | undefined>): WalletPolicy | undefined {
  const policy: WalletPolicy = {};
  const maxPerTransfer: NonNullable<WalletPolicy['maxPerTransfer']> = [];
  if (env.ELISYM_WALLET_MAX_PER_TRANSFER) {
    maxPerTransfer.push({ asset: NATIVE_SOL, limit: env.ELISYM_WALLET_MAX_PER_TRANSFER });
  }
  if (env.ELISYM_WALLET_USDC_MAX_PER_TRANSFER) {
    maxPerTransfer.push({
      asset: usdcAssetFor(networkFromEnv(env)),
      limit: env.ELISYM_WALLET_USDC_MAX_PER_TRANSFER,
    });
  }
  if (maxPerTransfer.length > 0) {
    policy.maxPerTransfer = maxPerTransfer;
  }
  if (env.ELISYM_WALLET_ALLOWED_RECIPIENTS) {
    policy.allowedRecipients = env.ELISYM_WALLET_ALLOWED_RECIPIENTS.split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (env.ELISYM_WALLET_RATE_LIMIT) {
    const match = /^(\d+)\/(\d+)$/.exec(env.ELISYM_WALLET_RATE_LIMIT.trim());
    if (!match) {
      throw new Error(
        `Invalid ELISYM_WALLET_RATE_LIMIT "${env.ELISYM_WALLET_RATE_LIMIT}". ` +
          'Expected "N/SECONDS", e.g. "5/60".',
      );
    }
    policy.rateLimit = { maxTransfers: Number(match[1]), windowSecs: Number(match[2]) };
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}

/** Display/tool assets enabled via ELISYM_WALLET_USDC for the given network. */
export function assetsFromEnv(
  env: Record<string, string | undefined>,
  network: SolanaNetwork,
): Asset[] {
  return env.ELISYM_WALLET_USDC === '1'
    ? [network === 'mainnet-beta' ? USDC_MAINNET : USDC_DEVNET]
    : [];
}
