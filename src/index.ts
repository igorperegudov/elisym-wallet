/**
 * @elisym/wallet - a wallet library built for AI agents.
 *
 * Layout: `core/` is chain-agnostic (assets, spend limits, policy, agent
 * tools, the `AgentWallet` contract); `solana/` is the first chain adapter.
 * Future adapters (EVM, ...) implement `AgentWallet` and inherit every
 * guardrail and tool unchanged.
 *
 * Browser-safe entry point. Node-only pieces live in subpaths:
 * '@elisym/wallet/keystore' (key encryption) and '@elisym/wallet/mcp'
 * (MCP stdio server).
 */

// core - chain-agnostic
export type {
  AgentWallet,
  TransactionSummary,
  TransferNativeParams,
  TransferResult,
  TransferTokenParams,
  WaitForDepositParams,
} from './core/agent-wallet.js';

export {
  NATIVE_SOL,
  USDC_DEVNET,
  USDC_MAINNET,
  formatAmount,
  formatAmountValue,
  parseAmount,
  resolveAmount,
} from './core/assets.js';
export type { Asset } from './core/assets.js';

export { PolicyEngine, PolicyViolationError } from './core/policy.js';
export type {
  PerTransferLimit,
  PolicyEngineOptions,
  PolicyRule,
  TransferRateLimit,
  WalletPolicy,
} from './core/policy.js';

export {
  SPEND_WARN_THRESHOLDS,
  SpendLimitError,
  SpendTracker,
  assetKey,
} from './core/spend-limits.js';
export type {
  SpendLimit,
  SpendReservation,
  SpendStatus,
  SpendTrackerOptions,
  SpendTrackerSnapshot,
} from './core/spend-limits.js';

export { walletTools } from './core/tools.js';
export type { WalletTool, WalletToolsOptions } from './core/tools.js';

// solana - the first chain adapter
export {
  SECRET_KEY_LENGTH,
  exportSecretKeyBytes,
  generateSigner,
  secretKeyFromBase58,
  secretKeyToBase58,
  signerFromSecretKeyBytes,
} from './solana/keypair.js';

export { signatureToBase58, verifyMessageSignature } from './solana/messages.js';

export {
  DEFAULT_RPC_URLS,
  explorerAddressUrl,
  explorerClusterSuffix,
  explorerTxUrl,
  rpcUrlFor,
  wsUrlFromHttp,
} from './solana/network.js';
export type { SolanaNetwork } from './solana/network.js';

export { SolanaWallet, TX_FEE_RESERVE_LAMPORTS } from './solana/wallet.js';
export type { SolanaWalletConfig, TransferSolParams, WalletSigner } from './solana/wallet.js';
