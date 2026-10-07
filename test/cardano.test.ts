import { describe, expect, it } from 'vitest';
import fx from './fixtures/ada-real.json';
import { addrToBech32, bech32ToBytes, cardanoFacts, cardanoFromCbor, fetchCardanoTx, fromKoios, type AdaLookup } from '../src/cardano.js';
import { assessRisk, verdict } from '../src/risk.js';
const assess = (f: any) => ({ flags: assessRisk(f), verdict: verdict(assessRisk(f)) });

const txs = (fx as any).txs;
const lookupFor = (k: string): AdaLookup => {
  const t = fromKoios(txs[k].koios)!;
  return { utxos: async () => t.inputs, asset: async () => undefined, tx: async () => txs[k].koios };
};
const codes = (f: any) => assess(f).flags.map((x: any) => x.code);

describe('Cardano (real mainnet transactions)', () => {
  it('round-trips addresses through bech32', () => {
    const a = txs.ada.koios.outputs[0].payment_addr.bech32;
    expect(addrToBech32(bech32ToBytes(a)!)).toBe(a);
  });
  for (const k of ['ada', 'tokens', 'cert']) {
    it(`reads the ${k} transaction the same from CBOR and from its hash`, async () => {
      const a = await cardanoFromCbor(txs[k].cbor, lookupFor(k));
      const b = await fetchCardanoTx(txs[k].hash, lookupFor(k));
      expect(a?.kind).toBe(b.kind);
      expect(a?.recipient).toBe(b.recipient);
    });
  }
  it('a plain ADA payment with change back is a send, not danger', async () => {
    const f = await fetchCardanoTx(txs.ada.hash, lookupFor('ada'));
    expect(f.kind).toBe('native_send');
    expect(f.amount?.display ?? f.amount).toBeTruthy();
    expect(assess(f).verdict).not.toBe('danger');
  });
  it('a wallet consolidating its own tokens is not a sweep', async () => {
    const f = await fetchCardanoTx(txs.tokens.hash, lookupFor('tokens'));
    expect(f.sweep).toBeUndefined();
    expect(assess(f).verdict).not.toBe('danger');
  });
  it('stake key deregistration is a settings change', async () => {
    const f = await fetchCardanoTx(txs.cert.hash, lookupFor('cert'));
    expect(f.kind).toBe('ledger_action');
    expect(assess(f).verdict).not.toBe('danger');
  });
  it('two tokens out to a stranger with none back is a sweep (synthetic, built on real addresses)', async () => {
    const me = txs.tokens.koios.inputs[0].payment_addr.bech32;
    const thief = txs.ada.koios.outputs[1].payment_addr.bech32;
    const A = 'a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235484f534b59';
    const B = '29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c64d494e';
    const f = await cardanoFacts({
      inputs: [{ address: me, lovelace: 5_000_000n, assets: [{ unit: A, qty: 35434310n }, { unit: B, qty: 900n }] }], unresolved: 0,
      outputs: [{ address: thief, lovelace: 3_000_000n, assets: [{ unit: A, qty: 35434310n }, { unit: B, qty: 900n }] }, { address: me, lovelace: 1_800_000n, assets: [] }],
      certs: [], withdrawal: 0n, mint: false,
    }, { asset: async () => undefined });
    expect(f.sweep?.recipient).toBe(thief);
    expect(assess(f).verdict).toBe('danger');
  });
  it('rejects junk hex', async () => {
    expect(await cardanoFromCbor('deadbeef', lookupFor('ada'))).toBeUndefined();
  });
});
