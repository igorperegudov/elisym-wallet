/**
 * Solana network configuration: RPC endpoints, WebSocket derivation, explorer URLs.
 */

export type SolanaNetwork = 'mainnet-beta' | 'devnet' | 'testnet';

/** Public RPC endpoints per network. Fine for development; use a dedicated RPC provider in production. */
export const DEFAULT_RPC_URLS: Record<SolanaNetwork, string> = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
};

/** Resolve the default HTTP RPC endpoint for a network. */
export function rpcUrlFor(network: SolanaNetwork): string {
  const url = DEFAULT_RPC_URLS[network];
  if (!url) {
    throw new Error(
      `Unknown Solana network "${network}". Expected mainnet-beta, devnet, or testnet.`,
    );
  }
  return url;
}

/** Derive the WebSocket URL for subscriptions from an HTTP RPC URL. */
export function wsUrlFromHttp(httpUrl: string): string {
  return httpUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
}

/** Explorer query-string suffix for a network. Empty for mainnet (the explorer default). */
export function explorerClusterSuffix(network: SolanaNetwork): string {
  return network === 'mainnet-beta' ? '' : `?cluster=${network}`;
}

/** Solana Explorer URL for a transaction signature. */
export function explorerTxUrl(signature: string, network: SolanaNetwork): string {
  return `https://explorer.solana.com/tx/${signature}${explorerClusterSuffix(network)}`;
}

/** Solana Explorer URL for an account address. */
export function explorerAddressUrl(address: string, network: SolanaNetwork): string {
  return `https://explorer.solana.com/address/${address}${explorerClusterSuffix(network)}`;
}
