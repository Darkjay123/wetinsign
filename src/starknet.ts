import { keccak256, toHex } from 'viem';
import type { Facts } from './facts.js';
import { formatAmount } from './format.js';
import type { TokenRef } from './tokens.js';

/**
 * Starknet. Not EVM: every account is a contract, and Argent/Braavos sign an INVOKE whose calldata is a list of
 * calls { to, selector, calldata }. Selectors are starknet_keccak(name) (keccak256 masked to 250 bits).
 * Token amounts are u256 split into (low, high). 9004 is STRK's SLIP-44 coin type.
 */
export const STARKNET_ID = 9004;
const CHAIN = 'Starknet';
const RPCS = [process.env.STARKNET_RPC, 'https://starknet-rpc.publicnode.com', 'https://api.cartridge.gg/x/starknet/mainnet'].filter(Boolean) as string[];
export const selector = (name: string) => '0x' + (BigInt(keccak256(toHex(name))) & ((1n << 250n) - 1n)).toString(16);
const NAMES = ['approve', 'increase_allowance', 'increaseAllowance', 'transfer', 'transfer_from', 'transferFrom', 'set_approval_for_all', 'setApprovalForAll'];
const BY_SEL: Record<string, string> = Object.fromEntries(NAMES.map((n) => [selector(n), n]));
const felt = (x: unknown): bigint | undefined => { try { return BigInt(String(x)); } catch { return undefined; } };
export const snAddr = (x: unknown) => { const v = felt(x); return v === undefined ? String(x) : '0x' + v.toString(16).padStart(64, '0'); };
const u256 = (lo: unknown, hi: unknown) => (felt(lo) ?? 0n) + ((felt(hi) ?? 0n) << 128n);
// Token addresses from each issuer's Starknet listing (StarkGate bridge list, Circle native USDC), read 7 Oct 2026.
const KNOWN: Record<string, { symbol: string; decimals: number }> = {
  [snAddr('0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7')]: { symbol: 'ETH', decimals: 18 },
  [snAddr('0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d')]: { symbol: 'STRK', decimals: 18 },
  [snAddr('0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8')]: { symbol: 'USDC.e', decimals: 6 },
  [snAddr('0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb')]: { symbol: 'USDC', decimals: 6 },
  [snAddr('0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8')]: { symbol: 'USDT', decimals: 6 },
};

export interface SnCall { to: string; fn: string; data: bigint[] }
export interface SnLookup {
  token?: (addr: string) => Promise<{ symbol?: string; decimals?: number } | undefined>;
  tx?: (hash: string) => Promise<any>;
}

/** __execute__ calldata. New (Cairo 1) accounts: [n, (to, sel, len, ...data)*]. Old (Cairo 0): call array, then one flat calldata. */
export function callsFromCalldata(cd: unknown[]): SnCall[] | undefined {
  const v = cd.map(felt);
  if (v.some((x) => x === undefined) || !v.length) return undefined;
  const w = v as bigint[];
  const n = Number(w[0]);
  if (n < 1 || n > 50) return undefined;
  const name = (s: bigint) => BY_SEL['0x' + s.toString(16)] ?? '0x' + s.toString(16);
  // Cairo 1
  let i = 1; const out: SnCall[] = [];
  for (let k = 0; k < n && i + 2 < w.length; k++) { const len = Number(w[i + 2]); if (len < 0 || i + 3 + len > w.length) break; out.push({ to: snAddr(w[i]), fn: name(w[i + 1]), data: w.slice(i + 3, i + 3 + len) }); i += 3 + len; }
  if (out.length === n && i === w.length) return out;
  // Cairo 0
  if (w.length >= 1 + 4 * n + 1) {
    const flatStart = 1 + 4 * n + 1, flat = w.slice(flatStart), calls: SnCall[] = [];
    for (let k = 0; k < n; k++) { const b = 1 + 4 * k, off = Number(w[b + 2]), len = Number(w[b + 3]); if (off + len > flat.length) return undefined; calls.push({ to: snAddr(w[b]), fn: name(w[b + 1]), data: flat.slice(off, off + len) }); }
    if (Number(w[1 + 4 * n]) === flat.length) return calls;
  }
  return undefined;
}
/** starknet.js [{ contractAddress, entrypoint, calldata }] or get-starknet { calls: [{ contract_address, entry_point, calldata }] }. */
export function callsFromRequest(v: any): SnCall[] | undefined {
  const list = Array.isArray(v) ? v : Array.isArray(v?.calls) ? v.calls : v?.contractAddress || v?.contract_address ? [v] : undefined;
  if (!list?.length) return undefined;
  const out: SnCall[] = [];
  for (const c of list) {
    const to = c?.contractAddress ?? c?.contract_address, ep = c?.entrypoint ?? c?.entry_point;
    if (typeof to !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(to) || typeof ep !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(ep)) return undefined;
    const data = (Array.isArray(c.calldata) ? c.calldata : []).map(felt);
    if (data.some((x: unknown) => x === undefined)) return undefined;
    out.push({ to: snAddr(to), fn: ep, data });
  }
  return out;
}
export const isStarknetRequest = (v: unknown) => !!callsFromRequest(v);

async function token(addr: string, lookup: SnLookup): Promise<TokenRef> {
  const k = KNOWN[addr] ?? (await lookup.token?.(addr).catch(() => undefined));
  return { address: addr, symbol: k?.symbol, decimals: k?.decimals };
}

export async function starknetFacts(calls: SnCall[], lookup: SnLookup = {}, sender?: string): Promise<Facts> {
  const base: Facts = { kind: 'unknown_call', chainId: STARKNET_ID, chain: CHAIN, ...(sender ? { from: snAddr(sender), owner: snAddr(sender) } : {}) };
  type Item = { kind: string; token?: TokenRef; spender?: string; amount?: ReturnType<typeof formatAmount>; approved?: boolean; from?: string };
  const items: Item[] = [];
  for (const c of calls) {
    const d = c.data;
    if ((c.fn === 'approve' || c.fn === 'increase_allowance' || c.fn === 'increaseAllowance') && d.length >= 3) { const t = await token(c.to, lookup); items.push({ kind: 'erc20_approve', token: t, spender: snAddr(d[0]), amount: formatAmount(u256(d[1], d[2]), t) }); }
    else if (c.fn === 'transfer' && d.length >= 3) { const t = await token(c.to, lookup); items.push({ kind: 'transfer', token: t, spender: snAddr(d[0]), amount: formatAmount(u256(d[1], d[2]), t) }); }
    else if ((c.fn === 'transfer_from' || c.fn === 'transferFrom') && d.length >= 4) { const t = await token(c.to, lookup); items.push({ kind: 'transfer_from', token: t, from: snAddr(d[0]), spender: snAddr(d[1]), amount: formatAmount(u256(d[2], d[3]), t) }); }
    else if ((c.fn === 'set_approval_for_all' || c.fn === 'setApprovalForAll') && d.length >= 2) items.push({ kind: 'nft_approve_all', token: { address: c.to }, spender: snAddr(d[0]), approved: d[1] !== 0n });
    else items.push({ kind: 'call', spender: c.to });
  }
  const bundle = items.filter((x) => x.kind !== 'call').map(({ kind, token, spender, amount }) => ({ kind, token, spender, amount }));
  const multi = calls.length > 1 ? { via: 'batch' as const, bundle } : {};
  const pick = (k: string) => items.find((x) => x.kind === k);
  const all = pick('nft_approve_all');
  if (all) return { ...base, kind: 'nft_approve_all', contract: all.token!.address, spender: all.spender, approved: all.approved, ...multi };
  const ap = items.filter((x) => x.kind === 'erc20_approve');
  if (ap.length) { const top = ap.find((x) => x.amount?.unlimited) ?? ap[0]; return { ...base, kind: 'erc20_approve', token: top.token, contract: top.token!.address, spender: top.spender, amount: top.amount, ...multi }; }
  const tf = pick('transfer_from');
  if (tf) return { ...base, kind: 'transfer_from', token: tf.token, contract: tf.token!.address, owner: tf.from, recipient: tf.spender, amount: tf.amount, ...multi };
  const tr = items.filter((x) => x.kind === 'transfer');
  if (tr.length) {
    const byTo = new Map<string, Set<string>>();
    for (const t of tr) byTo.set(t.spender!, (byTo.get(t.spender!) ?? new Set()).add(t.token!.address));
    const sweepTo = items.every((x) => x.kind === 'transfer') ? [...byTo].find(([, s]) => s.size >= 2)?.[0] : undefined;
    if (sweepTo) return { ...base, kind: 'transfer', token: tr[0].token, amount: tr[0].amount, recipient: sweepTo, via: 'batch', bundle, sweep: { recipient: sweepTo, assets: tr.filter((t) => t.spender === sweepTo).map((t) => t.token!.symbol ?? t.token!.address) } };
    const other = items.find((x) => x.kind === 'call');
    // A token sent to a router followed by its swap call: an app deposit, name the app.
    if (other) return { ...base, kind: 'ledger_action', ledgerAction: 'app_deposit', token: tr[0].token, amount: tr[0].amount, recipient: tr[0].spender, appName: tr[0].spender, ...multi };
    return { ...base, kind: 'transfer', token: tr[0].token, contract: tr[0].token!.address, amount: tr[0].amount, recipient: tr[0].spender, ...multi };
  }
  return { ...base, contract: calls[0]?.to, appName: calls[0] ? `${calls[0].fn.slice(0, 40)} on ${calls[0].to}` : undefined, selector: calls[0]?.fn.slice(0, 66) };
}

async function rpc(method: string, params: unknown): Promise<any> {
  let last: unknown;
  for (const u of RPCS) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message ?? 'rpc error');
      return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}
const shortStr = (f?: string) => { const v = felt(f); if (!v) return undefined; let h = v.toString(16); if (h.length % 2) h = '0' + h; const s = Buffer.from(h, 'hex').toString('utf8'); return /^[\x20-\x7e]{1,31}$/.test(s) ? s : undefined; };
const cache = new Map<string, { symbol?: string; decimals?: number } | undefined>();
export const snLookup: SnLookup = {
  token: async (addr) => {
    if (!/^0x[0-9a-f]{64}$/.test(addr)) return undefined;
    if (cache.has(addr)) return cache.get(addr);
    const call = (fn: string) => rpc('starknet_call', [{ contract_address: addr, entry_point_selector: selector(fn), calldata: [] }, 'latest']).catch(() => undefined);
    const [sym, dec] = await Promise.all([call('symbol'), call('decimals')]);
    const v = sym || dec ? { symbol: shortStr(sym?.[0]) , decimals: dec?.[0] !== undefined ? Number(BigInt(dec[0])) : undefined } : undefined;
    if (cache.size > 2000) cache.clear();
    cache.set(addr, v);
    return v;
  },
  tx: async (hash) => rpc('starknet_getTransactionByHash', [hash]),
};
export const STARKNET_HASH_RE = /^0x[0-9a-fA-F]{50,64}$/;
export async function fetchStarknetTx(hash: string, lookup: SnLookup = snLookup): Promise<Facts> {
  const t = await lookup.tx?.(hash.startsWith('0x') ? hash : '0x' + hash);
  if (!t || t.type !== 'INVOKE' || !Array.isArray(t.calldata)) throw new Error('not found');
  const calls = callsFromCalldata(t.calldata);
  if (!calls) return { kind: 'unknown_call', chainId: STARKNET_ID, chain: CHAIN, from: snAddr(t.sender_address) };
  return starknetFacts(calls, lookup, t.sender_address);
}
