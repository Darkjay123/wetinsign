import { describe, expect, it } from 'vitest';
import { decodeCall } from '../src/decode.js';
import { templateText } from '../src/explain.js';
import { assessRisk } from '../src/risk.js';
import { parseTronTx, TRON_ID, tronDisplay, tronToBase58, tronToHex } from '../src/tron.js';
import { createApp } from '../src/server.js';

const mem = () => { const m = new Map<string, unknown>(); return { get: async (k: string) => m.get(k), put: async (k: string, v: unknown) => void m.set(k, v), count: async () => m.size }; };
// Real USDT (TRC-20) approval on Tron mainnet, tx 8be342ca2725ab31d999785c00a9200f52999cc3a3d45d605939dbf77a702cbe (read from TronGrid 2026-10-06).
const REAL_APPROVE = { raw_data: { contract: [{ type: 'TriggerSmartContract', parameter: { value: { owner_address: 'TR9YygNn4KDS9FmwSaY8NCpcqBVXxwUFSQ', contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', data: '095ea7b300000000000000000000004158b8a2f4c954a0c54c8e392feee612ec2dbe1585000000000000000000000000000000000000000000000000000000000164eeb0' } } }] } };
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

describe('tron addresses', () => {
  it('converts T… addresses both ways with a checked checksum', () => {
    expect(tronToHex(USDT)).toBe('0xa614f803b6fd780986a42c78ec9c7f77e6ded13c');
    expect(tronToBase58('0xa614f803b6fd780986a42c78ec9c7f77e6ded13c')).toBe(USDT);
    expect(tronToHex('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')).toBeUndefined();
  });
});

describe('tron transactions', () => {
  it('reads a real USDT approval and shows T… addresses', async () => {
    const t = await parseTronTx(REAL_APPROVE);
    const f = await decodeCall(t.call!);
    expect(f.kind).toBe('erc20_approve');
    expect(f.token?.symbol).toBe('USDT');
    expect(f.amount?.display).toBe('23.39192');
    const flags = assessRisk(f, { spenderIsContract: false, drainers: new Set() });
    expect(flags.map((x) => x.code)).toContain('SPENDER_NOT_CONTRACT');
    const shown = tronDisplay(f);
    expect(shown.spender).toMatch(/^T/);
    expect(templateText(shown, flags, 'en')).toMatch(/USDT/);
  });
  it('a sent TRX amount uses 6 decimals', async () => {
    const t = await parseTronTx({ raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { owner_address: 'TR9YygNn4KDS9FmwSaY8NCpcqBVXxwUFSQ', to_address: USDT, amount: 1500000 } } }] } });
    const f = await decodeCall(t.call!);
    expect(f.kind).toBe('native_send');
    expect(f.amount?.display).toBe('1.5');
    expect(f.token?.symbol).toBe('TRX');
  });
  const me = 'TR9YygNn4KDS9FmwSaY8NCpcqBVXxwUFSQ';
  const thief = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
  const perm = (owner: unknown, actives: unknown[] = []) => ({ raw_data: { contract: [{ type: 'AccountPermissionUpdateContract', parameter: { value: { owner_address: me, owner, actives } } }] } });
  it('the multi-signature scam: another key takes over the owner permission', async () => {
    const t = await parseTronTx(perm({ permission_name: 'owner', threshold: 1, keys: [{ address: thief, weight: 1 }] }));
    const flags = assessRisk(t.facts!, { drainers: new Set() });
    expect(flags.find((x) => x.code === 'ACCOUNT_TAKEOVER')?.severity).toBe('danger');
    const txt = templateText(tronDisplay(t.facts!), flags, 'pcm');
    expect(txt).toMatch(/Wahala dey/);
    expect(txt).toMatch(/TXYZop/);
  });
  it('the sneaky version: you keep a key but theirs alone meets the threshold', async () => {
    const t = await parseTronTx(perm({ threshold: 2, keys: [{ address: me, weight: 1 }, { address: thief, weight: 2 }] }));
    expect(assessRisk(t.facts!, { drainers: new Set() }).some((x) => x.code === 'ACCOUNT_TAKEOVER')).toBe(true);
  });
  it('an active permission handed to someone else is also a takeover', async () => {
    const t = await parseTronTx(perm({ threshold: 1, keys: [{ address: me, weight: 1 }] }, [{ threshold: 1, keys: [{ address: thief, weight: 1 }] }]));
    expect(assessRisk(t.facts!, { drainers: new Set() }).some((x) => x.code === 'ACCOUNT_TAKEOVER')).toBe(true);
  });
  it('a real shared wallet (2 of 2 with you) is a warning, not danger', async () => {
    const t = await parseTronTx(perm({ threshold: 2, keys: [{ address: me, weight: 1 }, { address: thief, weight: 1 }] }));
    const flags = assessRisk(t.facts!, { drainers: new Set() });
    expect(flags.some((x) => x.code === 'ACCOUNT_TAKEOVER')).toBe(false);
    expect(flags.find((x) => x.code === 'PERMISSION_SHARED')?.severity).toBe('warning');
  });
  it('lending energy is info', async () => {
    const t = await parseTronTx({ raw_data: { contract: [{ type: 'DelegateResourceContract', parameter: { value: { owner_address: me, receiver_address: thief, resource: 'ENERGY', balance: 1 } } }] } });
    expect(assessRisk(t.facts!, { drainers: new Set() }).map((x) => x.severity)).toEqual(['info']);
  });
  it('the API takes a pasted Tron transaction and a hash without 0x', async () => {
    const app = createApp({ store: mem() as never, fetchTx: async (id, h) => { if (id !== TRON_ID) throw new Error('no'); expect(h).toBe('0x' + 'ef'.repeat(32)); const t = await parseTronTx(perm({ threshold: 1, keys: [{ address: thief, weight: 1 }] })); return { to: '', facts: t.facts }; } });
    const r1 = await app.request('/api/explain/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: TRON_ID, data: JSON.stringify(REAL_APPROVE) }) });
    expect(r1.status).toBe(200);
    expect((await r1.json()).facts.contract).toBe(USDT);
    const r2 = await app.request('/api/explain/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: 'auto', hash: 'ef'.repeat(32) }) });
    const j = await r2.json();
    expect(j.flags.some((x: { code: string }) => x.code === 'ACCOUNT_TAKEOVER')).toBe(true);
    expect(j.facts.chain).toBe('Tron');
  });
});
