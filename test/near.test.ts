// NEAR: every fixture is a real mainnet transaction read from archival RPC on 7 Oct 2026 (test/fixtures/near-real.json).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isNearRequest, nearFacts, nearFromJson, parseNearText, type NearLookup } from '../src/near.js';
import { assessRisk, verdict } from '../src/risk.js';
import { templateText } from '../src/explain.js';
import { createApp } from '../src/server.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/near-real.json', import.meta.url), 'utf8'));
const look: NearLookup = { ft: async (c) => (c === 'token.rhealab.near' ? { symbol: 'RHEA', decimals: 18 } : undefined) };
const run = async (tx: unknown) => { const f = await nearFacts(nearFromJson(tx), look); const flags = assessRisk(f, { drainers: new Set() }); return { f, flags, v: verdict(flags), en: templateText(f, flags, 'en'), pcm: templateText(f, flags, 'pcm') }; };
const memStore = () => { const m = new Map<string, unknown>(); return { get: async (k: string) => m.get(k), put: async (k: string, v: unknown) => { m.set(k, v); }, count: async () => m.size }; };

describe('NEAR, real mainnet transactions', () => {
  it('a plain NEAR send: 0.1 NEAR, 24 decimals, info', async () => {
    const r = await run(fx.transfer);
    expect(r.f.kind).toBe('native_send');
    expect(r.f.amount?.display).toBe('0.1');
    expect(r.v).toBe('info');
  });
  it('a USDt send reads the amount with 6 decimals and names the receiver', async () => {
    const r = await run(fx.usdt);
    expect(r.f.kind).toBe('transfer');
    expect(r.f.token?.symbol).toBe('USDt');
    expect(r.f.amount?.display).toBe('49.714');
    expect(r.f.recipient).toBe('ad15b87284973d83054771ebd4f19b58f58a89fbf8c6058cec8eba129f3fd010');
  });
  it('registering the receiver then sending USDt is one send, not a two-thing batch', async () => {
    const r = await run(fx.usdt_storage);
    expect(r.f.kind).toBe('transfer');
    expect(r.f.via).toBeUndefined();
    expect(r.f.amount?.display).toBe('71.985025');
  });
  it('adding a FULL ACCESS key to your own account is danger', async () => {
    const r = await run(fx.addkey);
    expect(r.f.control).toBe('full_access_key');
    expect(r.v).toBe('danger');
    expect(r.en).toMatch(/FULL ACCESS key/);
    expect(r.pcm).toMatch(/Wahala dey/);
  });
  it('a full key put on a NEW account this transaction creates is just setup', async () => {
    const r = await run(fx.create_addkey);
    expect(r.f.kind).toBe('ledger_action');
    expect(r.v).toBe('info');
  });
  it('a meta-transaction (relayer pays gas) is unwrapped: the inner full key add is still danger', async () => {
    const r = await run(fx.delegate_addkey);
    expect(r.f.control).toBe('full_access_key');
    expect(r.f.from).toBe('h8t2bu.near');
    expect(r.v).toBe('danger');
  });
  it('deleting your account sends everything to the beneficiary: danger', async () => {
    const r = await run(fx.delete);
    expect(r.f.control).toBe('account_delete');
    expect(r.f.recipient).toBe('hotwallet.kaiching');
    expect(r.v).toBe('danger');
    expect(r.en).toMatch(/remaining NEAR to hotwal…hing/);
  });
  it('ft_transfer_call into a swap aggregator names the app and is a warning, never a sweep', async () => {
    const r = await run(fx.swap_3cZN);
    expect(r.f.ledgerAction).toBe('app_deposit');
    expect(r.f.token?.symbol).toBe('RHEA');
    expect(r.f.amount?.display).toBe('623.66031674');
    expect(r.en).toMatch(/aggregatedex\.near/);
    expect(r.v).toBe('warning');
  });
});

describe('NEAR, request shapes and scams', () => {
  const victim = 'victim.near';
  it('wallet-selector JSON: sending USDt AND NEAR to one account in one request is a sweep', async () => {
    const req = { transactions: [
      { signerId: victim, receiverId: 'usdt.tether-token.near', actions: [{ type: 'FunctionCall', params: { methodName: 'ft_transfer', args: { receiver_id: 'claim-airdrop.near', amount: '500000000' }, gas: '30000000000000', deposit: '1' } }] },
      { signerId: victim, receiverId: 'claim-airdrop.near', actions: [{ type: 'Transfer', params: { deposit: '25000000000000000000000000' } }] },
    ] };
    expect(isNearRequest(req)).toBe(true);
    const r = await run(req);
    expect(r.f.sweep?.recipient).toBe('claim-airdrop.near');
    expect(r.flags.some((x) => x.code === 'ASSET_SWEEP')).toBe(true);
    expect(r.v).toBe('danger');
  });
  it('a dApp sign-in key (function-call access) is info and says it cannot move money', async () => {
    const r = await run({ signerId: victim, receiverId: victim, actions: [{ type: 'AddKey', params: { publicKey: 'ed25519:7soyopsXeQi3scLkGpyjbCkCWGxGzTTn11fJzLVxvw7u', accessKey: { permission: { receiverId: 'game.hot.tg', allowance: '250000000000000000000000', methodNames: [] } } } }] });
    expect(r.f.ledgerAction).toBe('app_key');
    expect(r.v).toBe('info');
    expect(r.en).toMatch(/cannot send your NEAR/);
    expect(r.en).toMatch(/0\.25 NEAR/);
  });
  it('deploying code on your own account is danger', async () => {
    const r = await run({ signerId: victim, receiverId: victim, actions: [{ type: 'DeployContract', params: { code: [0, 97, 115, 109] } }] });
    expect(r.f.control).toBe('deploy_code');
    expect(r.v).toBe('danger');
  });
  it('base64 borsh bytes (what wallet links carry) decode to the same answer as the JSON', async () => {
    // Built by hand to the nearcore layout: signer, ed25519 key, nonce, receiver, block hash, [AddKey FullAccess].
    const str = (s: string) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
    const key = Buffer.concat([Buffer.from([0]), Buffer.alloc(32, 7)]);
    const u64 = Buffer.alloc(8);
    const actions = Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from([5]), key, u64, Buffer.from([1])]);
    const tx = Buffer.concat([str(victim), key, u64, str(victim), Buffer.alloc(32, 1), actions]).toString('base64');
    const parsed = parseNearText(`https://app.mynearwallet.com/sign?transactions=${encodeURIComponent(tx)}&callbackUrl=x`);
    expect(parsed?.[0].actions[0]).toMatchObject({ type: 'AddKey', full: true });
    expect(parseNearText(tx)?.[0].signer).toBe(victim);
    expect(parseNearText('hello world')).toBeUndefined();
  });
  it('the API reads pasted NEAR JSON in Pidgin and lists NEAR as a network', async () => {
    const app = createApp({ store: memStore(), nearLookup: look });
    const r = await app.request('/api/explain/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: JSON.stringify(fx.addkey), lang: 'pcm' }) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.explanation.verdict).toBe('danger');
    expect(j.explanation.text).toMatch(/FULL ACCESS/);
    const chains = await (await app.request('/api/chains')).json();
    expect(chains.some((c: { id: number }) => c.id === 397)).toBe(true);
  });
});
