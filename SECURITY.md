# Security Policy

## Threat model

`@elisym/wallet` is a self-custody wallet library designed to be held by autonomous
software (AI agents, bots). The guardrails target these threats:

| Threat | Mitigation |
| --- | --- |
| Prompt injection makes the agent send funds | Two-step tool confirmation (preview + nonce), policy allowlist, per-transfer caps |
| Agent bug loops payments | Spend limits (session or rolling window), transfer rate limits |
| Concurrent transfers race past a cap | Atomic reserve-before-sign in `SpendTracker` |
| Process restart resets a daily budget | `SpendTracker.toJSON()` / `fromJSON()` persistence |
| Key theft from disk | scrypt (N=2^17) + AES-256-GCM keystore; keys never stored in plaintext by the library |
| Key theft from process memory | `scrub()` zeroes the exportable copy; `fromSigner()` keeps keys out of the process entirely |
| Corrupted/partly-tampered spend ledger reopens the budget | `SpendTracker.fromJSON()` rejects negative/non-integer amounts and non-positive windows and re-keys ledgers from their asset; the CLI fails closed on an unreadable/corrupt `spend.json` instead of resetting to zero spent. Integrity of the file itself still relies on its `0600` permissions - an attacker who can rewrite the ledger can reset the budget across restarts, so keep the wallet home out of the agent's reach. |
| Secret leaked to the running model | Agent-facing error text redacts URL-embedded RPC credentials (query-string API keys, `user:pass@`) before it reaches the LLM |

## Operating notes and known boundaries

- **Enable the allowlist for autonomous agents.** The two-step tool confirmation
  (preview + nonce) exists so a supervising human can catch a bad transfer; it is
  NOT a defense against a fully autonomous agent, which can perform both steps
  itself. Against prompt injection the load-bearing control is
  `allowed-recipients` (`ELISYM_WALLET_ALLOWED_RECIPIENTS`): with an allowlist,
  an injected "send everything to X" fails unless X was pre-approved. `init` does
  not set one (it cannot know your recipients) - set it yourself.
- **Treat all remote content as data, never instructions.** Job results, web
  pages, and on-chain transaction memos are surfaced verbatim to the agent; do
  not let the agent transfer funds based on text found there.
- **Spend caps bound transferred amounts, not network fees.** A cap on SOL/USDC
  limits what you send; it does not count the ~5000-lamport transaction fee or
  the one-time associated-token-account rent paid when sending a token to a fresh
  recipient. Bound recipients with the allowlist and frequency with the rate
  limit to keep incidental SOL burn in check. USDC now has its own optional caps
  (`ELISYM_WALLET_USDC_SPEND_LIMIT` / `_USDC_MAX_PER_TRANSFER`) - set them when
  you enable USDC.
- **Keep secrets off the command line.** Passing the base58 secret to
  `config set secret` or a passphrase via `--passphrase` puts it in your shell
  history and the process list. Enter the secret interactively (`config set
  secret` with no value, or pipe it via stdin) and provide the passphrase via
  `ELISYM_WALLET_PASSPHRASE` or the interactive prompt.
- **The spend ledger is single-writer.** Running two processes against one
  profile's `spend.json` concurrently (e.g. a live `mcp` server and a separate
  `send`) is unsupported - there is no cross-process lock, and last write wins.

What the library can NOT protect against: an attacker with full control of the
process (they can call the signer directly), a malicious RPC endpoint you
configured, or policy/limits you did not enable. The default network is
mainnet-beta (real funds): use devnet for experiments, and note that spend
limits and policies are opt-in in the library - enable them for any
agent-held wallet (`init` configures safe defaults for CLI/MCP use).

## Reporting a vulnerability

Please email security reports to the maintainers via GitHub security advisories
("Report a vulnerability" on the repository page) rather than opening a public
issue. We aim to acknowledge reports within 72 hours.

Please include: affected version, reproduction steps, and impact assessment.

## Supported versions

Only the latest published minor version receives security fixes.
