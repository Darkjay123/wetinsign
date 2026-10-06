import type { Facts } from './facts.js';
import { formatAmount } from './format.js';
import type { TokenRef } from './tokens.js';

/**
 * Aptos. Not EVM: dApps hand the wallet (Petra, Pontem, OKX) an entry-function payload
 * { function: "0x1::module::name", typeArguments, functionArguments }. 637 is Aptos' SLIP-44 coin type.
 */
export const APTOS_ID = 637;
const APTOS_API = process.env.APTOS_API ?? 'https://api.mainnet.aptoslabs.com/v1';
const CHAIN = 'Aptos';
const APT = '0x1::aptos_coin::AptosCoin';
const APT_FA = '0xa'; // APT as a fungible asset

export interface AptosPayload { function: string; typeArguments: string[]; functionArguments: unknown[] }
export interface AptosLookup {
  coin?: (type: string) => Promise<{ symbol?: string; decimals?: number } | undefined>;
  fa?: (metadata: string) => Promise<{ symbol?: string; decimals?: number } | undefined>;
  tx?: (hash: string) => Promise<{ sender?: string; payload?: unknown; success?: boolean } | undefined>;
}

const FN_RE = /^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/;
/** Accepts the wallet-adapter shape, the older { type_arguments, arguments } shape, and explorer JSON. */
export function asAptosPayload(v: any): AptosPayload | undefined {
  if (!v || typeof v !== 'object') return undefined;
  for (const c of [v, v.data, v.payload, v.transaction?.payload, v.transaction?.data]) {
    if (c && typeof c.function === 'string' && FN_RE.test(c.function)) {
      return { function: c.function, typeArguments: c.typeArguments ?? c.type_arguments ?? [], functionArguments: c.functionArguments ?? c.arguments ?? [] };
    }
  }
  return undefined;
}
export const isAptosTx = (v: unknown) => !!asAptosPayload(v);

export function normAddr(a: unknown): string {
  const s = typeof a === 'string' ? a : (a as any)?.inner ?? '';
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(s)) return String(s);
  return '0x' + s.slice(2).toLowerCase().padStart(64, '0');
}
const shortFn = (fn: string) => { const [a, m, n] = fn.split('::'); return `${normAddr(a)}::${m}::${n}`; };
const SYS = (fn: string, m: string, n: string) => shortFn(fn) === `${normAddr('0x1')}::${m}::${n}`;

async function coinToken(type: string, lookup: AptosLookup): Promise<TokenRef> {
  if (type === APT || type.replace(/^0x0*1::/, '0x1::') === APT) return { address: APT, symbol: 'APT', decimals: 8 };
  const m = await lookup.coin?.(type).catch(() => undefined);
  return { address: type, symbol: m?.symbol, decimals: m?.decimals };
}
async function faToken(meta: string, lookup: AptosLookup): Promise<TokenRef> {
  if (normAddr(meta) === normAddr(APT_FA)) return { address: normAddr(meta), symbol: 'APT', decimals: 8 };
  const m = await lookup.fa?.(normAddr(meta)).catch(() => undefined);
  return { address: normAddr(meta), symbol: m?.symbol, decimals: m?.decimals };
}
const big = (v: unknown) => { try { return BigInt(String(v)); } catch { return undefined; } };

export async function aptosFacts(p: AptosPayload, lookup: AptosLookup = {}, sender?: string): Promise<Facts> {
  const fn = p.function, a = p.functionArguments, t = p.typeArguments;
  const f: Facts = { kind: 'unknown_call', chainId: APTOS_ID, chain: CHAIN, appName: fn, selector: fn, ...(sender ? { from: normAddr(sender) } : {}) };
  const send = (token: TokenRef, to: unknown, amt: unknown): Facts => {
    const raw = big(amt);
    return Object.assign(f, { kind: token.symbol === 'APT' ? 'native_send' : 'transfer', token, recipient: normAddr(to), contract: token.address, ...(raw !== undefined ? { amount: formatAmount(raw, token) } : {}) });
  };
  if (SYS(fn, 'aptos_account', 'transfer')) return send({ address: APT, symbol: 'APT', decimals: 8 }, a[0], a[1]);
  if (SYS(fn, 'aptos_account', 'transfer_coins') || SYS(fn, 'coin', 'transfer')) return send(await coinToken(String(t[0] ?? APT), lookup), a[0], a[1]);
  if (SYS(fn, 'primary_fungible_store', 'transfer') || SYS(fn, 'aptos_account', 'transfer_fungible_assets')) return send(await faToken(String((a[0] as any)?.inner ?? a[0]), lookup), a[1], a[2]);
  if (SYS(fn, 'aptos_account', 'batch_transfer') || SYS(fn, 'aptos_account', 'batch_transfer_coins')) {
    const token = SYS(fn, 'aptos_account', 'batch_transfer') ? { address: APT, symbol: 'APT', decimals: 8 } : await coinToken(String(t[0] ?? APT), lookup);
    const tos = (a[0] as unknown[]) ?? [], amts = (a[1] as unknown[]) ?? [];
    const bundle = tos.map((to, i) => ({ kind: 'transfer', token, spender: normAddr(to), amount: formatAmount(big(amts[i]) ?? 0n, token) }));
    const total = amts.reduce<bigint>((s, x) => s + (big(x) ?? 0n), 0n);
    Object.assign(f, { kind: token.symbol === 'APT' ? 'native_send' : 'transfer', token, recipient: bundle[0]?.spender, amount: formatAmount(total, token) });
    if (new Set(bundle.map((b) => b.spender)).size > 1) Object.assign(f, { via: 'batch', bundle });
    return f;
  }
  if (SYS(fn, 'aptos_account', 'batch_transfer_fungible_assets')) {
    const token = await faToken(String((a[0] as any)?.inner ?? a[0]), lookup);
    const tos = (a[1] as unknown[]) ?? [], amts = (a[2] as unknown[]) ?? [];
    const bundle = tos.map((to, i) => ({ kind: 'transfer', token, spender: normAddr(to), amount: formatAmount(big(amts[i]) ?? 0n, token) }));
    const total = amts.reduce<bigint>((s, x) => s + (big(x) ?? 0n), 0n);
    Object.assign(f, { kind: token.symbol === 'APT' ? 'native_send' : 'transfer', token, contract: token.address, recipient: bundle[0]?.spender, amount: formatAmount(total, token) });
    if (new Set(bundle.map((b) => b.spender)).size > 1) Object.assign(f, { via: 'batch', bundle });
    return f;
  }
  if (SYS(fn, 'object', 'transfer') || SYS(fn, 'object', 'transfer_call')) {
    return Object.assign(f, { kind: 'transfer', token: { address: normAddr(a[0]), symbol: 'item (NFT or app object)' }, recipient: normAddr(a[1]), amount: { raw: '1', display: '1', unlimited: false } });
  }
  // Handing another account the power to sign as you, or to change your key: full control.
  if (SYS(fn, 'account', 'offer_signer_capability')) return Object.assign(f, { kind: 'account_control', control: 'signer_capability', spender: normAddr(a[3]) });
  if (SYS(fn, 'account', 'offer_rotation_capability')) return Object.assign(f, { kind: 'account_control', control: 'rotation_capability', spender: normAddr(a[3]) });
  if (/^rotate_authentication_key/.test(fn.split('::')[2]) && SYS(fn, 'account', fn.split('::')[2])) return Object.assign(f, { kind: 'account_control', control: 'rotate_key' });
  if (/^revoke_/.test(fn.split('::')[2]) && SYS(fn, 'account', fn.split('::')[2])) return Object.assign(f, { kind: 'account_control', control: 'remove_key' });
  if (/^0x0*1::(delegation_pool|stake|staking_contract|vesting)::/.test(fn)) return Object.assign(f, { kind: 'ledger_action', ledgerAction: 'stake' });
  if (SYS(fn, 'managed_coin', 'register') || SYS(fn, 'coin', 'register') || SYS(fn, 'aptos_account', 'create_account')) return Object.assign(f, { kind: 'ledger_action', ledgerAction: 'setup' });
  return f;
}

async function get(path: string): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await fetch(`${APTOS_API}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    // The public node rate-limits bursts; back off briefly rather than failing the check.
    if (r.status === 429 && i < 4) { await new Promise((ok) => setTimeout(ok, 1500 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`aptos ${r.status}`);
    return r.json();
  }
}
const metaCache = new Map<string, { symbol?: string; decimals?: number } | undefined>();
// Coin types and metadata addresses come from the pasted payload. Only well-formed ones ever reach the node's URL.
const COIN_TYPE_RE = /^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*(<[A-Za-z0-9_:<>, ]{1,400}>)?$/;
const ADDR_RE = /^0x[0-9a-fA-F]{1,64}$/;
const remember = (k: string, v: { symbol?: string; decimals?: number } | undefined) => { if (metaCache.size > 2000) metaCache.clear(); metaCache.set(k, v); return v; };
export const aptosLookup: AptosLookup = {
  coin: async (type) => {
    if (!COIN_TYPE_RE.test(type)) return undefined;
    if (metaCache.has(type)) return metaCache.get(type);
    const addr = type.split('::')[0];
    const r = await get(`/accounts/${addr}/resource/${encodeURIComponent(`0x1::coin::CoinInfo<${type}>`)}`).catch(() => undefined);
    const v = r?.data ? { symbol: r.data.symbol, decimals: Number(r.data.decimals) } : undefined;
    return remember(type, v);
  },
  fa: async (meta) => {
    if (!ADDR_RE.test(meta)) return undefined;
    if (metaCache.has(meta)) return metaCache.get(meta);
    const r = await get(`/accounts/${meta}/resource/0x1::fungible_asset::Metadata`).catch(() => undefined);
    const v = r?.data ? { symbol: r.data.symbol, decimals: Number(r.data.decimals) } : undefined;
    return remember(meta, v);
  },
  tx: async (hash) => get(`/transactions/by_hash/${hash.startsWith('0x') ? hash : '0x' + hash}`),
};

export async function fetchAptosTx(hash: string, lookup: AptosLookup = aptosLookup): Promise<Facts> {
  const tx = await lookup.tx?.(hash);
  if (!tx || (tx as any).type && (tx as any).type !== 'user_transaction') throw new Error('not found');
  const p = asAptosPayload(tx);
  if (!p) return { kind: 'unknown_call', chainId: APTOS_ID, chain: CHAIN, from: tx.sender ? normAddr(tx.sender) : undefined };
  return aptosFacts(p, lookup, tx.sender);
}
