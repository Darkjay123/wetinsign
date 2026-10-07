import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as S from '@stacks/transactions';
import { fromHex, fromJson, parseStx, stxFacts, type StxLookup } from '../src/stacks.js';
import { assessRisk, verdict } from '../src/risk.js';
import { explain } from '../src/explain.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/stx-real.json', import.meta.url), 'utf8'));
const lookup: StxLookup = { ft: async (c) => (c.endsWith('.QUSD') ? { symbol: 'QUSD', decimals: 6 } : undefined) };
const run = async (t: any, l: 'en' | 'pcm' = 'en') => { const f = await stxFacts(t, lookup); const flags = assessRisk(f); return { f, flags, v: verdict(flags), x: await explain(f, flags, l) }; };

describe('Stacks (real mainnet transactions)', () => {
  it('reads the real serialized SIP-010 transfer the wallet signs', async () => {
    const t = fromHex(fx.transfer_raw)!;
    expect(t.sender).toBe(fx.transfer.sender_address);
    expect(t.allowMode).toBe(false);
    const r = await run(t);
    expect(r.f.kind).toBe('transfer');
    expect(r.f.amount?.display).toBe('983');
    expect(r.f.recipient).toBe('SPZFC3WA60M53V811BX1SZ6SCCY81C9NP0YFGE0P');
    expect(r.v).not.toBe('danger');
  });
  it('hash lookup JSON gives the same answer', async () => {
    const r = await run(fromJson(fx.transfer)!);
    expect(r.f.amount?.display).toBe('983');
  });
  it('plain STX transfer', async () => {
    const r = await run(fromJson(fx.token_transfer)!);
    expect(r.f.kind).toBe('native_send');
    expect(r.f.token?.symbol).toBe('STX');
  });
  it('a real "allow" mode swap warns that nothing limits what leaves', async () => {
    const r = await run(fromJson(fx['allow_swap-y-for-x-simple-range-multi'])!, 'pcm');
    expect(r.flags.some((x) => x.code === 'NO_LIMITS')).toBe(true);
    expect(r.v).toBe('warning');
    expect(r.x.text).toMatch(/allow/);
  });
  it('a "deny" mode app call with limits does not get the warning', async () => {
    const r = await run(fromJson(fx['swap-helper'])!);
    expect(r.flags.some((x) => x.code === 'NO_LIMITS')).toBe(false);
  });
  it('reads a Leather-style contract call request', () => {
    const t = parseStx({ contract: 'SP14CTSJZNKZ7YTR6C84368J2QXRW8RC20GSQ8KS2.QUSD', functionName: 'transfer', functionArgs: [S.cvToHex(S.uintCV(5_000_000)), S.cvToHex(S.principalCV('SP14CTSJZNKZ7YTR6C84368J2QXRW8RC20GSQ8KS2')), S.cvToHex(S.principalCV('SPZFC3WA60M53V811BX1SZ6SCCY81C9NP0YFGE0P')), S.cvToHex(S.noneCV())], postConditionMode: 'allow' })!;
    expect(t.allowMode).toBe(true);
    expect(String(t.args?.[0])).toBe('5000000');
  });
});
