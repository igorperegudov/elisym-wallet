# Changelog

## 0.1.0 (unreleased)

Initial release.

- `SolanaWallet`: generate/restore (base58, bytes, external signer), SOL + SPL
  balances, transfers with idempotent ATA creation and optional memos,
  transaction history, `waitForDeposit`, `getMaxTransferableSol`, off-chain
  message signing.
- Guardrails: `SpendTracker` (session and rolling-window caps, atomic
  reserve-before-sign, 50%/80% one-shot warnings, JSON persistence) and
  `WalletPolicy` (per-transfer caps, recipient allow/blocklists, transfer rate
  limits).
- Agent tools: `walletTools()` - framework-agnostic descriptors (Vercel AI
  SDK, MCP, LangChain compatible) with two-step transfer confirmation.
- MCP server mode: `npx @elisym/wallet mcp` (env-configured, dependency-free
  stdio server) plus the programmatic `@elisym/wallet/mcp` subpath.
- Full CLI: `init` (guided setup), `generate`, `address`, `balance`, `send`
  (preview + confirmation), `history`, and `config list/get/set/unset/path`
  over a `~/.elisym-wallet/config.json` profile (env > profile > defaults).
  The spend ledger persists to `spend.json`, so rolling budgets count across
  CLI runs and MCP restarts.
- Multiple wallets: `--profile <name>` / `ELISYM_WALLET_PROFILE` on every
  command, `profiles` listing, isolated secrets/settings/budgets per profile
  under `~/.elisym-wallet/profiles/<name>/`; `ELISYM_WALLET_HOME` relocates
  the base directory.
- Pluggable chains: chain-agnostic `core/` (guardrails, tools, `AgentWallet`
  contract) with Solana as the first adapter; `Asset` carries a `chain` field.
- Keystore: scrypt + AES-256-GCM passphrase encryption
  (`@elisym/wallet/keystore`, Node/Bun only).
- Message verification: `verifyMessageSignature()`.
- Default network is mainnet-beta everywhere (library, CLI, MCP); pass
  `devnet` explicitly for experiments.
- Dual ESM + CJS build; browser-safe main entry.
