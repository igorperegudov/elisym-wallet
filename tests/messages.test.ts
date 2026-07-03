import { describe, expect, it } from 'vitest';
import { verifyMessageSignature } from '../src/solana/messages.js';
import { SolanaWallet } from '../src/solana/wallet.js';

describe('message signing', () => {
  it('signs and verifies a message', async () => {
    const wallet = await SolanaWallet.generate();
    const signature = await wallet.signMessage('agent identity proof');
    expect(
      await verifyMessageSignature({
        address: wallet.address,
        message: 'agent identity proof',
        signature,
      }),
    ).toBe(true);
  });

  it('rejects a tampered message', async () => {
    const wallet = await SolanaWallet.generate();
    const signature = await wallet.signMessage('original');
    expect(
      await verifyMessageSignature({ address: wallet.address, message: 'tampered', signature }),
    ).toBe(false);
  });

  it('rejects a signature from a different wallet', async () => {
    const wallet = await SolanaWallet.generate();
    const other = await SolanaWallet.generate();
    const signature = await wallet.signMessage('hello');
    expect(
      await verifyMessageSignature({ address: other.address, message: 'hello', signature }),
    ).toBe(false);
  });

  it('returns false for malformed signatures instead of throwing', async () => {
    const wallet = await SolanaWallet.generate();
    expect(
      await verifyMessageSignature({ address: wallet.address, message: 'x', signature: '!!!' }),
    ).toBe(false);
    expect(
      await verifyMessageSignature({ address: wallet.address, message: 'x', signature: 'abc' }),
    ).toBe(false);
  });

  it('returns false for a malformed address instead of throwing', async () => {
    const wallet = await SolanaWallet.generate();
    const signature = await wallet.signMessage('proof');
    // a structurally valid signature but a garbage address must not throw
    expect(await verifyMessageSignature({ address: 'bad!!!', message: 'proof', signature })).toBe(
      false,
    );
    expect(await verifyMessageSignature({ address: '', message: 'proof', signature })).toBe(false);
  });

  it('supports Uint8Array messages', async () => {
    const wallet = await SolanaWallet.generate();
    const bytes = new Uint8Array([1, 2, 3, 255]);
    const signature = await wallet.signMessage(bytes);
    expect(
      await verifyMessageSignature({ address: wallet.address, message: bytes, signature }),
    ).toBe(true);
  });
});
