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
});
