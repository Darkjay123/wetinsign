import { describe, expect, it } from 'vitest';
import { encodeFunctionData, maxUint256, parseAbi } from 'viem';
import { decodeCall } from '../src/decode.js';
import { explain, inventedNumbers, templateText } from '../src/explain.js';
import { assessRisk } from '../src/risk.js';

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const SPENDER = '0x2222222222222222222222222222222222222222';
const abi = parseAbi(['function approve(address spender, uint256 amount)']);
const none = { drainers: new Set<string>() };

async function limited() {
  const data = encodeFunctionData({ abi, functionName: 'approve', args: [SPENDER, 25_500_000n] });
  const f = await decodeCall({ chainId: 1, to: USDT, data });
  return { f, flags: assessRisk(f, none) };
}

describe('number guard', () => {
  it('allows numbers that were decoded and ignores addresses', async () => {
    const { f } = await limited();
    expect(inventedNumbers('This app can spend up to 25.5 USDT from 0x2222…2222.', f)).toEqual([]);
  });

  it('catches a number the model made up', async () => {
    const { f } = await limited();
    expect(inventedNumbers('This app can spend up to 2,550 USDT.', f)).toEqual(['2550']);
  });
});

describe('explain', () => {
  it('uses the AI text when it only restates facts', async () => {
    const { f, flags } = await limited();
    const r = await explain(f, flags, 'en', async () => 'Fine if you trust the app: it can spend up to 25.5 USDT.');
    expect(r).toMatchObject({ source: 'ai', rejected: [] });
  });

  it('throws away AI text that invents a figure and falls back to the template', async () => {
    const { f, flags } = await limited();
    const r = await explain(f, flags, 'en', async () => 'It can take 100 USDT.');
    expect(r.source).toBe('template');
    expect(r.rejected).toEqual(['100']);
    expect(r.text).toContain('25.5');
  });

  it('falls back when the model is down', async () => {
    const { f, flags } = await limited();
    const r = await explain(f, flags, 'pcm', async () => { throw new Error('timeout'); });
    expect(r.source).toBe('template');
    expect(r.text).toContain('You dey allow');
  });

  it('never lets the AI soften a danger verdict', async () => {
    const data = encodeFunctionData({ abi, functionName: 'approve', args: [SPENDER, maxUint256] });
    const f = await decodeCall({ chainId: 1, to: USDT, data });
    const flags = assessRisk(f, none);
    const r = await explain(f, flags, 'en', async () => 'This is a normal approval.');
    expect(r.verdict).toBe('danger');
    expect(r.text.startsWith('Danger')).toBe(true);
  });

  it('writes Pidgin for an unlimited approval', async () => {
    const data = encodeFunctionData({ abi, functionName: 'approve', args: [SPENDER, maxUint256] });
    const f = await decodeCall({ chainId: 1, to: USDT, data });
    expect(templateText(f, assessRisk(f, none), 'pcm')).toContain('carry ALL your USDT');
  });

  it('uses the reviewed Pidgin wording, not the model, for Pidgin readers', async () => {
    const data = encodeFunctionData({ abi, functionName: 'approve', args: [SPENDER, maxUint256] });
    const f = await decodeCall({ chainId: 1, to: USDT, data });
    const flags = assessRisk(f, none);
    let called = false;
    const r = await explain(f, flags, 'pcm', async () => { called = true; return 'Danger! You are giving away unlimited permission.'; });
    expect(called).toBe(false);
    expect(r.source).toBe('template');
    expect(r.text).toContain('carry ALL your USDT');
  });

  // The next two are the exact answers the live model gave on 6 Oct for real transactions.
  it('rejects AI text that shouts danger on an official Uniswap approval', async () => {
    const data = encodeFunctionData({ abi, functionName: 'approve', args: ['0x000000000022D473030F116dDEE9F6B43aC78BA3', maxUint256] });
    const f = await decodeCall({ chainId: 1, to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', data });
    const flags = assessRisk(f, none);
    const r = await explain(f, flags, 'en', async () => 'Danger! This person is giving away unlimited approval for this token (USDC) to a trusted spender.');
    expect(r.verdict).toBe('warning');
    expect(r.source).toBe('template');
    expect(r.text).toContain('Uniswap');
    expect(r.text).not.toMatch(/danger/i);
  });

  it('rejects AI text that talks as if the person already signed', async () => {
    const data = encodeFunctionData({ abi, functionName: 'approve', args: [SPENDER, maxUint256] });
    const f = await decodeCall({ chainId: 1, to: USDT, data });
    const r = await explain(f, assessRisk(f, none), 'en', async () => 'Warning: Danger. When you gave unlimited approval to this address, they can take as much of your USDT as they want.');
    expect(r.source).toBe('template');
    expect(r.rejected).toContain('talks as if already signed');
  });

  it('keeps good AI text', async () => {
    const data = encodeFunctionData({ abi, functionName: 'approve', args: [SPENDER, maxUint256] });
    const f = await decodeCall({ chainId: 1, to: USDT, data });
    const r = await explain(f, assessRisk(f, none), 'en', async () => 'Danger: signing this lets this address take all your USDT whenever it wants. Do not sign unless you fully trust the site.');
    expect(r.source).toBe('ai');
  });
});

import { aiProblems as _aiProblems } from '../src/explain.js';
describe('AI guard on approvals', () => {
  it('rejects the real bad answer seen live on a Tron USDT approval', () => {
    const f = { kind: 'erc20_approve', chain: 'Tron', chainId: 728126428, spender: 'TJ4KeiGTvTX4wRUgLARiwr8rGLaurmVkdZ', token: { address: 'x', symbol: 'USDT', decimals: 6 }, amount: { raw: '23391920', display: '23.39192', unlimited: false } } as any;
    const bad = "Warning: Be careful with your money.\n\nYou are giving away some USDT, a type of cryptocurrency, to this address. If you're not sure who sent it to you or why they did, be cautious and don't spend the USDT until you figure out what's going on.";
    const p = _aiProblems(bad, f, [{ code: 'SPENDER_UNKNOWN', severity: 'warning' }], 'warning');
    expect(p).toContain('describes an approval as a payment');
    expect(p).toContain('leaves out the amount');
  });
});
