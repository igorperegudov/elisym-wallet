/**
 * elisym-wallet CLI logic. The bin entry point is cli-entry.ts; this module
 * exports `runCli` so the command surface is unit-testable without spawning
 * a process.
 *
 * Configuration resolution: ELISYM_WALLET_* environment variables win over
 * the profile at ~/.elisym-wallet/config.json (managed via `config` commands),
 * which wins over defaults. Read-only commands (balance, history, address)
 * use the cached public address when one is available and fall back to
 * decrypting the secret otherwise; `send` always decrypts it, prompting
 * interactively when needed.
 */

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { isAddress } from '@solana/kit';
import {
  assertConfigKey,
  cliPaths,
  CONFIG_KEYS,
  listProfiles,
  loadConfig,
  loadSpendTracker,
  mergedEnv,
  saveConfig,
  saveSpendTracker,
  validateConfigValue,
} from './cli-config.js';
import type { CliConfig, CliPaths, ConfigKey } from './cli-config.js';
import { NATIVE_SOL, formatAmount, parseAmount } from './core/assets.js';
import type { Asset } from './core/assets.js';
import { walletTools } from './core/tools.js';
import { encryptSecret, isEncrypted } from './keystore.js';
import {
  assetsFromEnv,
  networkFromEnv,
  runMcpServer,
  spendLimitsFromEnv,
  walletFromEnv,
} from './mcp.js';
import { SolanaWallet } from './solana/wallet.js';
import type { WalletSigner } from './solana/wallet.js';

const USAGE = `elisym-wallet - a wallet for AI agents

Setup:
  init [--passphrase <p>] [--network <n>]    Guided setup: generate a wallet, save it to
       [--allow-plaintext] [--force]         the profile with safe default spend limits.
                                             Encrypts the secret with --passphrase; storing
                                             it in plaintext needs --allow-plaintext (or an
                                             empty passphrase at the interactive prompt).
                                             --force overwrites an existing wallet.
  generate [--passphrase <p>] [--save]       Create a keypair. Prints the secret; --save
           [--allow-plaintext] [--force]     writes it to the profile instead (encrypted with
                                             --passphrase; plaintext needs --allow-plaintext;
                                             --force replaces an existing secret).
  config list                                Show settings and where each value comes from
                                             (the secret never appears in the output).
  config set <key> <value>                   Update a setting (validated immediately). For the
                                             secret, run "config set secret" with no value to
                                             enter it interactively / via stdin instead of
                                             argv; replacing a stored secret needs --force.
  config get|unset <key> | config path       Inspect or remove a setting; "path" prints
                                             the config file location. The secret is
                                             printed only with an explicit "get --reveal".
  profiles                                   List wallets (default + named profiles).

Wallet:
  address                                    Show the wallet address and network.
  balance                                    Show SOL/token balances and spend budget.
  send <to> <amount> [--token usdc]          Send funds (preview + confirmation).
       [--memo <text>] [--yes]
  history [--limit <n>]                      Recent transactions with memos
                                             (default 10, max 50).

Integration:
  mcp                                        Run as an MCP stdio server for Claude/Cursor.

Every command accepts --profile <name> (or ELISYM_WALLET_PROFILE) to work with a
separate wallet stored at ~/.elisym-wallet/profiles/<name>/. Without it the default
profile at ~/.elisym-wallet/config.json is used. ELISYM_WALLET_CONFIG points at an
explicit config file and wins over both; ELISYM_WALLET_HOME relocates the base dir.

Config keys: ${Object.keys(CONFIG_KEYS).join(', ')}
Every key can also be set via its ELISYM_WALLET_* environment variable
(environment overrides the profile).

Security: values passed on the command line land in your shell history and are
visible to other local users via the process list. Prefer entering the secret
interactively ("config set secret" with no value) and setting the passphrase via
ELISYM_WALLET_PASSPHRASE or the interactive prompt rather than --passphrase.`;

function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/** Flags that take a value; everything else starting with -- is boolean. */
const VALUE_FLAGS = new Set([
  '--passphrase',
  '--network',
  '--token',
  '--memo',
  '--limit',
  '--profile',
]);

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a value.`);
      }
      flags.set(arg, value);
      i += 1;
    } else {
      flags.set(arg, true);
    }
  }
  return { positional, flags };
}

/**
 * Read one line interactively. `hidden` mutes the echo (passphrases).
 * Refuses on non-TTY stdin with a hint at the non-interactive alternative.
 */
function promptLine(question: string, hidden: boolean, nonTtyHint: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error(`Interactive input required but stdin is not a TTY. ${nonTtyHint}`));
      return;
    }
    let muted = false;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        if (!muted) {
          process.stdout.write(chunk as Buffer);
        }
        callback();
      },
    });
    // historySize: 0 keeps the typed secret/passphrase out of readline's
    // in-memory history array (muting only suppresses echo, not history).
    const rl = createInterface({
      input: process.stdin,
      output,
      terminal: true,
      historySize: 0,
    });
    rl.question(question, (answer) => {
      rl.close();
      if (muted) {
        process.stdout.write('\n');
      }
      resolve(answer);
    });
    muted = hidden;
  });
}

/**
 * Read a secret key without putting it on the command line (which would leak it
 * into shell history and the process list). Uses a hidden interactive prompt on
 * a TTY, otherwise reads it from stdin (for piping).
 */
async function readSecretInput(): Promise<string> {
  if (process.stdin.isTTY) {
    const value = await promptLine(
      'Secret key (base58 or encrypted:v1:...): ',
      true,
      'Pipe the secret via stdin, e.g. `... | elisym-wallet config set secret`.',
    );
    return value.trim();
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

/**
 * Ensure a decryptable secret is reachable, prompting for the passphrase if
 * needed. Mirrors walletFromEnv's precedence (ELISYM_WALLET_SECRET_FILE wins
 * over ELISYM_WALLET_SECRET) so the prompt decision is made against the
 * secret that will actually be used.
 */
async function ensurePassphrase(
  env: Record<string, string | undefined>,
): Promise<Record<string, string | undefined>> {
  let secret = env.ELISYM_WALLET_SECRET;
  if (env.ELISYM_WALLET_SECRET_FILE) {
    try {
      secret = (await readFile(env.ELISYM_WALLET_SECRET_FILE, 'utf8')).trim();
    } catch {
      // Unreadable file: skip the prompt and let walletFromEnv surface the
      // actual read error with context.
      return env;
    }
  }
  if (!secret || !isEncrypted(secret) || env.ELISYM_WALLET_PASSPHRASE) {
    return env;
  }
  const passphrase = await promptLine(
    'Passphrase: ',
    true,
    'Set ELISYM_WALLET_PASSPHRASE instead.',
  );
  return { ...env, ELISYM_WALLET_PASSPHRASE: passphrase };
}

interface CliContext {
  env: Record<string, string | undefined>;
  merged: Record<string, string | undefined>;
  paths: CliPaths;
  config: CliConfig;
}

async function context(env: Record<string, string | undefined>): Promise<CliContext> {
  const paths = cliPaths(env);
  const config = await loadConfig(paths);
  return { env, merged: mergedEnv(env, config), paths, config };
}

/**
 * Read-only wallet for balance/history/address: uses the cached public
 * address when available so no passphrase is needed; falls back to
 * decrypting the secret otherwise.
 */
async function readonlyWallet(ctx: CliContext): Promise<SolanaWallet> {
  const tracker = await loadSpendTracker(ctx.paths);
  for (const limit of spendLimitsFromEnv(ctx.merged)) {
    tracker.setLimit(limit.asset, limit.limit, limit.windowMs);
  }
  const address = ctx.merged.ELISYM_WALLET_ADDRESS;
  if (address && isAddress(address)) {
    const signer = { address, signTransactions: async () => [] } as unknown as WalletSigner;
    return SolanaWallet.fromSigner(signer, {
      network: networkFromEnv(ctx.merged),
      rpcUrl: ctx.merged.ELISYM_WALLET_RPC_URL,
      spendTracker: tracker,
    });
  }
  const env = await ensurePassphrase(ctx.merged);
  const { wallet } = await walletFromEnv(env, { spendTracker: tracker });
  // Read-only commands never export the key; drop the in-memory copy so it does
  // not linger in the heap (signing still works via the WebCrypto signer).
  wallet.scrub();
  return wallet;
}

async function runTool(
  wallet: SolanaWallet,
  assets: Asset[],
  name: string,
  input: Record<string, unknown>,
): Promise<number> {
  const tools = walletTools(wallet, { assets, confirmTransfers: false });
  const tool = tools.find((t) => t.name === name)!;
  const text = await tool.execute(input);
  if (text.startsWith('Error:')) {
    console.error(text);
    return 1;
  }
  console.log(text);
  return 0;
}

async function cmdInit(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
  if (ctx.config.secret && !parsed.flags.has('--force')) {
    console.error(
      `A wallet already exists in ${ctx.paths.configFile} (address: ${ctx.config.address ?? 'unknown'}).\n` +
        "Refusing to overwrite the secret - you would lose access to that wallet's funds.\n" +
        'Pass --force only if you are sure.',
    );
    return 1;
  }

  let passphrase = parsed.flags.get('--passphrase') as string | undefined;
  passphrase ??= ctx.env.ELISYM_WALLET_PASSPHRASE;
  if (passphrase === undefined && process.stdin.isTTY) {
    passphrase = await promptLine(
      'Passphrase to encrypt the secret key (empty for none): ',
      true,
      '',
    );
  }
  // Never write the secret in plaintext by default in a non-interactive run:
  // an unattended `init` would otherwise silently store a plaintext key on
  // disk. An interactive user who left the prompt empty chose plaintext.
  if (!passphrase && !parsed.flags.has('--allow-plaintext') && !process.stdin.isTTY) {
    console.error(
      'Refusing to store the secret in plaintext in a non-interactive run. Set a passphrase ' +
        '(--passphrase or ELISYM_WALLET_PASSPHRASE), or pass --allow-plaintext to store it ' +
        'in plaintext deliberately.',
    );
    return 1;
  }

  const network = (parsed.flags.get('--network') as string | undefined) ?? 'mainnet-beta';
  validateConfigValue('network', network);

  const wallet = await SolanaWallet.generate();
  const secret = wallet.exportBase58();

  const config: CliConfig = {
    ...ctx.config,
    secret: passphrase ? encryptSecret(secret, passphrase) : secret,
    address: wallet.address,
    network,
  };
  // Safe defaults for a fresh wallet; existing explicit settings are kept.
  config['spend-limit'] ??= '1';
  config['spend-window-hours'] ??= '24';
  config['max-per-transfer'] ??= '0.5';
  await saveConfig(ctx.paths, config);
  wallet.scrub();

  console.log(`Wallet created and saved to ${ctx.paths.configFile}.`);
  console.log(`  Address: ${config.address}`);
  console.log(`  Network: ${network}`);
  console.log(
    `  Secret: ${passphrase ? 'encrypted with your passphrase' : 'PLAINTEXT (no passphrase given)'}`,
  );
  console.log(
    `  Spend limits: ${config['spend-limit']} SOL per ${config['spend-window-hours']}h, ` +
      `max ${config['max-per-transfer']} SOL per transfer`,
  );
  console.log('');
  console.log('Adjust limits:      elisym-wallet config set spend-limit 0.5');
  console.log('Check balance:      elisym-wallet balance');
  console.log('Fund it, then send: elisym-wallet send <address> 0.1');
  return 0;
}

async function cmdGenerate(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
  const passphrase =
    (parsed.flags.get('--passphrase') as string | undefined) ?? ctx.env.ELISYM_WALLET_PASSPHRASE;
  const wallet = await SolanaWallet.generate();
  const secret = wallet.exportBase58();
  const stored = passphrase ? encryptSecret(secret, passphrase) : secret;

  console.log(`Address: ${wallet.address}`);
  if (parsed.flags.has('--save')) {
    if (!passphrase && !parsed.flags.has('--allow-plaintext')) {
      wallet.scrub();
      console.error(
        'Refusing to save the secret in plaintext. Pass --passphrase (or set ' +
          'ELISYM_WALLET_PASSPHRASE), or --allow-plaintext to store it in plaintext deliberately.',
      );
      return 1;
    }
    if (ctx.config.secret && !parsed.flags.has('--force')) {
      console.error(
        `The profile already holds a secret (address: ${ctx.config.address ?? 'unknown'}). ` +
          'Replacing it means losing access to the old wallet - pass --force only if you are sure.',
      );
      return 1;
    }
    await saveConfig(ctx.paths, { ...ctx.config, secret: stored, address: wallet.address });
    console.log(
      `Secret saved to ${ctx.paths.configFile} (${passphrase ? 'encrypted' : 'PLAINTEXT'}).`,
    );
  } else if (passphrase) {
    console.log(`Secret (encrypted): ${stored}`);
    console.log('Set ELISYM_WALLET_SECRET to the encrypted value and ELISYM_WALLET_PASSPHRASE');
    console.log('to your passphrase, or store THIS wallet in the profile with:');
    console.log('elisym-wallet config set secret   (paste the encrypted value at the prompt)');
  } else {
    console.log(`Secret (base58): ${stored}`);
    console.log('KEEP THIS SECRET SAFE - anyone holding it controls the wallet.');
    console.log('Tip: pass --passphrase to print an encrypted secret instead.');
  }
  wallet.scrub();
  return 0;
}

async function cmdSend(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
  const [to, amount] = parsed.positional;
  if (!to || !amount) {
    console.error('Usage: elisym-wallet send <to> <amount> [--token usdc] [--memo <text>] [--yes]');
    return 1;
  }

  const tracker = await loadSpendTracker(ctx.paths);
  const env = await ensurePassphrase(ctx.merged);
  const { wallet } = await walletFromEnv(env, {
    spendTracker: tracker,
    onSpendChange: () => saveSpendTracker(ctx.paths, tracker),
  });
  // `send` signs via the WebCrypto signer, never the exportable bytes; drop the
  // in-memory secret copy so it does not sit in the heap during the transfer.
  wallet.scrub();

  const token = parsed.flags.get('--token') as string | undefined;
  const memo = parsed.flags.get('--memo') as string | undefined;
  const knownAssets = assetsFromEnv(ctx.merged, wallet.network);
  let asset: Asset = NATIVE_SOL;
  if (token && token.toLowerCase() !== 'sol') {
    const found = knownAssets.find(
      (a) => a.token === token.toLowerCase() || a.mint === token || a.symbol === token,
    );
    if (!found) {
      const hint =
        knownAssets.length === 0
          ? 'Enable USDC with: elisym-wallet config set usdc 1'
          : `Known tokens: sol, ${knownAssets.map((a) => a.token).join(', ')}.`;
      console.error(`Unknown token "${token}". ${hint}`);
      return 1;
    }
    asset = found;
  }

  // Dry-run the guardrails before showing the preview, so a doomed transfer
  // fails immediately with the exact reason.
  wallet.checkTransfer(asset, amount, to);

  console.log('Transfer preview:');
  console.log(`  Amount:    ${amount} ${asset.symbol}`);
  console.log(`  Recipient: ${to}`);
  if (memo) {
    console.log(`  Memo:      ${memo}`);
  }
  console.log(`  Network:   ${wallet.network}`);
  const remaining = wallet.spendTracker.remaining(asset);
  if (remaining !== null) {
    // Subtract this transfer so the figure is the budget AFTER it, matching the
    // label (remaining() is the pre-send budget; nothing is reserved yet).
    const resolved = parseAmount(asset, amount);
    const after = remaining > resolved ? remaining - resolved : 0n;
    console.log(`  Budget after send: ${formatAmount(asset, after)}`);
  }

  if (!parsed.flags.has('--yes')) {
    const answer = await promptLine('Send? (y/N): ', false, 'Pass --yes to skip confirmation.');
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Cancelled.');
      return 1;
    }
  }

  // The spend ledger is persisted write-ahead inside the transfer via the
  // onSpendChange hook wired above, so no explicit save is needed here.
  const result =
    asset === NATIVE_SOL
      ? await wallet.transferSol({ to, amount, memo })
      : await wallet.transferToken({ to, asset, amount, memo });

  for (const warning of result.spendWarnings) {
    console.log(warning);
  }
  console.log('Transfer sent.');
  console.log(`  Signature: ${result.signature}`);
  console.log(`  Explorer:  ${result.explorerUrl}`);
  return 0;
}

async function cmdConfig(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
  const [action, key, value] = parsed.positional;
  switch (action) {
    case 'list': {
      for (const configKey of Object.keys(CONFIG_KEYS) as ConfigKey[]) {
        // The secret never appears in list output - not its value, not even
        // its existence or encryption status. Terminals leak (scrollback,
        // screenshots, screen shares), and "plaintext secret stored here" is
        // actionable intel by itself. Inspect it explicitly via
        // `config get secret --reveal`.
        if (configKey === 'secret') {
          continue;
        }
        const envName = CONFIG_KEYS[configKey];
        const fromEnv = ctx.env[envName];
        const fromFile = ctx.config[configKey];
        const resolved =
          fromEnv ?? fromFile ?? (configKey === 'network' ? 'mainnet-beta' : undefined);
        if (resolved === undefined) {
          continue;
        }
        const source = fromEnv !== undefined ? 'env' : fromFile !== undefined ? 'file' : 'default';
        // padEnd must cover the longest key ('usdc-max-per-transfer', 21 chars).
        console.log(`${configKey.padEnd(22)} ${resolved}  (${source})`);
      }
      return 0;
    }
    case 'get': {
      if (!key) {
        console.error('Usage: elisym-wallet config get <key>');
        return 1;
      }
      assertConfigKey(key);
      const resolved = ctx.merged[CONFIG_KEYS[key]];
      if (resolved === undefined) {
        console.error(`${key} is not set.`);
        return 1;
      }
      if (key === 'secret' && !parsed.flags.has('--reveal')) {
        console.error('The secret is never printed by default. Pass --reveal to output it.');
        return 1;
      }
      console.log(resolved);
      return 0;
    }
    case 'set': {
      if (!key) {
        console.error('Usage: elisym-wallet config set <key> <value>');
        return 1;
      }
      assertConfigKey(key);
      // The secret can be entered interactively / piped via stdin so it never
      // has to appear in argv (shell history, process list). Any other key, and
      // an explicitly supplied secret value, use the positional argument.
      let rawValue = value;
      if (key === 'secret' && (rawValue === undefined || rawValue === '-')) {
        rawValue = await readSecretInput();
      }
      if (rawValue === undefined) {
        console.error('Usage: elisym-wallet config set <key> <value>');
        return 1;
      }
      const normalized = validateConfigValue(key, rawValue);
      const next: CliConfig = { ...ctx.config, [key]: normalized };
      if (key === 'secret') {
        if (ctx.config.secret && !parsed.flags.has('--force')) {
          console.error(
            'The profile already holds a secret. Replacing it means losing access to the old ' +
              'wallet - pass --force only if you are sure.',
          );
          return 1;
        }
        // Cache the public address for passphrase-free reads; derivable only
        // from a plaintext secret. A stale address must never survive.
        delete next.address;
        if (!isEncrypted(normalized)) {
          const wallet = await SolanaWallet.fromBase58(normalized);
          next.address = wallet.address;
          wallet.scrub();
        }
      }
      await saveConfig(ctx.paths, next);
      console.log(`${key} saved to ${ctx.paths.configFile}.`);
      return 0;
    }
    case 'unset': {
      if (!key) {
        console.error('Usage: elisym-wallet config unset <key>');
        return 1;
      }
      assertConfigKey(key);
      const next = { ...ctx.config };
      delete next[key];
      if (key === 'secret') {
        delete next.address;
      }
      await saveConfig(ctx.paths, next);
      console.log(`${key} removed.`);
      return 0;
    }
    case 'path':
      console.log(ctx.paths.configFile);
      return 0;
    default:
      console.error('Usage: elisym-wallet config <list|get|set|unset|path> [key] [value]');
      return 1;
  }
}

async function cmdProfiles(
  env: Record<string, string | undefined>,
  activeConfigFile: string,
): Promise<number> {
  const profiles = await listProfiles(env);
  if (profiles.length === 0) {
    console.log('No wallets found. Create one with: elisym-wallet init [--profile <name>]');
    return 0;
  }
  for (const profile of profiles) {
    const config = await loadConfig({ configFile: profile.configFile, spendFile: '' });
    const address = config.address ?? '(address not cached)';
    const network = config.network ?? 'mainnet-beta';
    const active = profile.configFile === activeConfigFile ? '  (active)' : '';
    console.log(`${profile.name.padEnd(16)} ${address.padEnd(44)} ${network}${active}`);
  }
  return 0;
}

/** Run one CLI invocation. Returns the process exit code. */
export async function runCli(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const [command, ...args] = argv;
  try {
    const parsed = parseArgs(args);
    // --profile is a global flag: it selects the wallet for ANY command.
    const profile = parsed.flags.get('--profile') as string | undefined;
    const effectiveEnv = profile ? { ...env, ELISYM_WALLET_PROFILE: profile } : env;
    const ctx = await context(effectiveEnv);
    switch (command) {
      case 'init':
        return await cmdInit(ctx, parsed);
      case 'generate':
        return await cmdGenerate(ctx, parsed);
      case 'config':
        return await cmdConfig(ctx, parsed);
      case 'profiles':
        return await cmdProfiles(effectiveEnv, ctx.paths.configFile);
      case 'address': {
        const wallet = await readonlyWallet(ctx);
        console.log(`Address: ${wallet.address}`);
        console.log(`Network: ${wallet.network}`);
        return 0;
      }
      case 'balance': {
        const wallet = await readonlyWallet(ctx);
        const assets = assetsFromEnv(ctx.merged, wallet.network);
        return await runTool(wallet, assets, 'get_balance', {});
      }
      case 'history': {
        const wallet = await readonlyWallet(ctx);
        const limitRaw = parsed.flags.get('--limit') as string | undefined;
        // Validate here so the user sees their own input, not "got NaN", and
        // is told the range instead of getting a silently clamped result.
        if (limitRaw !== undefined && (!/^[1-9]\d*$/.test(limitRaw) || Number(limitRaw) > 50)) {
          throw new Error(`--limit must be an integer between 1 and 50; got "${limitRaw}".`);
        }
        const limit = limitRaw === undefined ? 10 : Number(limitRaw);
        return await runTool(wallet, [], 'get_recent_transactions', { limit });
      }
      case 'send':
        return await cmdSend(ctx, parsed);
      case 'mcp': {
        const tracker = await loadSpendTracker(ctx.paths);
        // Persist the budget write-ahead whenever a reservation is made, so a
        // crash mid-transfer cannot lose a spend and reopen the budget.
        const { wallet, tools } = await walletFromEnv(ctx.merged, {
          spendTracker: tracker,
          onSpendChange: () => saveSpendTracker(ctx.paths, tracker),
        });
        // The server signs via the WebCrypto signer and never exports the key;
        // drop the in-memory secret copy so it does not linger for the whole
        // (long-lived) server process.
        wallet.scrub();
        // stdout is MCP protocol traffic; human-facing startup info goes to stderr.
        console.error(
          `elisym-wallet MCP server: ${wallet.address} on ${wallet.network} ` +
            `(${tools.length} tools)`,
        );
        await runMcpServer({ name: 'elisym-wallet', version: packageVersion(), tools });
        return 0;
      }
      default: {
        const isHelp = command === undefined || command === 'help';
        if (!isHelp) {
          console.error(`Unknown command "${command}".`);
        }
        console.log(USAGE);
        return isHelp ? 0 : 1;
      }
    }
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
