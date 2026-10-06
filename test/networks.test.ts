import { describe, expect, it } from 'vitest';
import { CHAINS } from '../src/chains.js';
import { trustedSpender } from '../src/trusted.js';
import { createApp } from '../src/server.js';

const mem = () => { const m = new Map<string, unknown>(); return { get: async (k: string) => m.get(k), put: async (k: string, v: unknown) => void m.set(k, v), count: async () => m.size }; };

describe('networks', () => {
  it('reads 47 EVM networks, each with an RPC and native symbol', () => {
    expect(Object.keys(CHAINS).length).toBeGreaterThanOrEqual(47);
    for (const c of Object.values(CHAINS)) { expect(c.rpcs.length).toBeGreaterThan(0); expect(c.nativeSymbol).toBeTruthy(); }
    for (const id of [369, 999, 143, 324, 59144, 534352, 4663, 5042, 1329, 80094]) expect(CHAINS[id]).toBeTruthy();
  });
  it('trusts Permit2 only where Uniswap lists it', () => {
    expect(trustedSpender(143, '0x000000000022D473030F116dDEE9F6B43aC78BA3')).toBe('Uniswap Permit2');
    expect(trustedSpender(369, '0x000000000022D473030F116dDEE9F6B43aC78BA3')).toBeUndefined();
  });
  it('finds the network of a transaction hash by itself', async () => {
    const hash = '0x' + 'ab'.repeat(32);
    const app = createApp({ store: mem() as never, fetchTx: async (id) => { if (id !== 59144) throw new Error('not here'); return { to: '0xdAC17F958D2ee523a2206206994597C13D831ec7', data: '0x095ea7b30000000000000000000000002222222222222222222222222222222222222222ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', value: 0n }; } });
    const r = await app.request('/api/explain/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: 'auto', hash }) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.facts.chainId).toBe(59144);
    expect(j.facts.chain).toBe('Linea');
  });
  it('says plainly when no network has the hash', async () => {
    const app = createApp({ store: mem() as never, fetchTx: async () => { throw new Error('nope'); } });
    const r = await app.request('/api/explain/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash: '0x' + 'cd'.repeat(32) }) });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toMatch(/any of the \d+ networks/);
  });
});
