import { readFileSync } from 'node:fs';
import { Address, beginCell } from '@ton/core';
import { describe, expect, it } from 'vitest';
import { explain } from '../src/explain.js';
import { assessRisk, verdict } from '../src/risk.js';
import { createApp } from '../src/server.js';
import { isTonRequest, tonFacts, type TonLookup, type TonRequest } from '../src/ton.js';

// Real wallet transactions read from toncenter on 6 Oct 2026, turned into the TON Connect request a wallet would sign.
const fx = JSON.parse(readFileSync(new URL('./fixtures/ton-real.json', import.meta.url), 'utf8')) as Record<string, { tx_hash: string; request: TonRequest; comment?: string }>;
const USDT_MASTER = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';
const REAL_USDT_WALLET = '0:284cdc0e48138d3f356af07caf8821cdde3d66e67ac8e6b340455ef545961ff9';
const memStore = () => { const m = new Map<string, unknown>(); return { get: async (k: string) => m.get(k), put: async (k: string, v: unknown) => void m.set(k, v), count: async () => m.size }; };

// Offline stand-ins for toncenter/tonapi.
const NOT_MASTER = '0:2f956143c461769579baef2e32cc2d7bc18283f40d20bb03e432cd603ac33ffc';
const FAKE_NOT_WALLET = '0:' + 'ab'.repeat(32);
const look: TonLookup = {
  jettonWallet: async (r) => (r === REAL_USDT_WALLET ? { master: USDT_MASTER } : r === FAKE_NOT_WALLET ? { master: NOT_MASTER } : undefined),
  jetton: async (m) => (m === NOT_MASTER ? { symbol: 'NOT', decimals: 9 } : undefined),
};

const jettonTransfer = (to: string, amount: bigint) => beginCell().storeUint(0x0f8a7ea5, 32).storeUint(0, 64).storeCoins(amount).storeAddress(Address.parse(to)).storeAddress(Address.parse(to)).storeBit(0).storeCoins(1n).storeBit(0).endCell().toBoc().toString('base64');

describe('TON', () => {
  it('reads a real USDT payment (Telegram Stars on Fragment) with its note', async () => {
    const f = await tonFacts(fx.usdt_stars.request, look);
    expect(f.kind).toBe('transfer');
    expect(f.token?.symbol).toBe('USDT');
    expect(f.amount?.display).toBe('3');
    expect(f.memo).toMatch(/Telegram Stars/);
    expect(verdict(assessRisk(f))).not.toBe('danger');
    expect((await explain(f, assessRisk(f), 'en')).text).toMatch(/sending 3 USDT/);
  });

  it('reads a real TON send with a comment', async () => {
    const f = await tonFacts(fx.ton_comment.request);
    expect(f.kind).toBe('native_send');
    expect(f.token?.symbol).toBe('TON');
    expect(f.amount?.display).toBe('0.05');
    expect(f.memo).toBe(fx.ton_comment.comment);
  });

  // Synthetic: built to the TON Connect and jetton (TEP-74) layouts, because the public drainer kit we found was taken down.
  it('sweeping USDT, NOT and TON to one address in one request is danger', async () => {
    const victim = Address.parse('0:' + '11'.repeat(32)).toString();
    const thief = Address.parse('0:' + '99'.repeat(32)).toString();
    const req: TonRequest = { from: victim, messages: [
      { address: REAL_USDT_WALLET, amount: '50000000', payload: jettonTransfer(thief, 250_000_000n) },
      { address: FAKE_NOT_WALLET, amount: '50000000', payload: jettonTransfer(thief, 9_000_000_000_000n) },
      { address: thief, amount: '41000000000' },
    ] };
    const f = await tonFacts(req, look);
    expect(f.sweep?.assets).toEqual(['USDT', 'NOT', 'TON']);
    const flags = assessRisk(f);
    expect(verdict(flags)).toBe('danger');
    expect((await explain(f, flags, 'en')).text).toMatch(/USDT, NOT, TON to the same address.*Do not sign/);
    expect((await explain(f, flags, 'pcm')).text).toMatch(/No sign am/);
  });

  it('paying two different people at once is a warning, not danger', async () => {
    const req: TonRequest = { messages: [{ address: '0:' + '22'.repeat(32), amount: '1000000000' }, { address: '0:' + '33'.repeat(32), amount: '2000000000' }] };
    const flags = assessRisk(await tonFacts(req));
    expect(verdict(flags)).toBe('warning');
    expect(flags.map((x) => x.code)).toContain('MULTI_SEND');
  });

  it('an address Tonkeeper labels as a scam is STOP', async () => {
    const f = await tonFacts(fx.ton_comment.request, { isScam: async () => true });
    expect(assessRisk(f).map((x) => x.code)).toContain('KNOWN_DRAINER');
  });

  it('does not mistake Tron JSON for a TON request', () => {
    expect(isTonRequest({ raw_data: { contract: [] } })).toBe(false);
    expect(isTonRequest(fx.usdt_stars.request)).toBe(true);
  });

  it('API: pasted TON Connect request and lookup by hash', async () => {
    const app = createApp({ store: memStore(), tonLookup: { ...look, tx: async (h) => (h === fx.usdt_stars.tx_hash ? fx.usdt_stars.request : undefined) } });
    const r1 = await (await app.request('/api/explain/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: JSON.stringify(fx.usdt_stars.request) }) })).json();
    expect(r1.facts.token.symbol).toBe('USDT');
    const r2 = await (await app.request('/api/explain/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: 'auto', hash: fx.usdt_stars.tx_hash, lang: 'pcm' }) })).json();
    expect(r2.explanation.text).toMatch(/3 USDT/);
  });
});

describe('TON request errors', () => {
  it('a mistyped TON address gets a TON error, not a Tron one', async () => {
    const app = createApp({ store: memStore() });
    const res = await app.request('/api/explain/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: JSON.stringify({ messages: [{ address: 'UQAlrvhxyZ0RRiUATGRwd3S7ZdnvaWP1hVvAc0CqVuPYQ6lp', amount: '1' }] }) }) });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/not a valid TON address/);
  });
});

describe('STON.fi (official router list)', () => {
  it('a real liquidity deposit names STON.fi and is not danger', async () => {
    const f = await tonFacts(fx.stonfi_lp.request);
    expect(f.protocol).toBe('STON.fi');
    const flags = assessRisk(f);
    expect(verdict(flags)).not.toBe('danger');
    expect((await explain(f, flags, 'en')).text).toMatch(/official STON.fi router/);
  });
  it('a real TON to jetton swap through pTON reads as TON going to STON.fi', async () => {
    const f = await tonFacts(fx.stonfi_ton_swap.request);
    expect(f.kind).toBe('native_send');
    expect(f.amount?.display).toBe('0.05');
    expect(f.protocol).toBe('STON.fi');
    expect(verdict(assessRisk(f))).not.toBe('danger');
  });
  it('a pTON-looking message to an unknown address stays unreadable', async () => {
    const msg = fx.stonfi_ton_swap.request.messages[0];
    const f = await tonFacts({ messages: [{ ...msg, address: '0:' + '44'.repeat(32) }] });
    expect(f.kind).toBe('unknown_call');
  });
});
