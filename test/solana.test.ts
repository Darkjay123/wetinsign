import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { explain } from '../src/explain.js';
import { assessRisk, verdict } from '../src/risk.js';
import { createApp } from '../src/server.js';
import { b58decode, b58encode, parseSolanaBytes, solanaFacts, TOKEN, type Rpc } from '../src/solana.js';

// Real mainnet transactions pulled on 6 Oct 2026 with getTransaction (base64 + meta).
const fx = JSON.parse(readFileSync(new URL('./fixtures/solana-real.json', import.meta.url), 'utf8')) as Record<string, { signature: string; tx: string; meta: any; version: unknown }>;
const bytes = (k: string) => Uint8Array.from(Buffer.from(fx[k].tx, 'base64'));
const read = (k: string) => solanaFacts(parseSolanaBytes(bytes(k)), fx[k].meta);
const memStore = () => { const m = new Map<string, unknown>(); return { get: async (k: string) => m.get(k), put: async (k: string, v: unknown) => void m.set(k, v), count: async () => m.size }; };

describe('Solana', () => {
  it('reads all three formats: legacy, v0 and v1 (SIMD-0385)', () => {
    expect(parseSolanaBytes(bytes('sol_send')).version).toBe('legacy');
    expect(parseSolanaBytes(bytes('owner_attack')).version).toBe(0);
    expect(parseSolanaBytes(bytes('unlimited_approve')).version).toBe(1);
  });

  it('the real $3M owner-change attack (SlowMist, Dec 2025) is danger', async () => {
    const f = await read('owner_attack');
    expect(f.kind).toBe('sol_authority');
    expect(f.authority).toBe('wallet_owner');
    expect(f.owner).toBe('9w2e3kpt5XUQXLdGb51nRWZoh4JFs6FL7TdEYsvKq6Wb');
    expect(f.spender).toBe('GKJBELftW5Rjg24wP88NRaKGsEBtrPLgMiv3DhbJwbzQ');
    const flags = assessRisk(f);
    expect(verdict(flags)).toBe('danger');
    expect(flags.map((x) => x.code)).toContain('SOL_OWNER_CHANGE');
    expect((await explain(f, flags, 'en')).text).toMatch(/owner-change scam.*Do not sign/);
    expect((await explain(f, flags, 'pcm')).text).toMatch(/No sign am/);
  });

  it('a real unlimited token approval (v1 transaction) is danger', async () => {
    const f = await read('unlimited_approve');
    expect(f.kind).toBe('erc20_approve');
    expect(f.amount?.unlimited).toBe(true);
    expect(f.spender).toBe('CvN7hJE1evEjRDEcUPUFabyAjSqoZ8G1JRKBFJ5EVZtK');
    expect(assessRisk(f).map((x) => x.code)).toContain('UNLIMITED_APPROVAL');
  });

  it('no crying wolf on everyday app transactions', async () => {
    for (const k of ['inner_close_pda', 'inner_assign_ata', 'top_assign_pump', 'mint_renounce', 'approve_small', 'sol_send', 'token_send']) {
      expect(verdict(assessRisk(await read(k))), k).not.toBe('danger');
    }
  });

  it('a real SOL send and a real USDC send read correctly', async () => {
    const s = await read('sol_send');
    expect(s.kind).toBe('native_send');
    expect(s.amount?.display).toBe('0.016684977');
    expect(s.token?.symbol).toBe('SOL');
    const t = await read('token_send');
    expect(t.kind).toBe('transfer');
    expect(t.token?.symbol).toBe('USDC');
  });

  it('reads an unsigned message the same as the signed transaction', () => {
    const b = bytes('sol_send');
    const msg = b.subarray(1 + b[0] * 64);
    const a = parseSolanaBytes(b), m = parseSolanaBytes(msg);
    expect(m.staticKeys).toEqual(a.staticKeys);
    expect(m.ixs.length).toBe(a.ixs.length);
  });

  it('base58 round-trips', () => {
    const k = 'GKJBELftW5Rjg24wP88NRaKGsEBtrPLgMiv3DhbJwbzQ';
    expect(b58encode(b58decode(k))).toBe(k);
    expect(b58decode(k).length).toBe(32);
  });

  // Synthetic: we did not find a real token-account owner change to pull. Built byte-for-byte to the SPL Token layout.
  it('a token account owner change to someone else is danger, to yourself it is not', async () => {
    const user = 'FbmomB2sZgwfR8ySKaUEY37XUjb9p3SUDQdBCvLqgEeg', acct = 'GbyGCFL1U3NVXUC7LSu4QkapuEox3TUijtvaBMAn7hDy', thief = 'GKJBELftW5Rjg24wP88NRaKGsEBtrPLgMiv3DhbJwbzQ';
    const build = (to: string) => Uint8Array.from([1, 0, 1, 3, ...b58decode(user), ...b58decode(acct), ...b58decode(TOKEN), ...new Array(32).fill(7), 1, 2, 2, 1, 0, 35, 6, 2, 1, ...b58decode(to)]);
    const f = await solanaFacts(parseSolanaBytes(build(thief)));
    expect(f.authority).toBe('token_owner');
    expect(verdict(assessRisk(f))).toBe('danger');
    const own = await solanaFacts(parseSolanaBytes(build(user)));
    expect(verdict(assessRisk(own))).not.toBe('danger');
  });

  it('API: pasted base64 transaction and lookup by signature', async () => {
    const rpc: Rpc = async (m) => { if (m === 'getTransaction') return { transaction: [fx.owner_attack.tx, 'base64'], meta: fx.owner_attack.meta }; throw new Error('offline'); };
    const app = createApp({ store: memStore(), solanaRpc: rpc });
    const r1 = await (await app.request('/api/explain/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: 501, data: fx.sol_send.tx }) })).json();
    expect(r1.facts.kind).toBe('native_send');
    const r2 = await (await app.request('/api/explain/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: 'auto', hash: fx.owner_attack.signature, lang: 'pcm' }) })).json();
    expect(r2.explanation.verdict).toBe('danger');
    expect(r2.explanation.text).toMatch(/Solana owner-change scam/);
  });
});
