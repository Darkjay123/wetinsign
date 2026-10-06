import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeTypedData } from '../src/decode.js';
import { assessRisk, verdict } from '../src/risk.js';
import { templateText } from '../src/explain.js';

// Built on a real CoW order (CRV -> USDC, signature recovered to its owner). The variants change one field to test a rule.
const safe = JSON.parse(readFileSync(new URL('./fixtures/real-safe.json', import.meta.url), 'utf8'));
const cow = safe.find((c: any) => c.id.startsWith('cow-order-cbc20598'));
const none = { drainers: new Set<string>() };
const res = async (_c: number | undefined, a: string) => ({ address: a, ...(cow.tokens[a.toLowerCase()] ?? {}) });
const codes = (fl: any[]) => fl.map((x) => x.code);

describe('CoW Swap orders', () => {
  it('reads a real order as a swap on the official contract', async () => {
    const f = await decodeTypedData(cow.input.typedData, res, undefined, cow.signer);
    expect(f.kind).toBe('swap_order');
    expect(f.protocol).toBe('CoW Swap');
    expect(f.amount?.display).toBe('5,000');
    expect(f.token?.symbol).toBe('CRV');
    expect(f.buyAmount?.display).toBe('1,821');
    const fl = assessRisk(f, none);
    expect(verdict(fl)).toBe('info');
    expect(templateText(f, fl, 'en')).toContain('you sell 5,000 CRV and get at least 1,821 USDC');
  });

  it('asks you to check the receiver when we do not know who is signing', async () => {
    const f = await decodeTypedData(cow.input.typedData, res);
    expect(codes(assessRisk(f, none))).toContain('RECEIVER_CHECK');
  });

  it('warns loudly when the proceeds go to someone other than the signer', async () => {
    const td = structuredClone(cow.input.typedData);
    td.message.receiver = '0x1111111111111111111111111111111111111111';
    const f = await decodeTypedData(td, res, undefined, cow.signer);
    const fl = assessRisk(f, none);
    expect(codes(fl)).toContain('RECEIVER_NOT_YOU');
    expect(verdict(fl)).toBe('warning');
    expect(templateText(f, fl, 'pcm')).toContain('fake swap site');
    expect(templateText(f, fl, 'en')).toContain('it goes to 0x1111…1111');
  });

  it('calls a receiver of zero "you" (CoW default)', async () => {
    const td = structuredClone(cow.input.typedData);
    td.message.receiver = '0x0000000000000000000000000000000000000000';
    const fl = assessRisk(await decodeTypedData(td, res), none);
    expect(codes(fl)).not.toContain('RECEIVER_CHECK');
    expect(verdict(fl)).toBe('info');
  });

  it('calls an order that gets nothing back danger', async () => {
    const td = structuredClone(cow.input.typedData);
    td.message.buyAmount = '0';
    const fl = assessRisk(await decodeTypedData(td, res, undefined, cow.signer), none);
    expect(codes(fl)).toContain('FREE_SWAP');
    expect(verdict(fl)).toBe('danger');
  });

  it('warns when the order is not for the official CoW contract', async () => {
    const td = structuredClone(cow.input.typedData);
    td.domain.verifyingContract = '0x2222222222222222222222222222222222222222';
    const fl = assessRisk(await decodeTypedData(td, res, undefined, cow.signer), none);
    expect(codes(fl)).toContain('UNKNOWN_CONTRACT');
    expect(verdict(fl)).toBe('warning');
  });
});

describe('1inch limit orders', () => {
  const base = {
    domain: { name: '1inch Aggregation Router', version: '6', chainId: 1, verifyingContract: '0x111111125421cA6dc452d289314280a0f8842A65' },
    primaryType: 'Order',
    types: {},
    message: {
      salt: '1', maker: '0x3333333333333333333333333333333333333333', receiver: '0x0000000000000000000000000000000000000000',
      makerAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', takerAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      makingAmount: '1000000000', takingAmount: '250000000000000000', makerTraits: String(1893456000n << 80n),
    },
  };
  const r1 = async (_c: number | undefined, a: string) => ({ address: a, ...(a.toLowerCase().startsWith('0xa0b8') ? { symbol: 'USDC', decimals: 6 } : { symbol: 'WETH', decimals: 18 }) });

  it('reads maker, amounts and the expiry inside makerTraits', async () => {
    const f = await decodeTypedData(base as any, r1);
    expect(f.kind).toBe('swap_order');
    expect(f.protocol).toBe('1inch');
    expect(f.amount?.display).toBe('1,000');
    expect(f.buyAmount?.display).toBe('0.25');
    expect(f.deadline?.display).toBe('1 Jan 2030');
    expect(verdict(assessRisk(f, none))).toBe('info');
  });

  it('catches a receiver that is not the maker', async () => {
    const td = structuredClone(base);
    td.message.receiver = '0x4444444444444444444444444444444444444444';
    const fl = assessRisk(await decodeTypedData(td as any, r1), none);
    expect(codes(fl)).toContain('RECEIVER_NOT_YOU');
    expect(verdict(fl)).toBe('warning');
  });

  it('flags an order with no expiry', async () => {
    const td = structuredClone(base);
    td.message.makerTraits = '0';
    expect(codes(assessRisk(await decodeTypedData(td as any, r1), none))).toContain('NEVER_EXPIRES');
  });
});
