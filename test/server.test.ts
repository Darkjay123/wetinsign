import { describe, expect, it } from 'vitest';
import { encodeFunctionData, maxUint256, parseAbi } from 'viem';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const SPENDER = '0x2222222222222222222222222222222222222222';
const data = encodeFunctionData({ abi: parseAbi(['function approve(address spender, uint256 amount)']), functionName: 'approve', args: [SPENDER, maxUint256] });

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('api', () => {
  it('serves the page and health check', async () => {
    const app = createApp({ store: createStore('') });
    expect((await app.request('/')).status).toBe(200);
    expect(await (await app.request('/healthz')).json()).toMatchObject({ ok: true, ai: false });
  });

  it('explains a raw call and caches it', async () => {
    const app = createApp({ store: createStore(''), isContract: async () => true });
    const first = await (await post(app, '/api/explain/call', { chainId: 1, to: USDT, data, lang: 'pcm' })).json();
    expect(first.explanation.verdict).toBe('danger');
    expect(first.explanation.text).toContain('Wahala dey');
    const second = await (await post(app, '/api/explain/call', { chainId: 1, to: USDT, data, lang: 'pcm' })).json();
    expect(second.cached).toBe(true);
  });

  it('looks up a transaction by hash through the injected fetcher', async () => {
    const app = createApp({ store: createStore(''), fetchTx: async (chainId) => ({ chainId, to: USDT, data, value: 0n }) });
    const r = await post(app, '/api/explain/tx', { chainId: 1, hash: '0x' + 'ab'.repeat(32) });
    expect(r.status).toBe(200);
    expect((await r.json()).facts.kind).toBe('erc20_approve');
  });

  it('a type-4 transaction that points an account at unknown sweeper code reads as danger', async () => {
    const app = createApp({ store: createStore(''), fetchTx: async (chainId) => ({ chainId, to: USDT, data, value: 0n, authorizations: [{ address: '0x9EA61f15CdbaF5D2039771381FA2AdCFb1b76321', chainId: 1 }] }) });
    const j = await (await post(app, '/api/explain/tx', { chainId: 1, hash: '0x' + 'cd'.repeat(32) })).json();
    expect(j.facts.kind).toBe('delegation');
    expect(j.explanation.verdict).toBe('danger');
  });

  it('a type-4 transaction upgrading to official MetaMask code is judged on its call', async () => {
    const app = createApp({ store: createStore(''), fetchTx: async (chainId) => ({ chainId, to: USDT, data, value: 0n, authorizations: [{ address: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B', chainId: 1 }] }) });
    const j = await (await post(app, '/api/explain/tx', { chainId: 1, hash: '0x' + 'ef'.repeat(32) })).json();
    expect(j.facts.kind).toBe('erc20_approve');
  });

  it('rejects bad input with a human message', async () => {
    const app = createApp({ store: createStore('') });
    const r = await post(app, '/api/explain/tx', { chainId: 1, hash: 'nope' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/64 characters/);
  });
});
