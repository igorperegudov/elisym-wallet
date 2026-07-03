/**
 * AgentWallet - the chain-agnostic wallet contract.
 *
 * Everything above this interface (spend limits, policy, agent tools, MCP
 * server) is chain-independent: it works with any implementation. Everything
 * below it is a chain adapter. `SolanaWallet` is the first adapter; an EVM
 * adapter would implement the same interface on top of viem/ethers and
 * inherit every guardrail and tool unchanged.
 *
 * Adapter responsibilities:
 *   - amounts are raw subunits (`bigint`) end-to-end (lamports, wei, ...);
 *   - transfers run guardrails (policy, then spend reserve) BEFORE signing;
 *   - `checkTransfer` dry-runs those guardrails without reserving;
 *   - `isValidAddress` validates the chain's address format.
 */

import type { Asset } from './assets.js';
import type { SpendTracker } from './spend-limits.js';

export interface TransferNativeParams {
  /** Recipient address in the chain's format. */
  to: string;
  /** Raw subunits as bigint, or a human decimal string (e.g. "0.5"). */
  amount: bigint | string;
  /** Optional transfer note. On-chain memo where the chain supports it. */
  memo?: string;
}

export interface TransferTokenParams {
  /** Recipient address in the chain's format (the owner, not a token account). */
  to: string;
  /** Token to transfer. Must carry a `mint` (contract/mint address). */
  asset: Asset;
  /** Raw subunits as bigint, or a human decimal string (e.g. "1.25"). */
  amount: bigint | string;
  /** Optional transfer note. On-chain memo where the chain supports it. */
  memo?: string;
}

export interface TransferResult {
  /** Transaction id (signature/hash) in the chain's format. */
  signature: string;
  /** Block-explorer link for the transaction. */
  explorerUrl: string;
  /**
   * One-shot spend-limit warnings (50% / 80% of the cap) that fired on this
   * transfer. Empty when no cap is configured or no threshold was crossed.
   */
  spendWarnings: string[];
}

export interface TransactionSummary {
  /** Transaction id (signature/hash). */
  signature: string;
  /** Chain-specific ordering hint (slot, block number). */
  slot: bigint;
  /** Unix timestamp (seconds) or null when unknown. */
  blockTime: number | null;
  /** Error summary for failed transactions, null on success. */
  err: string | null;
  /** Note/memo attached to the transaction, if any. */
  memo: string | null;
  /** Confirmation status at query time, if the chain reports one. */
  confirmationStatus: string | null;
  /** Block-explorer link. */
  explorerUrl: string;
}

export interface WaitForDepositParams {
  /** Target balance as raw subunits (bigint) or human decimal string. */
  amount: bigint | string;
  /** Token to watch. Omit for the native asset. */
  asset?: Asset;
  /** Give up after this long. Default: 120_000 ms. */
  timeoutMs?: number;
  /** Poll interval. Default: 2_500 ms. */
  pollIntervalMs?: number;
  /** Abort early (e.g. agent cancelled the job). */
  signal?: AbortSignal;
}

export interface AgentWallet {
  /** Chain id: 'solana', 'ethereum', ... */
  readonly chain: string;
  /** Network name within the chain: 'devnet', 'mainnet-beta', 'sepolia', ... */
  readonly network: string;
  /** Wallet address in the chain's format. */
  readonly address: string;
  /** The chain's native asset (SOL, ETH, ...). */
  readonly nativeAsset: Asset;
  /** Spend caps and counters. May be shared across wallets. */
  readonly spendTracker: SpendTracker;

  /** Validate an address in this chain's format. */
  isValidAddress(address: string): boolean;
  /** Native balance in raw subunits. */
  getBalance(): Promise<bigint>;
  /** Token balance in raw subunits; 0n when the wallet holds none. */
  getTokenBalance(assetOrId: Asset | string): Promise<bigint>;
  /** Transfer the native asset. Guardrails run before signing. */
  transferNative(params: TransferNativeParams): Promise<TransferResult>;
  /** Transfer a token. Guardrails run before signing. */
  transferToken(params: TransferTokenParams): Promise<TransferResult>;
  /** Dry-run the guardrails; throws what a real transfer would, reserves nothing. */
  checkTransfer(asset: Asset, amount: bigint | string, to: string): void;
  /** Recent transactions touching this wallet, newest first. */
  getRecentTransactions(limit?: number): Promise<TransactionSummary[]>;
  /** Poll until the balance reaches a target. */
  waitForDeposit(params: WaitForDepositParams): Promise<bigint>;
  /** Sign an off-chain message; returns the signature in the chain's usual encoding. */
  signMessage(message: string | Uint8Array): Promise<string>;
  /** Block-explorer link for a transaction id. */
  explorerUrl(signature: string): string;
}
