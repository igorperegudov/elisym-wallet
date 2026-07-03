/**
 * SolanaWallet - a self-custodied wallet bound to one signer and one network.
 *
 * Covers the wallet surface an autonomous agent needs: balances (SOL + SPL
 * tokens), transfers (SOL + SPL with idempotent recipient ATA creation and
 * optional memos), guardrails (spend limits + policy checks enforced before
 * signing), transaction history, deposit waiting, message signing, and secret
 * key export for backup. All amounts are bigint subunits end-to-end; human
 * decimal strings are accepted at the API boundary and parsed with integer
 * math.
 */

import { getAddMemoInstruction } from '@solana-program/memo';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import {
  address,
  appendTransactionMessageInstructions,
  createSignableMessage,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  isAddress,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import type {
  Commitment,
  Instruction,
  MessagePartialSigner,
  Rpc,
  RpcSubscriptions,
  SolanaRpcApi,
  SolanaRpcSubscriptionsApi,
  TransactionSigner,
} from '@solana/kit';
import type {
  AgentWallet,
  TransactionSummary,
  TransferNativeParams,
  TransferResult,
  TransferTokenParams,
  WaitForDepositParams,
} from '../core/agent-wallet.js';
import { NATIVE_SOL, resolveAmount } from '../core/assets.js';
import type { Asset } from '../core/assets.js';
import { PolicyEngine } from '../core/policy.js';
import type { WalletPolicy } from '../core/policy.js';
import { SpendTracker } from '../core/spend-limits.js';
import type { SpendLimit, SpendReservation } from '../core/spend-limits.js';
import {
  exportSecretKeyBytes,
  generateSigner,
  secretKeyFromBase58,
  secretKeyToBase58,
  signerFromSecretKeyBytes,
} from './keypair.js';
import { signatureToBase58, messageToBytes } from './messages.js';
import { explorerTxUrl, rpcUrlFor, wsUrlFromHttp } from './network.js';
import type { SolanaNetwork } from './network.js';

export type {
  TransactionSummary,
  TransferNativeParams,
  TransferResult,
  TransferTokenParams,
  WaitForDepositParams,
} from '../core/agent-wallet.js';

/**
 * Any kit `TransactionSigner` works: a local keypair, or an external signer
 * (Turnkey, Privy, hardware, multisig) that keeps the key out of this process.
 */
export type WalletSigner = TransactionSigner<string> & Partial<MessagePartialSigner<string>>;

export interface SolanaWalletConfig {
  /** Target network. Default: 'mainnet-beta'. */
  network?: SolanaNetwork;
  /** Custom HTTP RPC endpoint. Default: the public endpoint for `network`. */
  rpcUrl?: string;
  /** Custom WebSocket endpoint. Default: derived from the HTTP endpoint. */
  wsUrl?: string;
  /** Commitment level for reads and confirmations. Default: 'confirmed'. */
  commitment?: Commitment;
  /** Pre-built RPC client (custom transport, tests). Overrides `rpcUrl`. */
  rpc?: Rpc<SolanaRpcApi>;
  /** Pre-built RPC subscriptions client. Overrides `wsUrl`. */
  rpcSubscriptions?: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  /**
   * Per-asset spend caps (session or rolling-window). Transfers that would
   * push the total past a cap are rejected before signing. Ignored when
   * `spendTracker` is also provided.
   */
  spendLimits?: SpendLimit[];
  /**
   * Shared spend tracker. Pass the same instance to several wallets to
   * enforce one budget across all of them (e.g. every wallet an agent
   * process controls).
   */
  spendTracker?: SpendTracker;
  /**
   * Hard transfer rules: per-transfer caps, recipient allow/blocklists, and
   * transfer rate limits. Violations reject before signing.
   */
  policy?: WalletPolicy;
  /**
   * Host hook invoked whenever the spend tracker changes (reservation made,
   * released, or committed). Lets a host persist the budget durably. It is
   * awaited as a WRITE-AHEAD step right after a reservation and BEFORE the
   * transaction is broadcast, so a crash cannot lose a spend that has already
   * left the wallet; a throw here aborts the transfer (fail-closed) before
   * anything is sent. Post-send invocations are best-effort.
   */
  onSpendChange?: () => void | Promise<void>;
}

/** Solana flavor of `TransferNativeParams`; amounts are lamports or SOL decimal strings. */
export type TransferSolParams = TransferNativeParams;

/** On-chain memos are capped by the memo program; reject earlier with a clear error. */
const MAX_MEMO_BYTES = 566;

/** Lamports kept in reserve for the transaction fee when computing "max transferable". */
export const TX_FEE_RESERVE_LAMPORTS = 5_000n;

/**
 * Rent-exempt minimum for a new SPL token account (165 bytes), in lamports. The
 * wallet pays this when a token transfer has to create the recipient's
 * associated token account, so it is charged against the SOL spend cap. This is
 * a stable network constant; slightly over-estimating is safe for a cap (it can
 * only reject a bit early, never allow overspend).
 */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

export class SolanaWallet implements AgentWallet {
  readonly chain = 'solana';
  readonly nativeAsset: Asset = NATIVE_SOL;
  readonly signer: WalletSigner;
  readonly network: SolanaNetwork;
  readonly rpc: Rpc<SolanaRpcApi>;
  /** Spend caps and counters. Shared when `config.spendTracker` was provided. */
  readonly spendTracker: SpendTracker;

  private readonly policyEngine?: PolicyEngine;
  private readonly secretKeyBytes?: Uint8Array;
  private readonly commitment: Commitment;
  private readonly wsUrl: string;
  private readonly onSpendChange?: () => void | Promise<void>;
  /** Serializes `onSpendChange` calls so overlapping transfers persist in order. */
  private persistChain: Promise<unknown> = Promise.resolve();
  private rpcSubscriptions?: RpcSubscriptions<SolanaRpcSubscriptionsApi>;

  private constructor(
    signer: WalletSigner,
    secretKeyBytes: Uint8Array | undefined,
    config: SolanaWalletConfig,
  ) {
    this.signer = signer;
    this.secretKeyBytes = secretKeyBytes;
    this.network = config.network ?? 'mainnet-beta';
    this.commitment = config.commitment ?? 'confirmed';
    const httpUrl = config.rpcUrl ?? rpcUrlFor(this.network);
    this.rpc = config.rpc ?? createSolanaRpc(httpUrl);
    this.wsUrl = config.wsUrl ?? wsUrlFromHttp(httpUrl);
    this.rpcSubscriptions = config.rpcSubscriptions;
    this.spendTracker = config.spendTracker ?? new SpendTracker(config.spendLimits ?? []);
    this.policyEngine = config.policy
      ? new PolicyEngine(config.policy, { isValidAddress: isAddress })
      : undefined;
    this.onSpendChange = config.onSpendChange;
  }

  /** Generate a wallet with a fresh keypair. */
  static async generate(config: SolanaWalletConfig = {}): Promise<SolanaWallet> {
    const signer = await generateSigner();
    const bytes = await exportSecretKeyBytes(signer);
    return new SolanaWallet(signer, bytes, config);
  }

  /** Restore a wallet from a 64-byte secret key (solana-keygen format). */
  static async fromSecretKeyBytes(
    bytes: Uint8Array,
    config: SolanaWalletConfig = {},
  ): Promise<SolanaWallet> {
    const signer = await signerFromSecretKeyBytes(bytes);
    return new SolanaWallet(signer, new Uint8Array(bytes), config);
  }

  /** Restore a wallet from a base58-encoded secret key. */
  static async fromBase58(
    secretKey: string,
    config: SolanaWalletConfig = {},
  ): Promise<SolanaWallet> {
    return SolanaWallet.fromSecretKeyBytes(secretKeyFromBase58(secretKey), config);
  }

  /**
   * Wrap an external signer (Turnkey, Privy, hardware wallet, multisig - any
   * kit `TransactionSigner`). The private key never enters this process, so
   * `exportSecretKeyBytes()` / `exportBase58()` are unavailable and
   * `signMessage()` works only if the signer also implements `signMessages`.
   */
  static fromSigner(signer: WalletSigner, config: SolanaWalletConfig = {}): SolanaWallet {
    return new SolanaWallet(signer, undefined, config);
  }

  /** Wallet address (base58). */
  get address(): string {
    return this.signer.address;
  }

  /** Validate a base58 Solana address. */
  isValidAddress(value: string): boolean {
    return isAddress(value);
  }

  /** True when the secret key lives in this process and can be exported. */
  get canExportSecretKey(): boolean {
    return this.secretKeyBytes !== undefined;
  }

  /**
   * Copy of the 64-byte secret key for backup. Handle with care; see `scrub()`.
   * Throws for wallets built with `fromSigner()` - the key is external.
   */
  exportSecretKeyBytes(): Uint8Array {
    if (!this.secretKeyBytes) {
      throw new Error('Secret key is not available: this wallet uses an external signer.');
    }
    return new Uint8Array(this.secretKeyBytes);
  }

  /** Base58-encoded secret key for backup (solana-keygen compatible). */
  exportBase58(): string {
    if (!this.secretKeyBytes) {
      throw new Error('Secret key is not available: this wallet uses an external signer.');
    }
    return secretKeyToBase58(this.secretKeyBytes);
  }

  /**
   * Best-effort scrub of the in-memory secret key copy. The wallet can still
   * sign afterwards (the WebCrypto key survives), but export methods will
   * return zeroed bytes.
   */
  scrub(): void {
    this.secretKeyBytes?.fill(0);
  }

  /** SOL balance in lamports. */
  async getBalance(): Promise<bigint> {
    const { value } = await this.rpc
      .getBalance(address(this.address), { commitment: this.commitment })
      .send();
    return value;
  }

  /**
   * SPL token balance in raw subunits, summed across all of the wallet's token
   * accounts for the mint. Returns 0n when no token account exists yet.
   */
  async getTokenBalance(assetOrMint: Asset | string): Promise<bigint> {
    const mint = typeof assetOrMint === 'string' ? assetOrMint : assetOrMint.mint;
    if (!mint) {
      throw new Error(
        `Asset "${typeof assetOrMint === 'string' ? assetOrMint : assetOrMint.symbol}" has no mint. ` +
          'Use getBalance() for native SOL.',
      );
    }
    const response = await this.rpc
      .getTokenAccountsByOwner(
        address(this.address),
        { mint: address(mint) },
        { encoding: 'jsonParsed', commitment: this.commitment },
      )
      .send();
    let total = 0n;
    for (const entry of response.value) {
      const parsed = entry.account.data as
        | { parsed?: { info?: { tokenAmount?: { amount?: string } } } }
        | undefined;
      const raw = parsed?.parsed?.info?.tokenAmount?.amount;
      if (typeof raw === 'string') {
        total += BigInt(raw);
      }
    }
    return total;
  }

  /**
   * Dry-run the guardrails for a prospective transfer: recipient validity,
   * positive amount, policy rules, and spend limits. Throws exactly what the
   * real transfer would throw (`PolicyViolationError` / `SpendLimitError`),
   * but reserves nothing and touches no network. Lets agents and preview
   * flows fail fast instead of discovering the rejection after confirmation.
   */
  checkTransfer(asset: Asset, amount: bigint | string, to: string): void {
    assertRecipientAddress(to);
    const resolved = resolveAmount(asset, amount);
    assertPositiveAmount(asset.symbol, resolved);
    this.policyEngine?.checkTransfer(asset, resolved, to);
    this.spendTracker.assertCanSpend(asset, resolved);
  }

  /**
   * Lamports spendable after keeping the transaction-fee reserve
   * (`TX_FEE_RESERVE_LAMPORTS`). The safe amount for "send everything".
   */
  async getMaxTransferableSol(): Promise<bigint> {
    const balance = await this.getBalance();
    return balance > TX_FEE_RESERVE_LAMPORTS ? balance - TX_FEE_RESERVE_LAMPORTS : 0n;
  }

  /**
   * Transfer native SOL. Signs, sends, and waits for confirmation. Guardrails
   * (policy, then spend limits) run before signing and reject with
   * `PolicyViolationError` / `SpendLimitError`.
   *
   * Only the transferred `amount` is charged against the SOL cap, not the
   * ~5000-lamport network fee: counting the fee would make "send exactly the
   * cap" fail, and the fee is negligible and non-reclaimable (it goes to the
   * validator, not a recipient), so it is not a drain vector the way a token
   * transfer's reclaimable ATA rent is.
   */
  async transferNative(params: TransferNativeParams): Promise<TransferResult> {
    assertRecipientAddress(params.to);
    const amount = resolveAmount(NATIVE_SOL, params.amount);
    assertPositiveAmount(NATIVE_SOL.symbol, amount);

    const transferIx = getTransferSolInstruction({
      source: this.signer,
      destination: address(params.to),
      amount,
    });
    const instructions = withMemo([transferIx as unknown as Instruction], params.memo);
    return this.sendGuarded(NATIVE_SOL, amount, params.to, instructions);
  }

  /** Solana-flavored alias of `transferNative`. */
  async transferSol(params: TransferSolParams): Promise<TransferResult> {
    return this.transferNative(params);
  }

  /**
   * Transfer an SPL token to a wallet address. Creates the recipient's
   * associated token account idempotently (this wallet pays the rent when the
   * account does not exist yet), then performs a checked transfer. Guardrails
   * (policy, then spend limits) run before signing.
   *
   * The SOL the wallet spends on this transfer - the transaction fee plus the
   * one-time ATA rent when the recipient has no token account yet - is charged
   * against the SOL spend cap too, so a flood of token transfers to fresh
   * recipients cannot drain SOL past its cap via reclaimable ATA rent.
   */
  async transferToken(params: TransferTokenParams): Promise<TransferResult> {
    assertRecipientAddress(params.to);
    const { asset } = params;
    if (!asset.mint) {
      throw new Error(`Asset "${asset.symbol}" has no mint. Use transferSol() for native SOL.`);
    }
    const amount = resolveAmount(asset, params.amount);
    assertPositiveAmount(asset.symbol, amount);

    const mintAddr = address(asset.mint);
    const destinationOwner = address(params.to);
    const [sourceAta] = await findAssociatedTokenPda({
      owner: address(this.address),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      mint: mintAddr,
    });
    const [destinationAta] = await findAssociatedTokenPda({
      owner: destinationOwner,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      mint: mintAddr,
    });

    const createsAta = !(await this.accountExists(destinationAta));
    const solCost = TX_FEE_RESERVE_LAMPORTS + (createsAta ? TOKEN_ACCOUNT_RENT_LAMPORTS : 0n);

    const createAtaIx = getCreateAssociatedTokenIdempotentInstruction(
      {
        payer: this.signer,
        ata: destinationAta,
        owner: destinationOwner,
        mint: mintAddr,
      },
      { programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS },
    );
    const transferIx = getTransferCheckedInstruction({
      source: sourceAta,
      mint: mintAddr,
      destination: destinationAta,
      authority: this.signer,
      amount,
      decimals: asset.decimals,
    });
    const instructions = withMemo(
      [createAtaIx, transferIx] as unknown as Instruction[],
      params.memo,
    );
    return this.sendGuarded(asset, amount, params.to, instructions, {
      asset: NATIVE_SOL,
      amount: solCost,
    });
  }

  /**
   * True when an account exists on-chain (used to know if a token transfer pays
   * ATA rent). This is a pre-flight check, so it is a TOCTOU with the on-chain
   * state at execution: a recipient who creates then closes their ATA between
   * the check and the broadcast can make the wallet pay ~0.002 SOL of rent that
   * the SOL cap did not count. The exposure is bounded (one ATA rent per
   * transfer, rate-limitable) and requires the attacker to be the transfer's
   * recipient, so it is neutralized by a recipient allowlist; over-reserving
   * rent unconditionally would instead penalize every legitimate repeat payee.
   */
  private async accountExists(account: string): Promise<boolean> {
    const { value } = await this.rpc
      .getAccountInfo(address(account), { commitment: this.commitment, encoding: 'base64' })
      .send();
    return value !== null;
  }

  /**
   * Recent transactions touching this wallet, newest first. Includes memos,
   * which makes memo-tagged transfers a lightweight audit trail for agents.
   */
  async getRecentTransactions(limit = 10): Promise<TransactionSummary[]> {
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
      throw new Error(`limit must be an integer between 1 and 1000; got ${limit}`);
    }
    // getSignaturesForAddress accepts only 'confirmed' | 'finalized'.
    const commitment = this.commitment === 'processed' ? 'confirmed' : this.commitment;
    const response = await this.rpc
      .getSignaturesForAddress(address(this.address), { limit, commitment })
      .send();
    return response.map((entry) => ({
      signature: entry.signature,
      slot: entry.slot,
      blockTime: entry.blockTime === null ? null : Number(entry.blockTime),
      err: entry.err === null ? null : JSON.stringify(entry.err),
      memo: entry.memo,
      confirmationStatus: entry.confirmationStatus ?? null,
      explorerUrl: this.explorerUrl(entry.signature),
    }));
  }

  /**
   * Poll until the balance reaches `amount`, then resolve with that balance.
   * Rejects on timeout or abort. Useful for agents waiting to be funded.
   */
  async waitForDeposit(params: WaitForDepositParams): Promise<bigint> {
    const asset = params.asset ?? NATIVE_SOL;
    const target = resolveAmount(asset, params.amount);
    const timeoutMs = params.timeoutMs ?? 120_000;
    const pollIntervalMs = params.pollIntervalMs ?? 2_500;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      if (params.signal?.aborted) {
        throw new Error('waitForDeposit aborted.');
      }
      const balance = params.asset ? await this.getTokenBalance(asset) : await this.getBalance();
      if (balance >= target) {
        return balance;
      }
      if (Date.now() + pollIntervalMs > deadline) {
        throw new Error(
          `waitForDeposit timed out after ${timeoutMs}ms: ` +
            `balance is ${balance} of ${target} required ${asset.symbol} subunits.`,
        );
      }
      await sleep(pollIntervalMs, params.signal);
    }
  }

  /**
   * Sign an arbitrary off-chain message; returns the base58 Ed25519 signature.
   * Verify with `verifyMessageSignature()`. Lets the wallet prove ownership of
   * its address (agent identity, API authentication) without a transaction.
   */
  async signMessage(message: string | Uint8Array): Promise<string> {
    const { signMessages } = this.signer;
    if (!signMessages) {
      throw new Error('This signer does not support message signing.');
    }
    const [signatures] = await signMessages([createSignableMessage(messageToBytes(message))]);
    const signature = signatures?.[this.signer.address as keyof typeof signatures];
    if (!signature) {
      throw new Error('Signer returned no signature for this wallet address.');
    }
    return signatureToBase58(signature);
  }

  /** Solana Explorer link for a transaction signature on this wallet's network. */
  explorerUrl(signature: string): string {
    return explorerTxUrl(signature, this.network);
  }

  private subscriptions(): RpcSubscriptions<SolanaRpcSubscriptionsApi> {
    this.rpcSubscriptions ??= createSolanaRpcSubscriptions(this.wsUrl);
    return this.rpcSubscriptions;
  }

  /**
   * Run guardrails, send, and settle the spend reservation.
   *
   * Order matters. Policy checks are read-only and run first (a policy
   * rejection must not consume spend budget). The spend amount is then reserved
   * atomically BEFORE signing so a concurrent transfer sees the updated counter
   * and cannot double-spend the remaining budget, and the reservation is
   * persisted write-ahead (via `onSpendChange`) before anything is broadcast.
   *
   * The release policy is deliberately asymmetric around the broadcast:
   *
   *   - a failure BEFORE the transaction can reach the network (blockhash
   *     fetch, signing, or a failed write-ahead persist) releases the
   *     reservation - the transfer provably did not happen;
   *   - a failure DURING OR AFTER broadcast (send error, confirmation timeout,
   *     websocket drop) does NOT release. Those errors do not prove the
   *     transaction failed to land; releasing an ambiguous failure would let a
   *     transaction that actually confirmed be spent a second time against the
   *     cap. The reservation stands, erring toward the safe side of the budget.
   *
   * `feeReservation` (token transfers) charges the transfer's SOL cost - fee
   * plus any new-ATA rent - against the SOL cap alongside the token amount.
   * Reservations are released by their handle, so an in-flight sibling transfer
   * is never affected. Threshold warnings are computed only after broadcast.
   */
  private async sendGuarded(
    asset: Asset,
    amount: bigint,
    recipient: string,
    instructions: Instruction[],
    feeReservation?: { asset: Asset; amount: bigint },
  ): Promise<TransferResult> {
    this.policyEngine?.checkTransfer(asset, amount, recipient);

    const reservations: SpendReservation[] = [];
    try {
      reservations.push(this.spendTracker.reserve(asset, amount));
      if (feeReservation && feeReservation.amount > 0n) {
        reservations.push(this.spendTracker.reserve(feeReservation.asset, feeReservation.amount));
      }
    } catch (e) {
      // One reservation exceeded its cap; roll back any that already succeeded.
      this.releaseAll(reservations);
      throw e;
    }

    // Durably record the reservations before any funds can move. If this fails
    // the transfer has not been sent, so release and abort (fail-closed).
    try {
      await this.persistSpendState();
    } catch (e) {
      this.releaseAll(reservations);
      throw e;
    }
    this.policyEngine?.recordTransfer();

    let signedTx: SignedTransaction;
    try {
      signedTx = await this.prepareTransaction(instructions);
    } catch (e) {
      // Nothing left the wallet yet: safe to return the reservations.
      this.releaseAll(reservations);
      await this.persistSpendState().catch(() => {});
      throw e;
    }

    // Past this point the transaction may confirm on-chain even if the call
    // below throws, so the reservations are intentionally NOT released on error.
    const sent = await this.broadcastTransaction(signedTx);
    const spendWarnings = [
      ...this.spendTracker.takeWarnings(asset),
      ...(feeReservation ? this.spendTracker.takeWarnings(feeReservation.asset) : []),
    ];
    // Best-effort: the reservations are already durable from the write-ahead step.
    await this.persistSpendState().catch(() => {});
    return { ...sent, spendWarnings };
  }

  /** Release each reservation by its handle (order-independent, concurrency-safe). */
  private releaseAll(reservations: SpendReservation[]): void {
    for (const reservation of reservations) {
      this.spendTracker.release(reservation);
    }
  }

  /**
   * Fire the host's spend-persistence hook, if any, SERIALIZED against other
   * calls on this wallet. Overlapping in-process transfers must not run their
   * `onSpendChange` (which snapshots + atomically writes the ledger)
   * concurrently: unordered renames could land an older snapshot last and drop a
   * committed reservation. Chaining makes each persist run after the previous,
   * capturing the latest state; the caller still sees this persist's outcome.
   */
  private async persistSpendState(): Promise<void> {
    if (!this.onSpendChange) {
      return;
    }
    const run = this.persistChain.then(
      () => this.onSpendChange!(),
      () => this.onSpendChange!(),
    );
    // Keep the chain from staying rejected so a single failure does not wedge
    // every subsequent persist.
    this.persistChain = run.then(
      () => {},
      () => {},
    );
    await run;
  }

  /** Build and sign the transaction. Failures here mean nothing was broadcast. */
  private async prepareTransaction(instructions: Instruction[]): Promise<SignedTransaction> {
    const { value: latestBlockhash } = await this.rpc.getLatestBlockhash().send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayerSigner(this.signer, msg),
      (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => appendTransactionMessageInstructions(instructions, msg),
    );
    return signTransactionMessageWithSigners(message);
  }

  /**
   * Broadcast a signed transaction and wait for confirmation. A throw here does
   * NOT guarantee the transaction failed to land - callers must not release the
   * spend reservation on this path.
   */
  private async broadcastTransaction(
    signedTx: SignedTransaction,
  ): Promise<{ signature: string; explorerUrl: string }> {
    const sendAndConfirm = sendAndConfirmTransactionFactory({
      rpc: this.rpc,
      rpcSubscriptions: this.subscriptions(),
    });
    await sendAndConfirm(signedTx as Parameters<typeof sendAndConfirm>[0], {
      commitment: this.commitment,
    });
    const signature = getSignatureFromTransaction(
      signedTx as Parameters<typeof getSignatureFromTransaction>[0],
    );
    return { signature, explorerUrl: this.explorerUrl(signature) };
  }
}

type SignedTransaction = Awaited<ReturnType<typeof signTransactionMessageWithSigners>>;

function withMemo(instructions: Instruction[], memo: string | undefined): Instruction[] {
  if (memo === undefined) {
    return instructions;
  }
  const bytes = new TextEncoder().encode(memo).length;
  if (bytes === 0) {
    throw new Error('memo must not be empty when provided.');
  }
  if (bytes > MAX_MEMO_BYTES) {
    throw new Error(`memo too long: ${bytes} bytes (max ${MAX_MEMO_BYTES}).`);
  }
  return [...instructions, getAddMemoInstruction({ memo }) as unknown as Instruction];
}

function assertRecipientAddress(value: string): void {
  if (!isAddress(value)) {
    throw new Error(`"${value}" is not a valid Solana address.`);
  }
}

function assertPositiveAmount(symbol: string, amount: bigint): void {
  if (amount <= 0n) {
    throw new Error(`${symbol} amount must be positive.`);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('waitForDeposit aborted.'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
