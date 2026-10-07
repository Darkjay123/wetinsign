import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { decorateExtrinsics } from '@polkadot/types/metadata/decorate';
import fx from './fixtures/dot-real.json';
import { dotFacts, GENESIS, parseDot, type DotLookup } from '../src/polkadot.js';
import { assessRisk, verdict } from '../src/risk.js';

const meta = (n: string) => zlib.gunzipSync(fs.readFileSync(`test/fixtures/dot-meta-${n}.hex.gz`)).toString();
// USDt (1984) and USDC (1337) symbols/decimals as read live from Asset Hub storage by the lookup on 7 Oct 2026.
const ASSETS: Record<string, { symbol: string; decimals: number }> = { '1984': { symbol: 'USDt', decimals: 6 }, '1337': { symbol: 'USDC', decimals: 6 } };
const lookup: DotLookup = { metadata: async (n) => meta(n), asset: async (id) => ASSETS[id] };
const C = (fx as any).calls;
const judge = (f: any) => { const flags = assessRisk(f); return { codes: flags.map((x) => x.code), v: verdict(flags) }; };
const reg = new TypeRegistry();
const md = new Metadata(reg, meta('ah') as `0x${string}`);
reg.setMetadata(md);
const tx = decorateExtrinsics(reg, md.asLatest, md.version) as any;
const me = '14E5nqKAp3oAJcmzgZhUD2RcptBeUBScxKHgJKU4HPNcKVf3';
const thief = '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5';
const req = (call: string) => parseDot({ address: me, genesisHash: GENESIS.ah, method: call })!;

describe('Polkadot (real Asset Hub and relay calls)', () => {
  it('reads a real DOT transferKeepAlive from a Polkadot.js signPayload', async () => {
    const r = C['ah|balances.transferKeepAlive'];
    const f = await dotFacts(parseDot({ address: r.signer, genesisHash: GENESIS.ah, method: r.call, specVersion: '0x1' })!, lookup);
    expect(f.kind).toBe('native_send');
    expect(f.token?.symbol).toBe('DOT');
    expect(f.recipient).toMatch(/^1/);
    expect(judge(f).v).not.toBe('danger');
  });
  it('reads a real transferAllowDeath', async () => {
    const r = C['ah|balances.transferAllowDeath'];
    const f = await dotFacts(parseDot({ address: r.signer, genesisHash: GENESIS.ah, method: r.call })!, lookup);
    expect(f.kind).toBe('native_send');
  });
  it('reads a real assets.transfer', async () => {
    const r = C['ah|assets.transfer'];
    const f = await dotFacts(parseDot({ address: r.signer, genesisHash: GENESIS.ah, method: r.call })!, lookup);
    expect(f.kind).toBe('transfer');
    expect(judge(f).v).not.toBe('danger');
  });
  it('real remarks are harmless', async () => {
    for (const k of ['ah|system.remark', 'ah|system.remarkWithEvent']) {
      const f = await dotFacts(parseDot({ address: C[k].signer, genesisHash: GENESIS.ah, method: C[k].call })!, lookup);
      expect(judge(f).v).not.toBe('danger');
    }
  });
  it('finds the relay runtime when no genesis hash is given', async () => {
    const f = await dotFacts(parseDot(C['relay|onDemand.placeOrderKeepAlive'].call, true)!, lookup);
    expect(f.chain).toBe('Polkadot');
    expect(f.appName).toBe('onDemand.placeOrderKeepAlive');
  });
});

describe('Polkadot scam shapes (synthetic content, real Asset Hub runtime encoding)', () => {
  it('proxy.addProxy Any to a stranger is account takeover', async () => {
    const f = await dotFacts(req(tx.proxy.addProxy(thief, 'Any', 0).toHex()), lookup);
    expect(f.control).toBe('proxy');
    expect(f.spender).toBe(thief);
    expect(judge(f).codes).toContain('ACCOUNT_TAKEOVER');
    expect(judge(f).v).toBe('danger');
  });
  it('a Staking proxy is a warning, not danger', async () => {
    const f = await dotFacts(req(tx.proxy.addProxy(thief, 'Staking', 0).toHex()), lookup);
    expect(judge(f).v).toBe('warning');
  });
  it('a batch sending DOT, USDt and USDC to one stranger is a sweep', async () => {
    const calls = [tx.balances.transferAll(thief, false), tx.assets.transfer(1984, thief, 500_000_000n), tx.assets.transfer(1337, thief, 250_000_000n)];
    const f = await dotFacts(req(tx.utility.batchAll(calls).toHex()), lookup);
    expect(f.sweep?.recipient).toBe(thief);
    expect(judge(f).v).toBe('danger');
  });
  it('a takeover hidden in a batch with a small transfer is still found', async () => {
    const f = await dotFacts(req(tx.utility.batch([tx.balances.transferKeepAlive(thief, 10_000_000_000n), tx.proxy.addProxy(thief, 'Any', 0)]).toHex()), lookup);
    expect(judge(f).v).toBe('danger');
  });
  it('an unlimited asset approval reads as unlimited', async () => {
    const f = await dotFacts(req(tx.assets.approveTransfer(1984, thief, 2n ** 128n - 1n).toHex()), lookup);
    expect(judge(f).codes).toContain('UNLIMITED_APPROVAL');
  });
  it('balances.transferAll alone warns that it sends everything', async () => {
    const f = await dotFacts(req(tx.balances.transferAll(thief, false).toHex()), lookup);
    expect(judge(f).codes).toContain('SENDS_ALL');
  });
  it('a batch paying two different people is a multi-send, not a sweep', async () => {
    const f = await dotFacts(req(tx.utility.batchAll([tx.balances.transferKeepAlive(thief, 10_000_000_000n), tx.balances.transferKeepAlive(me, 10_000_000_000n)]).toHex()), lookup);
    expect(f.sweep).toBeUndefined();
    expect(judge(f).codes).toContain('MULTI_SEND');
  });
  it('ignores hex that is not Polkadot', async () => {
    expect(parseDot('0xa9059cbb', false)).toBeUndefined();
    await expect(dotFacts({ call: '0xffff0000' }, lookup)).rejects.toThrow();
  });
});
