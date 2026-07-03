/**
 * CLI configuration and persistent spend state. Node.js/Bun only.
 *
 * Profiles: the default one lives at ~/.elisym-wallet/config.json; named
 * profiles (ELISYM_WALLET_PROFILE or --profile) live under
 * ~/.elisym-wallet/profiles/<name>/config.json - each is a separate wallet
 * with its own secret, limits, and spend ledger. ELISYM_WALLET_CONFIG points
 * at an explicit file and wins over both; ELISYM_WALLET_HOME relocates the
 * whole ~/.elisym-wallet directory.
 *
 * Keys use friendly names ('spend-limit'); each maps to one ELISYM_WALLET_*
 * environment variable, and the environment always wins over the file, so an
 * MCP client passing env vars overrides the profile while plain CLI use needs
 * no env at all.
 *
 * spend.json next to the config persists the SpendTracker ledger between CLI
 * invocations - without it, a "0.5 SOL per 24h" budget would reset on every
 * `send` because each CLI run is a fresh process.
 */

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isAddress } from '@solana/kit';
import { NATIVE_SOL, USDC_MAINNET, parseAmount } from './core/assets.js';
import { SpendTracker } from './core/spend-limits.js';
import type { SpendTrackerSnapshot } from './core/spend-limits.js';
import { isEncrypted } from './keystore.js';
import { secretKeyFromBase58 } from './solana/keypair.js';

/** Config key -> the environment variable it feeds. Env always overrides file. */
export const CONFIG_KEYS = {
  secret: 'ELISYM_WALLET_SECRET',
  address: 'ELISYM_WALLET_ADDRESS',
  network: 'ELISYM_WALLET_NETWORK',
  'rpc-url': 'ELISYM_WALLET_RPC_URL',
  'spend-limit': 'ELISYM_WALLET_SPEND_LIMIT',
  'spend-window-hours': 'ELISYM_WALLET_SPEND_WINDOW_HOURS',
  'max-per-transfer': 'ELISYM_WALLET_MAX_PER_TRANSFER',
  'usdc-spend-limit': 'ELISYM_WALLET_USDC_SPEND_LIMIT',
  'usdc-max-per-transfer': 'ELISYM_WALLET_USDC_MAX_PER_TRANSFER',
  'allowed-recipients': 'ELISYM_WALLET_ALLOWED_RECIPIENTS',
  'rate-limit': 'ELISYM_WALLET_RATE_LIMIT',
  usdc: 'ELISYM_WALLET_USDC',
  confirm: 'ELISYM_WALLET_CONFIRM',
} as const;

export type ConfigKey = keyof typeof CONFIG_KEYS;

export type CliConfig = Partial<Record<ConfigKey, string>>;

export interface CliPaths {
  configFile: string;
  spendFile: string;
}

/** Base directory for profiles and state. ELISYM_WALLET_HOME relocates it. */
export function walletHome(env: Record<string, string | undefined>): string {
  return env.ELISYM_WALLET_HOME ?? join(homedir(), '.elisym-wallet');
}

const PROFILE_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Reject profile names that could escape the profiles directory. */
export function assertProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid profile name "${name}". Use letters, digits, hyphens, and underscores only.`,
    );
  }
}

/**
 * Resolve config/spend file locations. Precedence:
 * ELISYM_WALLET_CONFIG (explicit file) > ELISYM_WALLET_PROFILE (named profile)
 * > the default profile at <home>/config.json.
 */
export function cliPaths(env: Record<string, string | undefined>): CliPaths {
  if (env.ELISYM_WALLET_CONFIG) {
    const configFile = env.ELISYM_WALLET_CONFIG;
    return { configFile, spendFile: join(dirname(configFile), 'spend.json') };
  }
  const home = walletHome(env);
  if (env.ELISYM_WALLET_PROFILE) {
    assertProfileName(env.ELISYM_WALLET_PROFILE);
    const dir = join(home, 'profiles', env.ELISYM_WALLET_PROFILE);
    return { configFile: join(dir, 'config.json'), spendFile: join(dir, 'spend.json') };
  }
  return { configFile: join(home, 'config.json'), spendFile: join(home, 'spend.json') };
}

export interface ProfileInfo {
  /** Profile name; the unnamed base profile is listed as "default". */
  name: string;
  configFile: string;
}

/** All profiles that have a config file: the default one plus <home>/profiles/*. */
export async function listProfiles(
  env: Record<string, string | undefined>,
): Promise<ProfileInfo[]> {
  const home = walletHome(env);
  const profiles: ProfileInfo[] = [];

  const defaultFile = join(home, 'config.json');
  try {
    await readFile(defaultFile, 'utf8');
    profiles.push({ name: 'default', configFile: defaultFile });
  } catch {
    // no default profile yet
  }

  try {
    const entries = await readdir(join(home, 'profiles'), { withFileTypes: true });
    for (const entry of entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const configFile = join(home, 'profiles', entry.name, 'config.json');
      try {
        await readFile(configFile, 'utf8');
        profiles.push({ name: entry.name, configFile });
      } catch {
        // directory without a config - skip
      }
    }
  } catch {
    // no profiles directory yet
  }
  return profiles;
}

/** Load the profile. A missing file is an empty profile. */
export async function loadConfig(paths: CliPaths): Promise<CliConfig> {
  let raw: string;
  try {
    raw = await readFile(paths.configFile, 'utf8');
  } catch {
    return {};
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const config: CliConfig = {};
  for (const key of Object.keys(CONFIG_KEYS) as ConfigKey[]) {
    if (typeof parsed[key] === 'string') {
      config[key] = parsed[key];
    }
  }
  return config;
}

/**
 * Write `data` to `file` atomically: write a sibling temp file, then rename it
 * over the target. rename(2) is atomic within a directory, so a reader (or a
 * crash) never observes a half-written file - it sees either the old contents
 * or the complete new ones. Critical for the secret-bearing config and the
 * spend ledger, where a truncated file would mean lost funds or a wiped budget.
 *
 * The temp name is unpredictable (random suffix) and opened with 'wx'
 * (O_CREAT|O_EXCL): the write fails rather than following a pre-existing file
 * or symlink, so a local attacker cannot pre-plant `config.json.<pid>.tmp` as a
 * symlink to redirect the secret when the config dir is not private.
 */
async function writeFileAtomic(file: string, data: string, mode: number): Promise<void> {
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(tmp, data, { mode, flag: 'wx' });
  try {
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Create `dir` (0700) and enforce 0700 even if it already existed. `mkdir`'s
 * `mode` is ignored for a pre-existing directory, so a `~/.elisym-wallet` left
 * at 0755 by older tooling would keep leaking profile metadata; the explicit
 * chmod tightens it. Best-effort: ignored when not the owner or on platforms
 * without POSIX modes.
 */
async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
}

/** Write the profile with private permissions (dir 0700, file 0600). */
export async function saveConfig(paths: CliPaths, config: CliConfig): Promise<void> {
  await ensurePrivateDir(dirname(paths.configFile));
  await writeFileAtomic(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

export function assertConfigKey(key: string): asserts key is ConfigKey {
  if (!(key in CONFIG_KEYS)) {
    throw new Error(
      `Unknown config key "${key}". Valid keys: ${Object.keys(CONFIG_KEYS).join(', ')}.`,
    );
  }
}

/**
 * Validate a value for a config key; returns the normalized value.
 * Catches typos at `config set` time instead of at first use.
 */
export function validateConfigValue(key: ConfigKey, value: string): string {
  const trimmed = value.trim();
  switch (key) {
    case 'secret':
      if (!isEncrypted(trimmed)) {
        secretKeyFromBase58(trimmed); // throws unless a valid 64-byte base58 secret
      }
      return trimmed;
    case 'address':
      if (!isAddress(trimmed)) {
        throw new Error(`"${trimmed}" is not a valid Solana address.`);
      }
      return trimmed;
    case 'network':
      if (!['devnet', 'mainnet-beta', 'testnet'].includes(trimmed)) {
        throw new Error(`Invalid network "${trimmed}". Expected devnet, mainnet-beta, or testnet.`);
      }
      return trimmed;
    case 'rpc-url':
      if (!/^https?:\/\//.test(trimmed)) {
        throw new Error(`rpc-url must start with http:// or https://; got "${trimmed}".`);
      }
      return trimmed;
    case 'spend-limit':
    case 'max-per-transfer':
      parseAmount(NATIVE_SOL, trimmed); // throws on malformed SOL amounts
      return trimmed;
    case 'usdc-spend-limit':
    case 'usdc-max-per-transfer':
      parseAmount(USDC_MAINNET, trimmed); // throws on malformed USDC amounts
      return trimmed;
    case 'spend-window-hours': {
      const hours = Number(trimmed);
      if (!Number.isFinite(hours) || hours <= 0) {
        throw new Error(`spend-window-hours must be a positive number; got "${trimmed}".`);
      }
      return trimmed;
    }
    case 'allowed-recipients': {
      const entries = trimmed
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (entries.length === 0) {
        throw new Error('allowed-recipients must contain at least one address.');
      }
      for (const entry of entries) {
        if (!isAddress(entry)) {
          throw new Error(`allowed-recipients contains an invalid address: "${entry}".`);
        }
      }
      return entries.join(',');
    }
    case 'rate-limit':
      if (!/^\d+\/\d+$/.test(trimmed)) {
        throw new Error(`rate-limit must be "N/SECONDS" (e.g. "5/60"); got "${trimmed}".`);
      }
      return trimmed;
    case 'usdc':
    case 'confirm':
      if (trimmed !== '0' && trimmed !== '1') {
        throw new Error(`${key} must be "0" or "1"; got "${trimmed}".`);
      }
      return trimmed;
  }
}

/**
 * Merge the profile under the process environment: every config key becomes
 * its ELISYM_WALLET_* variable unless the environment already sets it.
 */
export function mergedEnv(
  env: Record<string, string | undefined>,
  config: CliConfig,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = { ...env };
  for (const [key, envName] of Object.entries(CONFIG_KEYS) as [ConfigKey, string][]) {
    if (result[envName] === undefined && config[key] !== undefined) {
      result[envName] = config[key];
    }
  }
  return result;
}

/**
 * Restore the persisted spend ledger. A MISSING file starts a fresh tracker
 * (legitimate first run); a file that is present but unreadable, corrupt, or
 * fails validation throws instead of silently resetting. Fail-closed on
 * purpose: silently treating a damaged or tampered ledger as "zero spent" would
 * hand back the entire budget, so the caller must surface the error and let the
 * operator inspect the file rather than let the cap be bypassed.
 *
 * Note: this is single-writer. Running two processes against one profile's
 * spend file concurrently (e.g. a live `mcp` server plus a `send`) is not
 * supported - there is no cross-process lock, and last write wins.
 */
export async function loadSpendTracker(paths: CliPaths): Promise<SpendTracker> {
  let raw: string;
  try {
    raw = await readFile(paths.spendFile, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      return new SpendTracker();
    }
    throw new Error(
      `Cannot read spend ledger at ${paths.spendFile}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    return SpendTracker.fromJSON(JSON.parse(raw) as SpendTrackerSnapshot);
  } catch (e) {
    throw new Error(
      `Spend ledger at ${paths.spendFile} is corrupt or invalid: ` +
        `${e instanceof Error ? e.message : String(e)}. ` +
        'Refusing to proceed with a reset budget - inspect or remove the file to continue.',
    );
  }
}

/** Persist the spend ledger so budgets survive across CLI invocations. */
export async function saveSpendTracker(paths: CliPaths, tracker: SpendTracker): Promise<void> {
  await ensurePrivateDir(dirname(paths.spendFile));
  await writeFileAtomic(paths.spendFile, `${JSON.stringify(tracker.toJSON())}\n`, 0o600);
}
