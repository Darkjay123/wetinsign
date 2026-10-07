import { IDL } from '@dfinity/candid';
import { Principal } from '@dfinity/principal';
import type { Facts } from './facts.js';
import { formatAmount } from './format.js';
import type { TokenRef } from './tokens.js';

/**
 * Internet Computer. Wallets (Plug, NFID, Oisy) sign canister calls; ICRC-49 hands them
 * { canisterId, sender, method, arg } with arg as base64 Candid. Tokens are ICRC-1/ICRC-2 ledgers:
 * icrc1_transfer sends, icrc2_approve lets a spender take later (the drainer move), icrc2_transfer_from takes.
 * Argument types from the ICRC-1 and ICRC-2 standards (github.com/dfinity/ICRC-1) and the ICP ledger .did.
 * Ledger symbols and decimals read from icrc-api.internetcomputer.org on 7 Oct 2026. 223 is ICP's SLIP-44 coin type.
 */
export const ICP_ID = 223;
const CHAIN = 'Internet Computer';
const ICRC_API = process.env.ICRC_API ?? 'https://icrc-api.internetcomputer.org/api/v1';
const LEDGER_API = process.env.ICP_LEDGER_API ?? 'https://ledger-api.internetcomputer.org';
export const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const KNOWN: Record<string, { symbol: string; decimals: number }> = {
  'ryjl3-tyaaa-aaaaa-aaaba-cai': { symbol: 'ICP', decimals: 8 },
  'mxzaz-hqaaa-aaaar-qaada-cai': { symbol: 'ckBTC', decimals: 8 },
  'ss2fx-dyaaa-aaaar-qacoq-cai': { symbol: 'ckETH', decimals: 18 },
  'xevnm-gaaaa-aaaar-qafnq-cai': { symbol: 'ckUSDC', decimals: 6 },
  'cngnf-vqaaa-aaaar-qag4q-cai': { symbol: 'ckUSDT', decimals: 6 },
};
const ICP: TokenRef = { address: ICP_LEDGER, symbol: 'ICP', decimals: 8 };

const Sub = IDL.Opt(IDL.Vec(IDL.Nat8));
export const Account = IDL.Record({ owner: IDL.Principal, subaccount: Sub });
export const TransferArg = IDL.Record({ from_subaccount: Sub, to: Account, amount: IDL.Nat, fee: IDL.Opt(IDL.Nat), memo: IDL.Opt(IDL.Vec(IDL.Nat8)), created_at_time: IDL.Opt(IDL.Nat64) });
export const ApproveArgs = IDL.Record({ from_subaccount: Sub, spender: Account, amount: IDL.Nat, expected_allowance: IDL.Opt(IDL.Nat), expires_at: IDL.Opt(IDL.Nat64), fee: IDL.Opt(IDL.Nat), memo: IDL.Opt(IDL.Vec(IDL.Nat8)), created_at_time: IDL.Opt(IDL.Nat64) });
export const TransferFromArgs = IDL.Record({ spender_subaccount: Sub, from: Account, to: Account, amount: IDL.Nat, fee: IDL.Opt(IDL.Nat), memo: IDL.Opt(IDL.Vec(IDL.Nat8)), created_at_time: IDL.Opt(IDL.Nat64) });
const Tokens = IDL.Record({ e8s: IDL.Nat64 });
export const LegacyTransfer = IDL.Record({ memo: IDL.Nat64, amount: Tokens, fee: Tokens, from_subaccount: Sub, to: IDL.Vec(IDL.Nat8), created_at_time: IDL.Opt(IDL.Record({ timestamp_nanos: IDL.Nat64 })) });

export interface IcpCall { canisterId: string; method: string; arg: Uint8Array; sender?: string }
export interface IcpLookup {
  /** One ICRC ledger transaction by its block index (icrc-api). */
  icrcTx?: (ledger: string, index: string) => Promise<any>;
  ledger?: (canisterId: string) => Promise<{ symbol?: string; decimals?: number; totalSupply?: string } | undefined>;
  tx?: (hash: string) => Promise<any>;
}

/** A user's wallet principal is self-authenticating: 29 bytes ending 0x02. Canisters (apps) are short and end 0x01. */
export function isCanister(p?: string): boolean | undefined {
  if (!p) return undefined;
  try { const b = Principal.fromText(p).toUint8Array(); if (b.length === 29 && b[28] === 2) return false; if (b[b.length - 1] === 1) return true; return undefined; } catch { return undefined; }
}
const bytes = (v: unknown): Uint8Array | undefined => {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (Array.isArray(v) && v.every((x) => Number.isInteger(x))) return Uint8Array.from(v as number[]);
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (/^(0x)?[0-9a-fA-F]+$/.test(s) && s.replace(/^0x/, '').length % 2 === 0 && s.replace(/^0x/, '').startsWith('4449444c')) return new Uint8Array(Buffer.from(s.replace(/^0x/, ''), 'hex'));
  try { const b = Buffer.from(s, 'base64'); return b.subarray(0, 4).toString() === 'DIDL' ? new Uint8Array(b) : undefined; } catch { return undefined; }
};
const validPrincipal = (s: unknown) => { try { return typeof s === 'string' && !!Principal.fromText(s); } catch { return false; } };

/** ICRC-49 request, its params, or a bare { canisterId, method, arg }. */
export function parseIcp(v: any): IcpCall | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const p = v.method === 'icrc49_call_canister' ? v.params : v.params?.canisterId ? v.params : v;
  const canisterId = p?.canisterId ?? p?.canister_id;
  const method = p?.method ?? p?.methodName;
  const arg = bytes(p?.arg ?? p?.args);
  if (!validPrincipal(canisterId) || typeof method !== 'string' || !arg) return undefined;
  return { canisterId, method, arg, ...(validPrincipal(p.sender) ? { sender: p.sender } : {}) };
}

const subHex = (s: any) => (s?.[0]?.length ? Buffer.from(s[0]).toString('hex') : undefined);
const acct = (a: any) => { const o = a.owner.toText(); const s = subHex(a.subaccount); return s && !/^0+$/.test(s) ? `${o}.${s.slice(0, 8)}…` : o; };
async function ledgerToken(id: string, lookup: IcpLookup): Promise<TokenRef> {
  const live = await lookup.ledger?.(id).catch(() => undefined);
  const k = KNOWN[id] ?? live;
  return { address: id, symbol: k?.symbol ?? 'tokens', decimals: Number.isInteger(k?.decimals) ? k!.decimals! : 0, ...(live?.totalSupply ? { totalSupply: live.totalSupply } : {}) };
}

export async function icpFacts(call: IcpCall, lookup: IcpLookup = {}): Promise<Facts> {
  const base: Facts = { kind: 'unknown_call', chainId: ICP_ID, chain: CHAIN, contract: call.canisterId, ...(call.sender ? { from: call.sender, owner: call.sender } : {}) };
  const dec = (t: IDL.Type) => { try { return (IDL.decode([t], call.arg) as any[])[0]; } catch { return undefined; } };
  const t = await ledgerToken(call.canisterId, lookup);
  if (call.method === 'icrc2_approve') {
    const a = dec(ApproveArgs);
    if (a) {
      const exp = a.expires_at?.[0] as bigint | undefined;
      // More than the ledger's whole supply (read live), or beyond 2^128 which no ICRC ledger comes near, is unlimited.
      const raw = BigInt(a.amount);
      const amount = raw >= 2n ** 128n ? { raw: raw.toString(), display: 'unlimited', unlimited: true } : formatAmount(raw, t);
      return { ...base, kind: 'erc20_approve', token: t, spender: acct(a.spender), amount, deadline: exp ? { never: false, timestamp: Number(exp / 1_000_000_000n) } as any : { never: true } as any };
    }
  }
  if (call.method === 'icrc1_transfer') {
    const a = dec(TransferArg);
    if (a) return { ...base, kind: 'transfer', token: t, amount: formatAmount(BigInt(a.amount), t), recipient: acct(a.to) };
  }
  if (call.method === 'icrc2_transfer_from') {
    const a = dec(TransferFromArgs);
    if (a) return { ...base, kind: 'transfer_from', token: t, amount: formatAmount(BigInt(a.amount), t), owner: acct(a.from), recipient: acct(a.to) };
  }
  if (call.method === 'transfer' && call.canisterId === ICP_LEDGER) {
    const a = dec(LegacyTransfer);
    if (a) return { ...base, kind: 'native_send', token: ICP, amount: formatAmount(BigInt(a.amount.e8s), ICP), recipient: Buffer.from(a.to).toString('hex') };
  }
  return { ...base, appName: call.canisterId, selector: call.method.slice(0, 80) };
}

/** ICP ledger transaction by hash (ledger-api.internetcomputer.org). ICRC token ledgers have no hash search, so those need the request pasted. */
export async function fetchIcpTx(hash: string, lookup: IcpLookup = icpLookup): Promise<Facts> {
  const r = await lookup.tx?.(hash.replace(/^0x/, '').toLowerCase());
  if (!r?.transaction_hash) throw new Error('not found');
  const base: Facts = { kind: 'unknown_call', chainId: ICP_ID, chain: CHAIN, from: r.from_account_identifier, owner: r.from_account_identifier };
  const amount = formatAmount(BigInt(r.amount ?? r.allowance ?? 0), ICP);
  if (r.transfer_type === 'approve') return { ...base, kind: 'erc20_approve', token: ICP, contract: ICP_LEDGER, spender: r.spender_account_identifier, amount: formatAmount(BigInt(r.allowance ?? r.amount ?? 0), ICP), deadline: r.expires_at ? { never: false, timestamp: Math.floor(Number(r.expires_at) / 1e9) } as any : { never: true } as any };
  if (r.transfer_type === 'send' || r.transfer_type === 'transfer_from') return { ...base, kind: 'native_send', token: ICP, amount, recipient: r.to_account_identifier };
  return { ...base, kind: 'ledger_action', ledgerAction: 'settings', appName: String(r.transfer_type ?? 'ledger') };
}

/**
 * ckBTC, ckUSDC and other ICRC token transactions have no hash search anywhere public (icrc-api's hash filter
 * times out), but every explorer shows the ledger and the transaction number. Accepts "ledger-id 4701469",
 * "ckBTC 4701469", or any explorer link holding both.
 */
const SYMBOL_TO_LEDGER = Object.fromEntries(Object.entries(KNOWN).map(([id, k]) => [k.symbol.toLowerCase(), id]));
export function parseIcrcRef(text: string): { ledger: string; index: string } | undefined {
  const t = text.trim();
  const id = t.match(/[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}-cai/)?.[0];
  const sym = t.match(/\b(ck(?:btc|eth|usdc|usdt)|icp)\b/i)?.[1]?.toLowerCase();
  const ledger = id ?? (sym ? SYMBOL_TO_LEDGER[sym] : undefined);
  const index = (id ? t.replace(id, ' ') : t).match(/(?:^|[^0-9a-z])(\d{1,12})(?:[^0-9a-z]|$)/i)?.[1];
  return ledger && index && validPrincipal(ledger) ? { ledger, index } : undefined;
}
export async function fetchIcrcTx(ledger: string, index: string, lookup: IcpLookup = icpLookup): Promise<Facts> {
  const r = await lookup.icrcTx?.(ledger, index);
  if (!r || String(r.index) !== index || r.ledger_canister_id !== ledger) throw new Error('not found');
  const t = await ledgerToken(ledger, lookup);
  const who = (o?: string | null, a?: string | null) => a ?? o ?? undefined;
  const from = who(r.from_owner, r.from_account);
  const base: Facts = { kind: 'unknown_call', chainId: ICP_ID, chain: CHAIN, contract: ledger, ...(from ? { from, owner: from } : {}) };
  const amt = (v: any) => { const raw = BigInt(v ?? 0); return raw >= 2n ** 128n ? { raw: raw.toString(), display: 'unlimited', unlimited: true } : formatAmount(raw, t); };
  if (r.kind === 'approve') {
    const exp = r.expires_at ? BigInt(r.expires_at) : undefined;
    return { ...base, kind: 'erc20_approve', token: t, spender: who(r.spender_owner, r.spender_account), amount: amt(r.amount), deadline: exp ? { never: false, timestamp: Number(exp / 1_000_000_000n) } as any : { never: true } as any };
  }
  if (r.kind === 'transfer' && r.spender_owner) return { ...base, kind: 'transfer_from', token: t, amount: amt(r.amount), recipient: who(r.to_owner, r.to_account) };
  if (r.kind === 'transfer') return { ...base, kind: 'transfer', token: t, amount: amt(r.amount), recipient: who(r.to_owner, r.to_account) };
  return { ...base, kind: 'ledger_action', ledgerAction: 'settings', appName: String(r.kind ?? 'ledger') };
}

const cache = new Map<string, { symbol?: string; decimals?: number; totalSupply?: string } | undefined>();
export const icpLookup: IcpLookup = {
  ledger: async (id) => {
    if (cache.has(id)) return cache.get(id);
    const r = await fetch(`${ICRC_API}/ledgers/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10000) });
    const m = r.ok ? (await r.json())?.icrc1_metadata : undefined;
    const v = m ? { symbol: m.icrc1_symbol ?? undefined, decimals: m.icrc1_decimals != null ? Number(m.icrc1_decimals) : undefined, totalSupply: m.icrc1_total_supply ?? undefined } : undefined;
    if (cache.size > 2000) cache.clear();
    cache.set(id, v);
    return v;
  },
  icrcTx: async (ledger, index) => { const r = await fetch(`${ICRC_API}/ledgers/${encodeURIComponent(ledger)}/transactions/${encodeURIComponent(index)}`, { signal: AbortSignal.timeout(15000) }); return r.ok ? r.json() : undefined; },
  tx: async (hash) => { const r = await fetch(`${LEDGER_API}/transactions/${hash}`, { signal: AbortSignal.timeout(10000) }); return r.ok ? r.json() : undefined; },
};
