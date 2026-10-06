import { describe, expect, it } from 'vitest';
import { encodeFunctionData, maxUint256, parseAbi } from 'viem';
import { decodeCall, decodeTypedData } from '../src/decode.js';
import { assessRisk, verdict } from '../src/risk.js';

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const SPENDER = '0x2222222222222222222222222222222222222222';
const ME = '0x1111111111111111111111111111111111111111';
const abi = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function transfer(address to, uint256 amount)',
  'function setApprovalForAll(address operator, bool approved)',
]);
const none = { drainers: new Set<string>() };

describe('contract calls', () => {
  it('flags an unlimited USDT approval as danger', async () => {
    const data = encodeFunctionData({ abi, functionName: 'approve', args: [SPENDER, maxUint256] });
    const f = await decodeCall({ chainId: 1, to: USDT, data });
    expect(f.kind).toBe('erc20_approve');
    expect(f.token?.symbol).toBe('USDT');
    expect(f.amount).toMatchObject({ display: 'unlimited', unlimited: true });
    const flags = assessRisk(f, none);
    expect(flags.map((x) => x.code)).toContain('UNLIMITED_APPROVAL');
    expect(verdict(flags)).toBe('danger');
  });

  it('formats a limited approval exactly, with decimals', async () => {
    const data = encodeFunctionData({ abi, functionName: 'approve', args: [SPENDER, 25_500_000n] });
    const f = await decodeCall({ chainId: 1, to: USDT, data });
    expect(f.amount?.display).toBe('25.5');
    expect(verdict(assessRisk(f, none))).toBe('info');
  });

  it('treats approve(0) as a revoke', async () => {
    const data = encodeFunctionData({ abi, functionName: 'approve', args: [SPENDER, 0n] });
    const flags = assessRisk(await decodeCall({ chainId: 1, to: USDT, data }), none);
    expect(verdict(flags)).toBe('safe');
  });

  it('flags setApprovalForAll(true) and an approval to a plain wallet', async () => {
    const data = encodeFunctionData({ abi, functionName: 'setApprovalForAll', args: [SPENDER, true] });
    const f = await decodeCall({ chainId: 1, to: '0x3333333333333333333333333333333333333333', data });
    const codes = assessRisk(f, { ...none, spenderIsContract: false }).map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['NFT_APPROVE_ALL', 'SPENDER_NOT_CONTRACT']));
  });

  it('decodes transfers and plain sends', async () => {
    const data = encodeFunctionData({ abi, functionName: 'transfer', args: [SPENDER, 1_234_560_000n] });
    const t = await decodeCall({ chainId: 1, to: USDT, data });
    expect(t).toMatchObject({ kind: 'transfer', recipient: SPENDER });
    expect(t.amount?.display).toBe('1,234.56');
    const s = await decodeCall({ chainId: 56, to: SPENDER, value: 500000000000000000n });
    expect(s.kind).toBe('native_send');
    expect(s.amount?.display).toBe('0.5');
    expect(s.token?.symbol).toBe('BNB');
  });

  it('never guesses at a call it cannot read', async () => {
    const f = await decodeCall({ chainId: 1, to: SPENDER, data: '0xdeadbeef00000000' });
    expect(f.kind).toBe('unknown_call');
    expect(verdict(assessRisk(f, none))).toBe('warning');
  });

  it('shows raw units when decimals are unknown instead of inventing them', async () => {
    const data = encodeFunctionData({ abi, functionName: 'approve', args: [SPENDER, 1000n] });
    const f = await decodeCall({ chainId: 1, to: '0x4444444444444444444444444444444444444444', data });
    expect(f.amount?.display).toBe('1,000 raw units');
  });

  it('catches a known drainer', async () => {
    const data = encodeFunctionData({ abi, functionName: 'approve', args: [SPENDER, 5n] });
    const f = await decodeCall({ chainId: 1, to: USDT, data });
    const flags = assessRisk(f, { drainers: new Set([SPENDER.toLowerCase()]) });
    expect(flags[0].code).toBe('KNOWN_DRAINER');
  });
});

describe('signature requests', () => {
  const now = 1_790_000_000; // fixed clock for stable dates

  it('decodes an EIP-2612 permit that never expires', async () => {
    const f = await decodeTypedData({
      domain: { name: 'USD Coin', chainId: 1, verifyingContract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
      primaryType: 'Permit',
      message: { owner: ME, spender: SPENDER, value: maxUint256.toString(), nonce: 0, deadline: maxUint256.toString() },
    }, undefined, now);
    expect(f).toMatchObject({ kind: 'permit', spender: SPENDER, appName: 'USD Coin' });
    expect(f.deadline?.never).toBe(true);
    const codes = assessRisk(f, none).map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['UNLIMITED_APPROVAL', 'OFFCHAIN_SIGNATURE', 'NEVER_EXPIRES']));
  });

  it('decodes a Permit2 PermitSingle with a real expiry date', async () => {
    const f = await decodeTypedData({
      domain: { name: 'Permit2', chainId: 8453, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
      primaryType: 'PermitSingle',
      message: {
        details: { token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '50000000', expiration: String(now + 86400 * 30), nonce: 0 },
        spender: SPENDER, sigDeadline: String(now + 3600),
      },
    }, undefined, now);
    expect(f).toMatchObject({ kind: 'permit2', chain: 'Base' });
    expect(f.token?.symbol).toBe('USDC');
    expect(f.amount?.display).toBe('50');
    expect(f.deadline?.never).toBe(false);
  });

  it('flags a Seaport listing that pays the owner nothing', async () => {
    const f = await decodeTypedData({
      domain: { name: 'Seaport', chainId: 1 },
      primaryType: 'OrderComponents',
      message: {
        offerer: ME,
        offer: [{ itemType: 2, token: '0x5555555555555555555555555555555555555555', identifierOrCriteria: '7', startAmount: '1', endAmount: '1' }],
        consideration: [{ itemType: 0, token: '0x0000000000000000000000000000000000000000', startAmount: '1', endAmount: '1', recipient: SPENDER }],
        endTime: String(now + 1000),
      },
    }, undefined, now);
    expect(assessRisk(f, none).map((x) => x.code)).toContain('FREE_LISTING');
  });
});

describe('ownership handover', () => {
  it('flags setOwner as danger (the call behind the $55M DSProxy theft, Aug 2024)', async () => {
    const { encodeFunctionData, parseAbi } = await import('viem');
    const { assessRisk, verdict } = await import('../src/risk.js');
    const data = encodeFunctionData({ abi: parseAbi(['function setOwner(address owner)']), functionName: 'setOwner', args: ['0x0000db5c8B030ae20308ac975898E09741e70000'] });
    const f = await decodeCall({ chainId: 1, to: '0x1111111111111111111111111111111111111111', data });
    expect(f.kind).toBe('ownership_transfer');
    expect(verdict(assessRisk(f, { drainers: new Set() }))).toBe('danger');
  });
});
