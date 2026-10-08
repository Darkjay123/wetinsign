import { describe, expect, it } from 'vitest';
import { chunks, protect, translateSafely } from '../src/translate.js';
import { createApp } from '../src/server.js';

const memStore = () => { const m = new Map<string, unknown>(); return { get: async (k: string) => m.get(k), put: async (k: string, v: unknown) => { m.set(k, v); }, count: async () => m.size }; };

describe('safe machine translation', () => {
  it('locks amounts, addresses, symbols and names', () => {
    const { masked, spans } = protect('You are giving 0x2222…2222 permission to take 1,603.85196 USDt on Polkadot Asset Hub. Fee 0.5%.', ['USDt', 'Polkadot Asset Hub']);
    expect(spans).toEqual(expect.arrayContaining(['0x2222…2222', '1,603.85196', 'USDt', 'Polkadot Asset Hub', '0.5%']));
    expect(masked).not.toMatch(/\d{2}|USDt|Polkadot/);
  });
  it('restores the exact figures after translation', async () => {
    const fake = async (t: string) => t.replace('You are giving', 'Vous donnez').replace('permission to take', 'la permission de prendre');
    const out = await translateSafely('You are giving 0xabc…def permission to take 25.5 USDC.', 'fr', ['USDC'], fake);
    expect(out).toBe('Vous donnez 0xabc…def la permission de prendre 25.5 USDC.');
  });
  it('refuses a translation that drops or duplicates a locked figure', async () => {
    expect(await translateSafely('Send 10 USDC to 0x1111…1111.', 'es', ['USDC'], async (t) => t.replace('[2]', ''))).toBeNull();
    expect(await translateSafely('Send 11 USDC.', 'es', ['USDC'], async (t) => t + ' [1]')).toBeNull();
    expect(await translateSafely('Send 12 USDC.', 'es', ['USDC'], async () => null)).toBeNull();
  });
  it('splits long text on sentence boundaries under the size limit', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const cs = chunks(text, 120);
    expect(cs.every((c) => c.length <= 120)).toBe(true);
    expect(cs.join(' ')).toBe(text);
  });
});

describe('server translation layer', () => {
  const permit = { domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }, primaryType: 'Permit',
    message: { owner: '0x1111111111111111111111111111111111111111', spender: '0x2222222222222222222222222222222222222222', value: '1000000', nonce: 0, deadline: '1999999999' } };
  const post = (app: any, lang: string) => app.request('/api/explain/signature', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ typedData: permit, lang }) });
  it('translates text, keeps the English original and every figure', async () => {
    const app = createApp({ store: memStore() as any, translate: async (t) => `«${t}»` });
    const j = await (await post(app, 'fr')).json();
    expect(j.explanation.machineTranslated).toBe(true);
    expect(j.explanation.lang).toBe('fr');
    expect(j.explanation.original).toMatch(/USDC/);
    for (const n of j.explanation.original.match(/\d[\d,.]*/g) ?? []) expect(j.explanation.text).toContain(n);
    expect(j.explanation.heading).toHaveLength(2);
  });
  it('falls back to English with a note when translation fails', async () => {
    const app = createApp({ store: memStore() as any, translate: async () => null });
    const j = await (await post(app, 'es')).json();
    expect(j.explanation.machineTranslated).toBeUndefined();
    expect(j.explanation.translationNote).toMatch(/Español/);
  });
  it('leaves English and Pidgin untouched and lists languages', async () => {
    let called = 0;
    const app = createApp({ store: memStore() as any, translate: async (t) => { called++; return t; } });
    await post(app, 'en'); await post(app, 'pcm');
    expect(called).toBe(0);
    const ls = await (await app.request('/api/languages')).json();
    expect(ls.map((l: any) => l.code)).toEqual(expect.arrayContaining(['en', 'pcm', 'fr', 'yo', 'ha', 'ig', 'zh-CN']));
  });
});
