# @elisym/wallet

A wallet library built for AI agents. Give your agent a wallet, hard guardrails, and ready-made tools - in a few lines of TypeScript, or as a drop-in MCP server with zero code.

Chain-pluggable by design: the guardrails, tools, and MCP server are chain-agnostic; Solana (via [`@solana/kit`](https://github.com/anza-xyz/kit)) is the first adapter, and EVM is on the roadmap. Extracted from the [elisym](https://github.com/elisymlabs/elisym) agent payment stack, where it powers wallets for AI agents that discover and pay each other. Works in Node.js, Bun, and the browser (keystore and MCP server are Node/Bun-only).

## Why this library

Handing a private key to an autonomous agent is the easy part. The hard part is making sure a bug, a bad plan, or a prompt injection cannot drain the wallet. `@elisym/wallet` treats guardrails as the core feature, not an add-on:

- **Spend limits** - per-asset caps, per session or rolling window ("max 1 SOL per 24h"), enforced atomically before signing, persistable across restarts
- **Wallet policy** - per-transfer caps, recipient allowlists/blocklists, transfer rate limits
- **Two-step transfers for agents** - the built-in agent tools preview every transfer and require a confirmation nonce, so a single injected tool call cannot move funds
- **Agent tools out of the box** - framework-agnostic tool descriptors that plug into Vercel AI SDK, MCP, LangChain, or any function-calling loop
- **MCP server mode** - `npx @elisym/wallet mcp` exposes the same guarded tools to Claude, Cursor, or Windsurf without writing any code

Plus the regular wallet surface: keypairs (64-byte solana-keygen layout), SOL + SPL balances and transfers with idempotent ATA creation, on-chain memos, transaction history, deposit waiting, off-chain message signing, and AES-256-GCM + scrypt key encryption at rest.

## Install

```sh
npm install @elisym/wallet
# or
bun add @elisym/wallet
```

Requires Node.js >= 20 or Bun. Ships both ESM and CJS.

## Quick start

```ts
import { SolanaWallet, NATIVE_SOL, formatAmount } from '@elisym/wallet';

// Create a wallet. Default network is mainnet-beta; use devnet to try things out
const wallet = await SolanaWallet.generate({ network: 'devnet' });
console.log('Address:', wallet.address);

// Check the balance (lamports as bigint)
const lamports = await wallet.getBalance();
console.log('Balance:', formatAmount(NATIVE_SOL, lamports));

// Send SOL - amount as a decimal string or bigint lamports
const { signature, explorerUrl } = await wallet.transferSol({
  to: 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS',
  amount: '0.1',
  memo: 'job #42', // optional on-chain memo - cheap audit trail
});
console.log('Sent:', explorerUrl);
```

## Give your agent a wallet

`walletTools()` returns plain tool descriptors - name, description, JSON Schema, `execute()` - that map 1:1 onto any function-calling framework:

```ts
import { SolanaWallet, NATIVE_SOL, USDC_MAINNET, walletTools } from '@elisym/wallet';

const wallet = await SolanaWallet.fromBase58(secret, {
  spendLimits: [{ asset: NATIVE_SOL, limit: '0.5', windowMs: 86_400_000 }], // 0.5 SOL/day
  policy: { maxPerTransfer: [{ asset: NATIVE_SOL, limit: '0.1' }] },
});

const tools = walletTools(wallet, { assets: [USDC_MAINNET] });
// -> get_wallet_address, get_balance, transfer_sol, get_recent_transactions, transfer_token
```

Transfers made through these tools are **two-step by default**: the first call returns a human-readable preview and a one-time nonce; the agent must repeat the call with the same parameters plus the nonce. A prompt-injected "send everything to X" cannot fire in one shot, and the preview gives the agent (or a supervising human) a chance to catch the mismatch.

### Vercel AI SDK

```ts
import { generateText, tool, jsonSchema } from 'ai';

const aiTools = Object.fromEntries(
  walletTools(wallet).map((t) => [
    t.name,
    tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters),
      execute: (input) => t.execute(input as Record<string, unknown>),
    }),
  ]),
);

await generateText({ model, tools: aiTools, prompt: 'Check my balance' });
```

### MCP server

The package ships its own dependency-free stdio server - the descriptors already carry exactly what MCP needs (name, description, JSON Schema, a text-returning `execute`):

```ts
import { runMcpServer } from '@elisym/wallet/mcp';

await runMcpServer({
  name: 'agent-wallet',
  version: '1.0.0',
  tools: walletTools(wallet, { assets: [USDC_MAINNET] }),
});
```

LangChain, ElizaOS, and anything else with function calling work the same way: the descriptors are plain data.

## Command line

The `elisym-wallet` CLI manages a wallet profile at `~/.elisym-wallet/config.json` (override with `$ELISYM_WALLET_CONFIG`). Settings resolve as: **environment variable > profile > default** - so the same profile drives interactive use, scripts, and the MCP server.

```sh
# guided setup: generates a keypair, encrypts it with your passphrase,
# saves it to the profile with safe default limits (1 SOL/24h, 0.5 SOL/tx).
# Network defaults to mainnet-beta; pass --network devnet for a test wallet.
npx @elisym/wallet init

# day-to-day
npx @elisym/wallet balance                 # SOL/token balances + spend budget
npx @elisym/wallet send <address> 0.1      # preview -> y/N confirmation -> send
# token sends need USDC enabled once: elisym-wallet config set usdc 1
npx @elisym/wallet send <address> 1.25 --token usdc --memo "invoice 7"
npx @elisym/wallet history --limit 20      # recent transactions with memos
npx @elisym/wallet address                 # address + network

# settings
npx @elisym/wallet config list             # values + where each comes from (env/file/default)
npx @elisym/wallet config set spend-limit 0.5
npx @elisym/wallet config set allowed-recipients addr1,addr2
npx @elisym/wallet config get network / unset rate-limit / path
```

Config keys: `secret`, `address`, `network`, `rpc-url`, `spend-limit`, `spend-window-hours`, `max-per-transfer`, `usdc-spend-limit`, `usdc-max-per-transfer`, `allowed-recipients`, `rate-limit`, `usdc`, `confirm`. Values are validated at `config set` time.

### Multiple wallets (profiles)

Every command takes `--profile <name>` (or `$ELISYM_WALLET_PROFILE`) - each profile is a fully separate wallet with its own secret, settings, and spend budget, stored under `~/.elisym-wallet/profiles/<name>/`:

```sh
npx @elisym/wallet init --profile trading
npx @elisym/wallet init --profile ops
npx @elisym/wallet profiles               # list wallets: name, address, network, active marker
npx @elisym/wallet balance --profile trading
npx @elisym/wallet send <address> 0.1 --profile ops
```

Register several MCP servers to give one agent several wallets:

```sh
claude mcp add wallet-trading -e ELISYM_WALLET_PROFILE=trading -e ELISYM_WALLET_PASSPHRASE=... -- npx @elisym/wallet mcp
claude mcp add wallet-ops     -e ELISYM_WALLET_PROFILE=ops     -e ELISYM_WALLET_PASSPHRASE=... -- npx @elisym/wallet mcp
```

`$ELISYM_WALLET_CONFIG` (explicit config file) wins over profiles; `$ELISYM_WALLET_HOME` relocates the whole `~/.elisym-wallet` directory. In code, multiple wallets are just multiple `SolanaWallet` instances - optionally sharing one `SpendTracker` for a common budget.

UX details that matter:

- **Read-only commands don't need the passphrase.** `init` caches the public address in the profile, so `balance`, `history`, and `address` work without touching the secret; they fall back to decrypting it only when no address is cached (e.g. an env-only setup with an encrypted secret). `send` and `mcp` always decrypt the key (`send` prompts for the passphrase interactively when it is not in the environment).
- **Budgets survive between runs.** The spend ledger persists to `~/.elisym-wallet/spend.json`, so a "1 SOL per 24h" cap counts across separate `send` invocations and MCP server restarts - not per process.
- **Guardrails run before the preview.** A transfer that would break a cap or the allowlist fails immediately with the exact reason; `--yes` skips only the confirmation, never the checks.
- **Secrets are protected from accidents.** `init`, `generate --save`, and `config set secret` refuse to overwrite an existing secret without `--force`; profile files are written with `0600` permissions.

## Run as an MCP server (no code)

The package doubles as an MCP stdio server, so Claude Desktop/Code, Cursor, or Windsurf can use the wallet directly. After `elisym-wallet init` the profile already holds everything, so registration is one line (plus the passphrase if the secret is encrypted):

```sh
claude mcp add elisym-wallet \
  -e ELISYM_WALLET_PASSPHRASE="correct horse battery staple" \
  -- npx @elisym/wallet mcp
```

Or fully env-driven without a profile:

```sh
claude mcp add elisym-wallet \
  -e ELISYM_WALLET_SECRET="encrypted:v1:..." \
  -e ELISYM_WALLET_PASSPHRASE="correct horse battery staple" \
  -e ELISYM_WALLET_SPEND_LIMIT="0.5" \
  -e ELISYM_WALLET_SPEND_WINDOW_HOURS="24" \
  -- npx @elisym/wallet mcp
```

Or in any MCP client's JSON config:

```json
{
  "mcpServers": {
    "elisym-wallet": {
      "command": "npx",
      "args": ["@elisym/wallet", "mcp"],
      "env": {
        "ELISYM_WALLET_SECRET": "encrypted:v1:...",
        "ELISYM_WALLET_PASSPHRASE": "...",
        "ELISYM_WALLET_SPEND_LIMIT": "0.5",
        "ELISYM_WALLET_SPEND_WINDOW_HOURS": "24",
        "ELISYM_WALLET_MAX_PER_TRANSFER": "0.1",
        "ELISYM_WALLET_ALLOWED_RECIPIENTS": "addr1,addr2",
        "ELISYM_WALLET_USDC": "1",
        "ELISYM_WALLET_USDC_SPEND_LIMIT": "25",
        "ELISYM_WALLET_USDC_MAX_PER_TRANSFER": "10"
      }
    }
  }
}
```

| Env var | Meaning |
| --- | --- |
| `ELISYM_WALLET_SECRET` | base58 secret key, or an `encrypted:v1:...` keystore blob |
| `ELISYM_WALLET_SECRET_FILE` | path to a file holding the same (wins over `SECRET`) |
| `ELISYM_WALLET_PASSPHRASE` | passphrase for an encrypted secret |
| `ELISYM_WALLET_NETWORK` | `mainnet-beta` (default), `devnet`, `testnet` |
| `ELISYM_WALLET_RPC_URL` | custom RPC endpoint |
| `ELISYM_WALLET_SPEND_LIMIT` | spend cap in SOL (session, or rolling with the window var) |
| `ELISYM_WALLET_SPEND_WINDOW_HOURS` | makes the SOL and USDC caps rolling windows, e.g. `24` |
| `ELISYM_WALLET_MAX_PER_TRANSFER` | per-transfer cap in SOL |
| `ELISYM_WALLET_USDC_SPEND_LIMIT` | spend cap in USDC (session, or rolling with the window var) |
| `ELISYM_WALLET_USDC_MAX_PER_TRANSFER` | per-transfer cap in USDC |
| `ELISYM_WALLET_ALLOWED_RECIPIENTS` | comma-separated recipient allowlist |
| `ELISYM_WALLET_RATE_LIMIT` | `N/SECONDS`, e.g. `5/60` = 5 transfers per minute |
| `ELISYM_WALLET_USDC` | `1` to expose USDC tools |
| `ELISYM_WALLET_CONFIRM` | `0` to disable two-step transfer confirmation |

The server exposes the same guarded tools as `walletTools()` - two-step confirmation, spend limits, and policy all apply. Programmatic embedding is available via the `@elisym/wallet/mcp` subpath (`runMcpServer`, `walletFromEnv`).

## Pluggable chains

The package is layered so new chains slot in without touching the safety stack:

```
core/   chain-agnostic: Asset, SpendTracker, PolicyEngine, walletTools(), AgentWallet contract
solana/ the first adapter: SolanaWallet implements AgentWallet
```

Everything above the `AgentWallet` interface - spend limits, policy, agent tools, the MCP server - works with any implementation. An EVM adapter is an `EvmWallet implements AgentWallet` on top of viem: implement the `AgentWallet` contract - balances, the two transfer methods (with the reserve-before-sign guardrail order), `checkTransfer`, history, deposit waiting, address validation, message signing, and explorer links - and every guardrail and tool is inherited unchanged; the tool set even renames itself (`transfer_eth` instead of `transfer_sol`) based on `wallet.nativeAsset`.

```ts
import { walletTools, type AgentWallet } from '@elisym/wallet';

class EvmWallet implements AgentWallet {
  readonly chain = 'ethereum';
  readonly nativeAsset = { chain: 'ethereum', token: 'eth', decimals: 18, symbol: 'ETH' };
  // ... balances, transfers, history on top of viem
}

const tools = walletTools(new EvmWallet(...)); // same guardrails, same tools
```

## Guardrails

### Spend limits

Per-asset caps checked **before signing**. The amount is reserved atomically (check-then-increment), so concurrent transfers cannot double-spend the remaining budget. A send that provably fails before broadcast returns the reservation; an ambiguous failure during or after broadcast (send error, confirmation timeout) keeps it, because the transaction may still have landed.

```ts
import { SolanaWallet, SpendTracker, SpendLimitError, NATIVE_SOL, USDC_MAINNET } from '@elisym/wallet';

const wallet = await SolanaWallet.fromBase58(secret, {
  spendLimits: [
    { asset: NATIVE_SOL, limit: '0.5' },                       // per session
    { asset: USDC_MAINNET, limit: '25', windowMs: 86_400_000 }, // rolling 24h
  ],
});

const { spendWarnings } = await wallet.transferSol({ to, amount: '0.3' });
// crossing 50% / 80% of a cap returns one-shot warnings here

wallet.spendTracker.remaining(NATIVE_SOL); // bigint, or null when uncapped
wallet.spendTracker.status();              // [{ asset, spent, limit, remaining, windowMs }]
```

Rolling-window budgets age out: spend from 25 hours ago no longer counts against a 24-hour cap. To keep a budget honest across restarts, persist it:

```ts
import fs from 'node:fs/promises';

// on shutdown (or after every transfer)
await fs.writeFile('budget.json', JSON.stringify(wallet.spendTracker.toJSON()));

// on startup
const tracker = SpendTracker.fromJSON(JSON.parse(await fs.readFile('budget.json', 'utf8')));
const wallet = await SolanaWallet.fromBase58(secret, { spendTracker: tracker });
```

One tracker shared by several wallets enforces a single budget across all of them.

### Wallet policy

Hard rules about WHERE and HOW OFTEN funds may move. For an agent-held wallet, an allowlist is the strongest single defense.

```ts
import { PolicyViolationError } from '@elisym/wallet';

const wallet = await SolanaWallet.fromBase58(secret, {
  policy: {
    allowedRecipients: [treasury, providerA],            // only these addresses, ever
    blockedRecipients: [],                                // always rejected (wins over allowlist)
    maxPerTransfer: [{ asset: NATIVE_SOL, limit: '0.1' }], // no single tx above 0.1 SOL
    rateLimit: { maxTransfers: 5, windowSecs: 60 },        // at most 5 transfers per minute
  },
});
// violations throw PolicyViolationError (with a .rule field) before anything is signed
```

Policy checks run before spend limits and consume no budget when they reject.

## Wallet API

### Backup and restore

```ts
const secret = wallet.exportBase58();                     // same 64-byte layout as solana-keygen
const restored = await SolanaWallet.fromBase58(secret);
const fromBytes = await SolanaWallet.fromSecretKeyBytes(wallet.exportSecretKeyBytes());
wallet.scrub();                                           // zero the in-memory key copy
```

### Encrypted key storage (Node.js/Bun)

```ts
import { encryptSecret, decryptSecret, isEncrypted } from '@elisym/wallet/keystore';

const stored = encryptSecret(wallet.exportBase58(), 'correct horse battery staple');
// -> "encrypted:v1:..." (scrypt N=2^17 + AES-256-GCM) - safe to write to a config file
const secret = decryptSecret(stored, 'correct horse battery staple');
```

The main `@elisym/wallet` entry point is browser-safe; the `keystore` and `mcp` subpaths are Node/Bun-only (`keystore` depends on `node:crypto`, and `mcp` uses it internally).

### External signers (Turnkey, Privy, hardware, multisig)

Keep the private key out of the agent process entirely - wrap any kit `TransactionSigner`:

```ts
const wallet = SolanaWallet.fromSigner(externalSigner);
// transfers, balances, guardrails all work; exportBase58()/exportSecretKeyBytes() throw
```

### SPL tokens

```ts
import { USDC_MAINNET } from '@elisym/wallet'; // USDC_DEVNET for devnet wallets

const raw = await wallet.getTokenBalance(USDC_MAINNET);  // bigint subunits
await wallet.transferToken({ to, asset: USDC_MAINNET, amount: '1.25', memo: 'invoice 7' });
// recipient's associated token account is created automatically if missing

// any SPL token works - describe it with an Asset
const BONK = {
  chain: 'solana',
  token: 'bonk',
  mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  decimals: 5,
  symbol: 'BONK',
};
```

### History, deposits, identity

```ts
import { verifyMessageSignature } from '@elisym/wallet';

// recent transactions, newest first, memos included
const txs = await wallet.getRecentTransactions(10);
// [{ signature, blockTime, err, memo, confirmationStatus, explorerUrl, slot }]

// wait to be funded (agents often start empty)
await wallet.waitForDeposit({ amount: '0.1', timeoutMs: 300_000 });
await wallet.waitForDeposit({ asset: USDC_MAINNET, amount: '5' });

// prove address ownership off-chain (agent identity, API auth)
const signature = await wallet.signMessage('I am agent-7');
await verifyMessageSignature({ address: wallet.address, message: 'I am agent-7', signature }); // true

// how much SOL can be sent after the fee reserve
const max = await wallet.getMaxTransferableSol();
```

### Reference

| Member | Description |
| --- | --- |
| `SolanaWallet.generate(config?)` | Create a wallet with a fresh keypair |
| `SolanaWallet.fromSecretKeyBytes(bytes, config?)` / `fromBase58(secret, config?)` | Restore from a secret key |
| `SolanaWallet.fromSigner(signer, config?)` | Wrap an external kit `TransactionSigner` |
| `wallet.address` / `wallet.network` / `wallet.canExportSecretKey` | Wallet identity |
| `wallet.getBalance()` / `wallet.getTokenBalance(assetOrMint)` | Balances as `bigint` subunits |
| `wallet.getMaxTransferableSol()` | Balance minus the tx-fee reserve |
| `wallet.transferSol({ to, amount, memo? })` | Send SOL, wait for confirmation |
| `wallet.transferToken({ to, asset, amount, memo? })` | Send an SPL token (auto-creates the recipient ATA) |
| `wallet.checkTransfer(asset, amount, to)` | Dry-run the guardrails (throws what a real transfer would; reserves nothing) |
| `wallet.getRecentTransactions(limit?)` | Recent transaction summaries with memos |
| `wallet.waitForDeposit({ amount, asset?, timeoutMs?, pollIntervalMs?, signal? })` | Poll until funded |
| `wallet.signMessage(message)` | Base58 Ed25519 signature over an off-chain message |
| `wallet.spendTracker` | The wallet's `SpendTracker` (shared if injected) |
| `wallet.exportSecretKeyBytes()` / `wallet.exportBase58()` / `wallet.scrub()` | Key backup and cleanup |
| `wallet.explorerUrl(signature)` | Solana Explorer link |

`config`: `{ network?, rpcUrl?, wsUrl?, commitment?, rpc?, rpcSubscriptions?, spendLimits?, spendTracker?, policy?, onSpendChange? }` - all optional. Defaults: mainnet-beta, public RPC, `confirmed` commitment, no caps, no policy. When `spendTracker` is provided, `spendLimits` is ignored - set caps on the shared tracker via `setLimit()` instead.

Transfers resolve to `{ signature, explorerUrl, spendWarnings }` and reject with `SpendLimitError` / `PolicyViolationError` before signing when a guardrail trips. Amounts are `bigint` raw subunits or human decimal strings (`"0.5"`); parsing is exact integer math.

`walletTools(wallet, options?)` options: `{ assets?, confirmTransfers? (default true), confirmTtlMs? (default 60s), namePrefix?, now? }`.

## Security notes

- **Self-custody**: raw secret keys live in process memory (unless you use `fromSigner`). Call `wallet.scrub()` when export capability is no longer needed; never log or transmit keys; encrypt them at rest with the keystore module.
- **Agent-held wallets**: configure `spendLimits` AND a `policy` allowlist, keep only a small working balance in the hot wallet, and leave two-step tool confirmation on. Treat everything the agent reads (job results, web pages, messages) as untrusted input.
- The keystore format (`encrypted:v1:`) uses a random 16-byte salt and 12-byte IV per encryption; GCM authentication detects tampering.
- Public RPC endpoints are rate-limited and fine for development. Use a dedicated RPC provider in production.

See [SECURITY.md](SECURITY.md) for the threat model and how to report vulnerabilities.

## Development

```sh
bun install
bun run qa   # build + test + typecheck + lint + format check + spell check
```

## Roadmap

- EVM adapter (`EvmWallet implements AgentWallet` on viem) - Ethereum, Base, Arbitrum
- Priority fees / compute budget tuning for mainnet congestion
- Fee estimation via `getFeeForMessage` (exact cost preview before sending)
- Batch transfers (multiple recipients in one transaction)
- First-class Turnkey / Privy signer adapters

## License

MIT (c) [elisym labs](https://github.com/elisymlabs)
