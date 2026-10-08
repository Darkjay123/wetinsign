import { describe, it, expect } from 'vitest';
import { readLogs, summarize, T_TRANSFER, T_APPROVAL, T_APPROVAL_ALL } from '../src/moves.js';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';

const pad = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const ME = '0x1111111111111111111111111111111111111111';
const THIEF = '0x2222222222222222222222222222222222222222';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const tokens = new Map([[USDC, { address: USDC, symbol: 'USDC', decimals: 6 }]]);

describe('what the chain recorded (receipt logs)', () => {
  it('reads a token leaving the sender, an unlimited approval and an approve-all', () => {
    const logs = [
      { address: USDC, topics: [T_TRANSFER, pad(ME), pad(THIEF)], data: '0x' + (1_500_000n).toString(16).padStart(64, '0') },
      { address: USDC, topics: [T_APPROVAL, pad(ME), pad(THIEF)], data: '0x' + 'f'.repeat(64) },
      { address: '0x3333333333333333333333333333333333333333', topics: [T_APPROVAL_ALL, pad(ME), pad(THIEF)], data: '0x' + '1'.padStart(64, '0') },
    ];
    const r = readLogs(1, ME, logs, tokens as never);
    expect(r.moves.map((m) => m.type)).toEqual(['token', 'approval', 'approval_all']);
    expect(r.moves[0].amount).toBe('1.5');
    expect(r.moves[1].unlimited).toBe(true);
    expect(r.moves.every((m) => m.fromSender)).toBe(true);
    const s = summarize({ status: 'success', moves: r.moves });
    expect(s).toContain('1.5 USDC went to 0x2222');
    expect(s).toContain('allowed to take all of your USDC');
  });
  it('says nothing moved when the transaction failed', () => {
    expect(summarize({ status: 'reverted', moves: [] })).toMatch(/failed/);
  });
});

describe('/api/approvals input checks', () => {
  const app = createApp({ store: createStore(''), fetchApprovals: async () => ({ active: [] }) } as never);
  it('rejects a bad address', async () => {
    const r = await app.request('/api/approvals?address=hello&chainId=1');
    expect(r.status).toBe(400);
  });
  it('points unsupported networks to revoke.cash', async () => {
    const r = await app.request('/api/approvals?address=' + ME + '&chainId=56');
    const j = (await r.json()) as { revokeUrl: string };
    expect(r.status).toBe(400);
    expect(j.revokeUrl).toContain('revoke.cash');
  });
});
