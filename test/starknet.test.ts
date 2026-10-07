import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { callsFromCalldata, callsFromRequest, selector, snAddr, starknetFacts, type SnLookup } from '../src/starknet.js';
import { assessRisk, verdict } from '../src/risk.js';
import { explain } from '../src/explain.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/starknet-real.json', import.meta.url), 'utf8'));
const lookup: SnLookup = { token: async () => ({ symbol: 'TKN', decimals: 18 }) };
const run = async (calls: any, sender?: string, l: 'en' | 'pcm' = 'en') => { const f = await starknetFacts(calls, lookup, sender); const flags = assessRisk(f); return { f, flags, v: verdict(flags), x: await explain(f, flags, l) }; };
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', ETH = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
const THIEF = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const MAX = '0xffffffffffffffffffffffffffffffff';

describe('Starknet (real mainnet invokes)', () => {
  it('selectors match starknet_keccak', () => {
    expect(selector('transfer')).toBe('0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e');
    expect(selector('approve')).toBe('0x219209e083275171774dab1df80982e9df2096516f06319c5c6d71ae0a8480c');
  });
  it('splits a real approve + deposit invoke and reads the approval', async () => {
    const calls = callsFromCalldata(fx.approve.calldata)!;
    expect(calls.map((c) => c.fn)).toContain('approve');
    const r = await run(calls, fx.approve.sender);
    expect(r.f.kind).toBe('erc20_approve');
    expect(r.f.via).toBe('batch');
    expect(r.f.spender).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('a real transfer-then-swap is an app deposit, not a sweep', async () => {
    const r = await run(callsFromCalldata(fx.swap.calldata)!, fx.swap.sender);
    expect(r.f.sweep).toBeUndefined();
    expect(r.v).not.toBe('danger');
  });
});

describe('Starknet wallet requests (starknet.js shape)', () => {
  it('unlimited STRK approval to a stranger is a danger', async () => {
    const r = await run(callsFromRequest([{ contractAddress: STRK, entrypoint: 'approve', calldata: [THIEF, MAX, MAX] }])!, undefined, 'pcm');
    expect(r.f.token?.symbol).toBe('STRK');
    expect(r.f.amount?.unlimited).toBe(true);
    expect(r.v).toBe('danger');
  });
  it('exact 5 STRK transfer reads 5', async () => {
    const r = await run(callsFromRequest({ calls: [{ contract_address: STRK, entry_point: 'transfer', calldata: [THIEF, '5000000000000000000', '0'] }] })!);
    expect(r.f.kind).toBe('transfer');
    expect(r.f.amount?.display).toBe('5');
    expect(r.f.recipient).toBe(snAddr(THIEF));
  });
  it('STRK + ETH to one address in one go is a sweep', async () => {
    const r = await run(callsFromRequest([{ contractAddress: STRK, entrypoint: 'transfer', calldata: [THIEF, '1', '0'] }, { contractAddress: ETH, entrypoint: 'transfer', calldata: [THIEF, '1', '0'] }])!);
    expect(r.f.sweep?.assets).toEqual(['STRK', 'ETH']);
    expect(r.v).toBe('danger');
  });
  it('NFT approve-all is a danger', async () => {
    const r = await run(callsFromRequest([{ contractAddress: THIEF, entrypoint: 'set_approval_for_all', calldata: [THIEF, '1'] }])!);
    expect(r.f.kind).toBe('nft_approve_all');
    expect(r.v).toBe('danger');
  });
});
