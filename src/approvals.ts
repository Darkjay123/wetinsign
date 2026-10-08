/**
 * "Was I drained?": every token and NFT permission a wallet has given that is STILL active,
 * who holds it, and a one-click link to cancel it. Read from the chain's own Approval logs
 * (via Blockscout) and checked against live allowances, so nothing already revoked shows up.
 */
import { parseAbi, type Hex } from 'viem';
import { client, onchainResolver } from './rpc.js';
import { formatAmount } from './format.js';
import { drainerSet } from './drainers.js';
import { trustedSpender } from './trusted.js';
import { T_APPROVAL, T_APPROVAL_ALL } from './moves.js';
import type { TokenRef } from './tokens.js';

/** Networks with a public log search that answered on 8 Oct 2026. */
export const APPROVAL_SCANS: Record<number, string> = {
  1: 'https://eth.blockscout.com',
  10: 'https://optimism.blockscout.com',
  100: 'https://gnosis.blockscout.com',
};
const ABI = parseAbi(['function allowance(address,address) view returns (uint256)', 'function isApprovedForAll(address,address) view returns (bool)']);
const MAX_CHECKS = 60;

export interface ActiveApproval {
  kind: 'token' | 'nft_all';
  token: { address: string; symbol?: string };
  spender: string;
  spenderName?: string;
  drainer: boolean;
  spenderIsContract?: boolean;
  amount?: string;
  unlimited?: boolean;
  givenAt?: string;
  level: 'danger' | 'warning' | 'info';
  why: string;
}
export interface ApprovalsResult {
  chainId: number;
  owner: string;
  active: ActiveApproval[];
  checked: number;
  /** The log search hit its page limit or we capped the live checks: older approvals may be missing. */
  partial: boolean;
  revokeUrl: string;
}

type Log = { address: string; topics: (string | null)[]; data: string; blockNumber: string; logIndex: string; timeStamp?: string };

async function logs(base: string, topic0: string, owner: string, fetcher: typeof fetch): Promise<Log[]> {
  const t1 = '0x' + owner.slice(2).toLowerCase().padStart(64, '0');
  const u = `${base}/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&topic0=${topic0}&topic1=${t1}&topic0_1_opr=and`;
  const r = await fetcher(u, { headers: { 'user-agent': 'SignLens (+https://github.com/Darkjay123/wetinsign)', accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`log search ${r.status}`);
  const j = (await r.json()) as { result?: Log[] | string };
  return Array.isArray(j.result) ? j.result : [];
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

export async function fetchApprovals(chainId: number, owner: string, fetcher: typeof fetch = fetch): Promise<ApprovalsResult> {
  const base = APPROVAL_SCANS[chainId];
  if (!base) throw new Error('unsupported');
  const me = owner.toLowerCase();
  const [a, b] = await Promise.all([logs(base, T_APPROVAL, me, fetcher), logs(base, T_APPROVAL_ALL, me, fetcher)]);
  const partial0 = a.length >= 1000 || b.length >= 1000;
  // Latest event per (contract, spender) wins; ERC-721 single-token approvals (4 topics) clear on transfer, so skip them.
  const latest = new Map<string, { kind: 'token' | 'nft_all'; contract: string; spender: string; order: bigint; at?: string }>();
  for (const [kind, list] of [['token', a], ['nft_all', b]] as const) {
    for (const l of list) {
      if (l.topics.filter(Boolean).length !== 3) continue;
      const contract = l.address.toLowerCase();
      const spender = ('0x' + (l.topics[2] ?? '').slice(26)).toLowerCase();
      const order = BigInt(l.blockNumber) * 100000n + BigInt(l.logIndex === '0x' ? '0x0' : l.logIndex);
      const k = `${kind}:${contract}:${spender}`;
      const prev = latest.get(k);
      if (!prev || order > prev.order) latest.set(k, { kind, contract, spender, order, at: l.timeStamp ? new Date(Number(BigInt(l.timeStamp)) * 1000).toISOString().slice(0, 10) : undefined });
    }
  }
  const pairs = [...latest.values()].sort((x, y) => (y.order > x.order ? 1 : -1));
  const checks = pairs.slice(0, MAX_CHECKS);
  const c = client(chainId);
  const drainers = drainerSet();
  const rows = await pool(checks, 8, async (p): Promise<ActiveApproval | null> => {
    try {
      let amount: string | undefined, unlimited = false;
      const token: TokenRef = await Promise.resolve(onchainResolver(chainId, p.contract)).catch(() => ({ address: p.contract }) as TokenRef);
      if (p.kind === 'token') {
        const raw = (await c.readContract({ address: p.contract as Hex, abi: ABI, functionName: 'allowance', args: [me as Hex, p.spender as Hex] })) as bigint;
        if (raw === 0n) return null;
        const f = formatAmount(raw, token);
        amount = f.display; unlimited = f.unlimited;
      } else {
        const on = (await c.readContract({ address: p.contract as Hex, abi: ABI, functionName: 'isApprovedForAll', args: [me as Hex, p.spender as Hex] })) as boolean;
        if (!on) return null;
        unlimited = true;
      }
      const name = trustedSpender(chainId, p.spender);
      const drainer = drainers.has(p.spender);
      const code = name || drainer ? undefined : await c.getCode({ address: p.spender as Hex }).catch(() => undefined);
      const spenderIsContract = code === undefined ? undefined : code !== '0x' && !!code;
      const sym = (token as { symbol?: string }).symbol ?? 'this token';
      let level: ActiveApproval['level'] = 'info', why = `${name ?? 'This app'} can still move ${unlimited ? 'all of your' : amount} ${sym}. Fine if you still use it; cancel it if you don't.`;
      if (drainer) { level = 'danger'; why = `This address has been reported as a wallet drainer and can still take ${unlimited ? 'all of your' : amount} ${sym}. Cancel it now.`; }
      else if (!name && spenderIsContract === false) { level = 'danger'; why = `A personal wallet, not an app, can still take ${unlimited ? 'all of your' : amount} ${sym}. Real apps almost never ask for this. Cancel it now.`; }
      else if (!name && unlimited) { level = 'warning'; why = `An app we don't recognise can still take ${p.kind === 'nft_all' ? `every ${sym} NFT you own` : `all of your ${sym}`}. Cancel it unless you know exactly what it is.`; }
      return { kind: p.kind, token: { address: p.contract, symbol: (token as { symbol?: string }).symbol }, spender: p.spender, ...(name ? { spenderName: name } : {}), drainer, ...(spenderIsContract !== undefined ? { spenderIsContract } : {}), ...(amount ? { amount } : {}), unlimited, ...(p.at ? { givenAt: p.at } : {}), level, why };
    } catch {
      return null;
    }
  });
  const rank = { danger: 0, warning: 1, info: 2 } as const;
  const active = rows.filter((x): x is ActiveApproval => !!x).sort((x, y) => rank[x.level] - rank[y.level]);
  return { chainId, owner: me, active, checked: checks.length, partial: partial0 || pairs.length > MAX_CHECKS, revokeUrl: `https://revoke.cash/address/${me}?chainId=${chainId}` };
}
