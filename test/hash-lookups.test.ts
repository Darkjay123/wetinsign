import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fetchDotTx, type DotLookup } from '../src/polkadot.js';
import { fetchIcrcTx, parseIcrcRef } from '../src/icp.js';

const dh = JSON.parse(readFileSync('test/fixtures/dot-hash.json', 'utf8'));
const meta = (n: string) => gunzipSync(readFileSync(`test/fixtures/dot-meta-${n}.hex.gz`)).toString('utf8').trim();
const dotLookup: DotLookup = {
  metadata: async (net) => meta(net === 'ah' ? 'ah' : 'relay'),
  scan: async (net, h) => (dh[net].statescan.hash === h ? dh[net].statescan : undefined),
  block: async (net, bh) => { const x = dh[net]; if (x.blockHash !== bh) return undefined; const a: string[] = []; a[x.statescan.indexer.extrinsicIndex] = x.extrinsic; return a; },
  asset: async () => undefined,
};

describe('Polkadot hash lookup (real extrinsics, bytes re-checked against the hash)', () => {
  it('finds an Asset Hub DOT transfer by hash', async () => {
    const f = await fetchDotTx(dh.ah.statescan.hash, dotLookup);
    expect(f.chain).toBe('Polkadot Asset Hub');
    expect(f.kind).toBe('native_send');
    expect(f.from).toBe('151w8qWhfvtnTqWND89AtpBKaU4DkB8Z4RWgUQM8p8oEshuA');
  });
  it('finds a relay-chain extrinsic by hash', async () => {
    const f = await fetchDotTx(dh.relay.statescan.hash, dotLookup);
    expect(f.chain).toBe('Polkadot');
    expect(f.from).toBe('1295XGXkkjnJE1t9NCNrTeqPnSdau7aN44nhg2zqiMASymSD');
  });
  it('refuses when the explorer points at bytes that do not match the hash', async () => {
    const lying: DotLookup = { ...dotLookup, scan: async (net) => (net === 'ah' ? dh.ah.statescan : undefined) };
    await expect(fetchDotTx(dh.relay.statescan.hash, lying)).rejects.toThrow();
  });
  it('rejects junk', async () => { await expect(fetchDotTx('0x12', dotLookup)).rejects.toThrow(); });
});

describe('ICRC token transaction by ledger + number', () => {
  const real = JSON.parse(readFileSync('test/fixtures/icp-real.json', 'utf8')).icrc_by_index['mxzaz-hqaaa-aaaar-qaada-cai:4701469'];
  const lookup = { icrcTx: async (l: string, i: string) => (l === real.ledger_canister_id && i === String(real.index) ? real : undefined), ledger: async () => undefined };
  it('parses the ways people will type it', () => {
    expect(parseIcrcRef('ckBTC 4701469')).toEqual({ ledger: 'mxzaz-hqaaa-aaaar-qaada-cai', index: '4701469' });
    expect(parseIcrcRef('mxzaz-hqaaa-aaaar-qaada-cai 4701469')).toEqual({ ledger: 'mxzaz-hqaaa-aaaar-qaada-cai', index: '4701469' });
    expect(parseIcrcRef('https://dashboard.internetcomputer.org/tokens/mxzaz-hqaaa-aaaar-qaada-cai/transaction/4701469')?.index).toBe('4701469');
    expect(parseIcrcRef('hello')).toBeUndefined();
  });
  it('reads a real ckBTC transfer', async () => {
    const f = await fetchIcrcTx('mxzaz-hqaaa-aaaar-qaada-cai', '4701469', lookup);
    expect(f.kind).toBe('transfer');
    expect(f.token?.symbol).toBe('ckBTC');
    expect(f.amount?.display).toBe('0.00000225');
    expect(f.recipient).toBe('q4x4g-csjny-vihlr-hxjbp-tsklc-weu3x-3kbqq-uls7f-eg233-7geqn-eae');
  });
  it('does not trust a record for a different ledger or number', async () => {
    await expect(fetchIcrcTx('mxzaz-hqaaa-aaaar-qaada-cai', '4701470', lookup)).rejects.toThrow();
  });
});
