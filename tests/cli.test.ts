import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cliPaths,
  loadSpendTracker,
  saveSpendTracker,
  validateConfigValue,
} from '../src/cli-config.js';
import { runCli } from '../src/cli.js';
import { NATIVE_SOL } from '../src/core/assets.js';
import { SpendTracker } from '../src/core/spend-limits.js';
import { decryptSecret } from '../src/keystore.js';
import { SolanaWallet } from '../src/solana/wallet.js';

/** Hermetic env: config lives in a fresh temp dir, never in the real home. */
function tempEnv(extra: Record<string, string> = {}): Record<string, string> {
  const dir = join(tmpdir(), `elisym-wallet-cli-${Math.random().toString(36).slice(2)}`);
  return { ELISYM_WALLET_CONFIG: join(dir, 'config.json'), ...extra };
}

function captureLogs(): { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    lines.push(parts.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    errors.push(parts.join(' '));
  });
  return { lines, errors };
}

const cleanups: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function track(env: Record<string, string>): Record<string, string> {
  cleanups.push(join(env.ELISYM_WALLET_CONFIG!, '..'));
  return env;
}

describe('generate', () => {
  it('prints a working plaintext secret with a safety warning', async () => {
    const { lines } = captureLogs();
    expect(await runCli(['generate'], track(tempEnv()))).toBe(0);

    const address = lines.find((l) => l.startsWith('Address: '))!.slice('Address: '.length);
    const secret = lines
      .find((l) => l.startsWith('Secret (base58): '))!
      .slice('Secret (base58): '.length);
    expect(lines.join('\n')).toContain('KEEP THIS SECRET SAFE');

    const restored = await SolanaWallet.fromBase58(secret);
    expect(restored.address).toBe(address);
  });

  it('--passphrase prints an encrypted secret that decrypts to the same wallet', async () => {
    const { lines } = captureLogs();
    expect(await runCli(['generate', '--passphrase', 'cli-pass'], track(tempEnv()))).toBe(0);

    const address = lines.find((l) => l.startsWith('Address: '))!.slice('Address: '.length);
    const encrypted = lines
      .find((l) => l.startsWith('Secret (encrypted): '))!
      .slice('Secret (encrypted): '.length);
    expect(encrypted).toMatch(/^encrypted:v1:/);

    const restored = await SolanaWallet.fromBase58(decryptSecret(encrypted, 'cli-pass'));
    expect(restored.address).toBe(address);
  });

  it('--save writes the secret to the profile and refuses to overwrite without --force', async () => {
    const env = track(tempEnv());
    const { lines, errors } = captureLogs();
    expect(await runCli(['generate', '--save', '--allow-plaintext'], env)).toBe(0);
    expect(lines.join('\n')).toContain('Secret saved to');

    const config = JSON.parse(await readFile(env.ELISYM_WALLET_CONFIG!, 'utf8')) as {
      secret: string;
      address: string;
    };
    const restored = await SolanaWallet.fromBase58(config.secret);
    expect(restored.address).toBe(config.address);

    // a second --save must not silently destroy the stored key
    expect(await runCli(['generate', '--save', '--allow-plaintext'], env)).toBe(1);
    expect(errors.join('\n')).toContain('--force');
  });

  it('--save refuses to store the secret in plaintext without a passphrase or --allow-plaintext', async () => {
    const env = track(tempEnv());
    const { errors } = captureLogs();
    expect(await runCli(['generate', '--save'], env)).toBe(1);
    expect(errors.join('\n')).toContain('Refusing to save the secret in plaintext');
    // and nothing was written
    await expect(readFile(env.ELISYM_WALLET_CONFIG!, 'utf8')).rejects.toThrow();

    // an explicit passphrase encrypts it and saves fine
    expect(await runCli(['generate', '--save', '--passphrase', 'p'], env)).toBe(0);
    const config = JSON.parse(await readFile(env.ELISYM_WALLET_CONFIG!, 'utf8')) as {
      secret: string;
    };
    expect(config.secret).toMatch(/^encrypted:v1:/);
  });
});

describe('init', () => {
  it('creates an encrypted profile with cached address and default limits', async () => {
    const env = track(tempEnv());
    const { lines } = captureLogs();
    expect(await runCli(['init', '--passphrase', 'init-pass'], env)).toBe(0);
    expect(lines.join('\n')).toContain('encrypted with your passphrase');

    const config = JSON.parse(await readFile(env.ELISYM_WALLET_CONFIG!, 'utf8')) as Record<
      string,
      string
    >;
    expect(config.secret).toMatch(/^encrypted:v1:/);
    expect(config.address).toBeDefined();
    expect(config['spend-limit']).toBe('1');
    expect(config['spend-window-hours']).toBe('24');
    expect(config['max-per-transfer']).toBe('0.5');

    const restored = await SolanaWallet.fromBase58(decryptSecret(config.secret!, 'init-pass'));
    expect(restored.address).toBe(config.address);

    // address works with no env secret and no passphrase - cached address is enough
    expect(await runCli(['address'], env)).toBe(0);
    expect(lines).toContain(`Address: ${config.address}`);

    // re-running init must not overwrite the wallet
    expect(await runCli(['init', '--passphrase', 'other'], env)).toBe(1);
  });
});

describe('config', () => {
  it('set/get/list/unset/path round trip with validation and masking', async () => {
    const env = track(tempEnv());
    const { lines, errors } = captureLogs();

    expect(await runCli(['config', 'set', 'spend-limit', '0.5'], env)).toBe(0);
    expect(await runCli(['config', 'set', 'network', 'testnet'], env)).toBe(0);
    expect(await runCli(['config', 'get', 'spend-limit'], env)).toBe(0);
    expect(lines).toContain('0.5');

    // invalid values are rejected at set time
    expect(await runCli(['config', 'set', 'network', 'mainnet'], env)).toBe(1);
    expect(errors.join('\n')).toContain('Invalid network');
    expect(await runCli(['config', 'set', 'rate-limit', 'often'], env)).toBe(1);
    expect(await runCli(['config', 'set', 'nope', 'x'], env)).toBe(1);
    expect(errors.join('\n')).toContain('Valid keys:');

    // the secret NEVER appears in list output - no value, no status, no row
    const source = await SolanaWallet.generate();
    const secret = source.exportBase58();
    expect(await runCli(['config', 'set', 'secret', secret], env)).toBe(0);
    lines.length = 0;
    expect(await runCli(['config', 'list'], env)).toBe(0);
    const listing = lines.join('\n');
    expect(listing).toContain('(file)'); // other keys still show sources
    expect(listing).not.toContain('secret');
    expect(listing).not.toContain(secret.slice(0, 8)); // not even a prefix

    // get secret refuses by default; the value needs an explicit --reveal
    lines.length = 0;
    expect(await runCli(['config', 'get', 'secret'], env)).toBe(1);
    expect(lines.join('\n')).not.toContain(secret);
    expect(errors.join('\n')).toContain('--reveal');
    lines.length = 0;
    expect(await runCli(['config', 'get', 'secret', '--reveal'], env)).toBe(0);
    expect(lines).toContain(secret);

    expect(await runCli(['config', 'unset', 'spend-limit'], env)).toBe(0);
    lines.length = 0;
    expect(await runCli(['config', 'path'], env)).toBe(0);
    expect(lines[0]).toBe(env.ELISYM_WALLET_CONFIG);
  });

  it('set secret caches the derived address; unset secret drops it', async () => {
    const env = track(tempEnv());
    captureLogs();
    const source = await SolanaWallet.generate();
    expect(await runCli(['config', 'set', 'secret', source.exportBase58()], env)).toBe(0);

    let config = JSON.parse(await readFile(env.ELISYM_WALLET_CONFIG!, 'utf8')) as Record<
      string,
      string
    >;
    expect(config.address).toBe(source.address);

    // replacing an existing secret needs --force
    const other = await SolanaWallet.generate();
    expect(await runCli(['config', 'set', 'secret', other.exportBase58()], env)).toBe(1);
    expect(await runCli(['config', 'set', 'secret', other.exportBase58(), '--force'], env)).toBe(0);

    expect(await runCli(['config', 'unset', 'secret'], env)).toBe(0);
    config = JSON.parse(await readFile(env.ELISYM_WALLET_CONFIG!, 'utf8')) as Record<
      string,
      string
    >;
    expect(config.secret).toBeUndefined();
    expect(config.address).toBeUndefined();
  });

  it('environment variables override the profile', async () => {
    const env = track(tempEnv());
    const { lines } = captureLogs();
    const source = await SolanaWallet.generate();
    await runCli(['config', 'set', 'secret', source.exportBase58()], env);
    await runCli(['config', 'set', 'network', 'devnet'], env);

    expect(await runCli(['address'], { ...env, ELISYM_WALLET_NETWORK: 'testnet' })).toBe(0);
    expect(lines).toContain('Network: testnet');
  });
});

describe('send (pre-network failures)', () => {
  it('requires recipient and amount', async () => {
    const { errors } = captureLogs();
    expect(await runCli(['send'], track(tempEnv()))).toBe(1);
    expect(errors.join('\n')).toContain('Usage: elisym-wallet send');
  });

  it('rejects invalid recipients and guardrail violations before any confirmation', async () => {
    const env = track(tempEnv());
    const { errors } = captureLogs();
    const source = await SolanaWallet.generate();
    await runCli(['config', 'set', 'secret', source.exportBase58()], env);
    await runCli(['config', 'set', 'max-per-transfer', '0.1'], env);

    expect(await runCli(['send', 'not-an-address', '0.05', '--yes'], env)).toBe(1);
    expect(errors.join('\n')).toContain('not a valid Solana address');

    const other = await SolanaWallet.generate();
    expect(await runCli(['send', other.address, '0.2', '--yes'], env)).toBe(1);
    expect(errors.join('\n')).toContain('per-transfer cap');
  });

  it('rejects unknown tokens with a hint', async () => {
    const env = track(tempEnv());
    const { errors } = captureLogs();
    const source = await SolanaWallet.generate();
    await runCli(['config', 'set', 'secret', source.exportBase58()], env);
    expect(await runCli(['send', source.address, '1', '--token', 'wif', '--yes'], env)).toBe(1);
    expect(errors.join('\n')).toContain('config set usdc 1');
  });
});

describe('spend persistence', () => {
  it('round-trips the tracker ledger through spend.json', async () => {
    const env = track(tempEnv());
    const paths = cliPaths(env);
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: '1', windowMs: 86_400_000 }]);
    tracker.record(NATIVE_SOL, 250_000_000n);
    await saveSpendTracker(paths, tracker);

    const restored = await loadSpendTracker(paths);
    expect(restored.spent(NATIVE_SOL)).toBe(250_000_000n);
    expect(restored.limit(NATIVE_SOL)).toBe(1_000_000_000n);
  });

  it('starts fresh when the spend file is absent', async () => {
    const restored = await loadSpendTracker(cliPaths(track(tempEnv())));
    expect(restored.spent(NATIVE_SOL)).toBe(0n);
  });

  it('fails closed on a corrupt spend file instead of resetting the budget', async () => {
    const paths = cliPaths(track(tempEnv()));
    await saveSpendTracker(paths, new SpendTracker()); // create the dir + file
    await writeFile(paths.spendFile, '{ not valid json');
    await expect(loadSpendTracker(paths)).rejects.toThrow(/corrupt or invalid/);
  });

  it('fails closed on a tampered ledger with negative spend', async () => {
    const paths = cliPaths(track(tempEnv()));
    const tracker = new SpendTracker([{ asset: NATIVE_SOL, limit: '1' }]);
    tracker.record(NATIVE_SOL, 500_000_000n);
    await saveSpendTracker(paths, tracker);

    const snap = JSON.parse(await readFile(paths.spendFile, 'utf8')) as {
      ledgers: { entries: { amount: string }[] }[];
    };
    snap.ledgers[0]!.entries[0]!.amount = '-500000000';
    await writeFile(paths.spendFile, JSON.stringify(snap));

    await expect(loadSpendTracker(paths)).rejects.toThrow(/negative/);
  });
});

describe('validateConfigValue', () => {
  it('normalizes allowed-recipients and rejects malformed entries', () => {
    const ok = validateConfigValue(
      'allowed-recipients',
      ' 11111111111111111111111111111111 , TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA ',
    );
    expect(ok).toBe('11111111111111111111111111111111,TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    expect(() => validateConfigValue('allowed-recipients', 'garbage')).toThrow(/invalid address/);
    expect(() => validateConfigValue('secret', 'too-short')).toThrow();
    expect(() => validateConfigValue('usdc', 'yes')).toThrow(/must be "0" or "1"/);
    expect(() => validateConfigValue('rpc-url', 'ftp://x')).toThrow(/http/);
  });
});

describe('profiles', () => {
  /** Hermetic base dir: default profile + named profiles all live under a temp home. */
  function tempHome(): Record<string, string> {
    const home = join(tmpdir(), `elisym-wallet-home-${Math.random().toString(36).slice(2)}`);
    cleanups.push(home);
    return { ELISYM_WALLET_HOME: home };
  }

  it('keeps named profiles fully isolated (secrets, settings, spend files)', async () => {
    const env = tempHome();
    captureLogs();
    expect(await runCli(['init', '--profile', 'trading', '--passphrase', 'p1'], env)).toBe(0);
    expect(await runCli(['init', '--profile', 'ops', '--passphrase', 'p2'], env)).toBe(0);
    expect(await runCli(['config', 'set', 'spend-limit', '0.2', '--profile', 'trading'], env)).toBe(
      0,
    );

    const home = env.ELISYM_WALLET_HOME!;
    const trading = JSON.parse(
      await readFile(join(home, 'profiles', 'trading', 'config.json'), 'utf8'),
    ) as Record<string, string>;
    const ops = JSON.parse(
      await readFile(join(home, 'profiles', 'ops', 'config.json'), 'utf8'),
    ) as Record<string, string>;

    expect(trading.address).not.toBe(ops.address);
    expect(trading['spend-limit']).toBe('0.2');
    expect(ops['spend-limit']).toBe('1'); // init default, untouched by the other profile

    // spend ledgers resolve to separate files per profile
    const tradingPaths = cliPaths({ ...env, ELISYM_WALLET_PROFILE: 'trading' });
    const opsPaths = cliPaths({ ...env, ELISYM_WALLET_PROFILE: 'ops' });
    expect(tradingPaths.spendFile).not.toBe(opsPaths.spendFile);
  });

  it('--profile flag and ELISYM_WALLET_PROFILE env select the same wallet', async () => {
    const env = tempHome();
    const { lines } = captureLogs();
    await runCli(['init', '--profile', 'trading', '--passphrase', 'p'], env);

    lines.length = 0;
    await runCli(['address', '--profile', 'trading'], env);
    const viaFlag = lines.find((l) => l.startsWith('Address: '));
    lines.length = 0;
    await runCli(['address'], { ...env, ELISYM_WALLET_PROFILE: 'trading' });
    const viaEnv = lines.find((l) => l.startsWith('Address: '));
    expect(viaFlag).toBe(viaEnv);
  });

  it('lists default and named profiles, marking the active one', async () => {
    const env = tempHome();
    const { lines } = captureLogs();
    await runCli(['init', '--passphrase', 'p'], env); // default profile
    await runCli(['init', '--profile', 'trading', '--passphrase', 'p'], env);

    lines.length = 0;
    expect(await runCli(['profiles', '--profile', 'trading'], env)).toBe(0);
    const listing = lines.join('\n');
    expect(listing).toContain('default');
    expect(listing).toContain('trading');
    expect(lines.find((l) => l.startsWith('trading'))).toContain('(active)');
    expect(lines.find((l) => l.startsWith('default'))).not.toContain('(active)');
  });

  it('suggests init when no wallets exist and rejects unsafe profile names', async () => {
    const env = tempHome();
    const { lines, errors } = captureLogs();
    expect(await runCli(['profiles'], env)).toBe(0);
    expect(lines.join('\n')).toContain('No wallets found');

    expect(await runCli(['init', '--profile', '../escape', '--passphrase', 'p'], env)).toBe(1);
    expect(errors.join('\n')).toContain('Invalid profile name');
  });

  it('ELISYM_WALLET_CONFIG wins over --profile', async () => {
    const env = tempHome();
    const { lines } = captureLogs();
    const explicit = tempEnv(); // separate explicit config file
    cleanups.push(join(explicit.ELISYM_WALLET_CONFIG!, '..'));
    const source = await SolanaWallet.generate();
    await runCli(['config', 'set', 'secret', source.exportBase58()], explicit);

    await runCli(['init', '--profile', 'trading', '--passphrase', 'p'], env);
    lines.length = 0;
    // explicit config file overrides the named profile
    await runCli(['address', '--profile', 'trading'], {
      ...env,
      ELISYM_WALLET_CONFIG: explicit.ELISYM_WALLET_CONFIG,
    });
    expect(lines).toContain(`Address: ${source.address}`);
  });
});

describe('usage and errors', () => {
  it('prints usage: exit 0 for help/no command, exit 1 for unknown commands', async () => {
    const env = track(tempEnv());
    const { lines } = captureLogs();
    expect(await runCli([], env)).toBe(0);
    expect(await runCli(['help'], env)).toBe(0);
    expect(await runCli(['unknown-cmd'], env)).toBe(1);
    expect(lines.join('\n')).toContain('Setup:');
  });

  it('reports errors on stderr with exit 1', async () => {
    const env = track(tempEnv());
    const { errors } = captureLogs();
    expect(await runCli(['address'], env)).toBe(1); // no secret configured
    expect(errors.join('\n')).toContain('No wallet secret configured');
    expect(await runCli(['generate', '--passphrase'], env)).toBe(1); // missing flag value
    expect(errors.join('\n')).toContain('--passphrase requires a value');
  });
});
