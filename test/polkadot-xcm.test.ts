import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { TypeRegistry, Metadata } from '@polkadot/types';
import { dotFacts } from '../src/polkadot.js';
import { assessRisk } from '../src/risk.js';
import { templateText } from '../src/explain.js';

// Real Polkadot Asset Hub extrinsics (statescan index, raw bytes from a public node, blake2-checked), 7 Oct 2026.
const meta = gunzipSync(readFileSync('test/fixtures/dot-meta-ah.hex.gz')).toString('utf8').trim();
const reg = new TypeRegistry(); reg.setMetadata(new Metadata(reg, meta as any));
const lookup = { metadata: async () => meta, asset: async (id: string) => ({ '1984': { symbol: 'USDt', decimals: 6 }, '1337': { symbol: 'USDC', decimals: 6 } } as any)[id] };
const d = JSON.parse(readFileSync('test/fixtures/dot-xcm.json', 'utf8'));
const byHash = (h: string) => Object.values<any>(d).flat().find((x: any) => x?.hash?.startsWith(h));
const read = async (h: string) => { const x = byHash(h); const e: any = reg.createType('Extrinsic', x.extrinsic); const f = await dotFacts({ net: 'ah', call: e.method.toHex(), signer: e.signer.toString() }, lookup as any); const fl = assessRisk(f); return { f, fl, en: templateText(f, fl, 'en'), pcm: templateText(f, fl, 'pcm') }; };

describe('Polkadot cross-chain sends (XCM), real mainnet', () => {
  it('USDt to Hydration via limitedReserveTransferAssets', async () => {
    const { f, en } = await read('0x631b48df');
    expect(f.kind).toBe('transfer'); expect(f.token?.symbol).toBe('USDt'); expect(f.amount?.display).toBe('19,634.54016'); expect(f.toChain).toBe('Hydration');
    expect(en).toContain('lands on Hydration');
  });
  it('KSM over the bridge to Kusama Asset Hub', async () => {
    const { f } = await read('0xb5ad0e86');
    expect(f.token?.symbol).toBe('KSM'); expect(f.amount?.display).toBe('1.2'); expect(f.toChain).toBe('Kusama Asset Hub');
  });
  it('DOT teleport to the relay chain and to system chains', async () => {
    expect((await read('0x4c52fa0d')).f).toMatchObject({ kind: 'native_send', toChain: 'the Polkadot relay chain' });
    expect((await read('0x2a697856')).f).toMatchObject({ kind: 'native_send', toChain: 'Polkadot People' });
  });
  it('transferAssetsUsingTypeAndThen finds the receiver inside DepositAsset', async () => {
    const { f, pcm } = await read('0xa1ba1294');
    expect(f.toChain).toBe('Acala'); expect(f.token?.symbol).toBe('USDt'); expect(f.recipient).toMatch(/^1/);
    expect(pcm).toContain('E go land for Acala');
  });
  it('a token it cannot identify says so instead of printing a huge raw number', async () => {
    const { f, en } = await read('0x62c8779a');
    expect(f.amount?.display).toBe('some'); expect(f.toChain).toBe('Polkadot parachain 3377');
    expect(en).not.toMatch(/\d{12,}/);
  });
});

describe('Polkadot proxies, real mainnet', () => {
  it('a real Any proxy grant is danger; a Staking proxy is a warning', async () => {
    expect((await read('0x85a3650d')).fl.map((x) => x.code)).toContain('ACCOUNT_TAKEOVER');
    expect((await read('0x8ecffe56')).fl.map((x) => x.code)).toContain('PERMISSION_SHARED');
  });
  it('acting as a proxy: the money moved is the real account\'s, and a batch of one reads as one action', async () => {
    const { f, en } = await read('0x76c5095e');
    expect(f.from).toBe('13CAFrMmwRv8nBZEdz2DLKPsfkG38Go28rqxRbvMnufxxe58');
    expect(f.amount?.display).toBe('1,047.294967');
    expect(en).not.toContain('1 actions');
  });
});
