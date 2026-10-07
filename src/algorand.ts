import algosdk from 'algosdk';
import type { Facts } from './facts.js';
import { formatAmount } from './format.js';
import type { TokenRef } from './tokens.js';

/**
 * Algorand. Not EVM: Pera, Defly and Lute sign msgpack transactions, usually handed over base64
 * (WalletConnect algo_signTxn: [{ txn: "<base64>" }, ...], often a group). The two classic drains are
 * rekey-to (your account now answers to someone else's key) and close-remainder-to (every last ALGO goes out).
 * Field names from algosdk 3.8 / developer.algorand.org transaction reference (read 7 Oct 2026).
 * 283 is ALGO's SLIP-44 coin type.
 */
export const ALGO_ID = 283;
const CHAIN = 'Algorand';
const INDEXER = process.env.ALGO_INDEXER ?? 'https://mainnet-idx.algonode.cloud/v2';
const ALGO: TokenRef = { address: 'native', symbol: 'ALGO', decimals: 6 };
const KNOWN: Record<string, { symbol: string; decimals: number }> = { '31566704': { symbol: 'USDC', decimals: 6 }, '312769': { symbol: 'USDt', decimals: 6 } };

/** One transaction in a shape we can judge, whatever it arrived as. */
export interface AlgoTx {
  type: string; sender: string; receiver?: string; amount?: bigint; closeTo?: string; rekeyTo?: string;
  assetId?: string; appId?: string; note?: string;
}
export interface AlgoLookup {
  asset?: (id: string) => Promise<{ symbol?: string; decimals?: number } | undefined>;
  tx?: (id: string) => Promise<any>;
}
export const ALGO_TXID_RE = /^[A-Z2-7]{52}$/;
const ADDR_RE = /^[A-Z2-7]{58}$/;

function fromSdk(t: algosdk.Transaction): AlgoTx {
  const s = (a?: { toString(): string }) => (a ? a.toString() : undefined);
  const zero = algosdk.ALGORAND_ZERO_ADDRESS_STRING;
  const nz = (a?: { toString(): string }) => { const v = s(a); return v && v !== zero ? v : undefined; };
  const note = t.note?.length ? Buffer.from(t.note).toString('utf8').replace(/[^\x20-\x7e]/g, '').slice(0, 200) : undefined;
  const base: AlgoTx = { type: t.type, sender: s(t.sender)!, rekeyTo: nz(t.rekeyTo), ...(note ? { note } : {}) };
  if (t.payment) return { ...base, receiver: s(t.payment.receiver), amount: BigInt(t.payment.amount), closeTo: nz(t.payment.closeRemainderTo) };
  if (t.assetTransfer) return { ...base, receiver: s(t.assetTransfer.receiver), amount: BigInt(t.assetTransfer.amount), assetId: String(t.assetTransfer.assetIndex), closeTo: nz(t.assetTransfer.closeRemainderTo) };
  if (t.applicationCall) return { ...base, appId: String(t.applicationCall.appIndex) };
  return base;
}
function decodeB64(b64: string): AlgoTx | undefined {
  try {
    const bytes = Buffer.from(b64.trim(), 'base64');
    try { return fromSdk(algosdk.decodeSignedTransaction(bytes).txn); } catch { return fromSdk(algosdk.decodeUnsignedTransaction(bytes)); }
  } catch { return undefined; }
}
/** Indexer JSON (what a hash lookup returns, and what explorers show). */
export function fromIndexer(t: any): AlgoTx | undefined {
  if (!t || typeof t !== 'object' || typeof t.sender !== 'string' || typeof t['tx-type'] !== 'string') return undefined;
  const p = t['payment-transaction'], a = t['asset-transfer-transaction'], c = t['application-transaction'];
  const note = t.note ? Buffer.from(t.note, 'base64').toString('utf8').replace(/[^\x20-\x7e]/g, '').slice(0, 200) : undefined;
  const base: AlgoTx = { type: t['tx-type'], sender: t.sender, rekeyTo: t['rekey-to'], ...(note ? { note } : {}) };
  if (p) return { ...base, receiver: p.receiver, amount: BigInt(p.amount ?? 0), closeTo: p['close-remainder-to'] };
  if (a) return { ...base, receiver: a.receiver, amount: BigInt(a.amount ?? 0), assetId: String(a['asset-id']), closeTo: a['close-to'] };
  if (c) return { ...base, appId: String(c['application-id']) };
  return base;
}
const looksB64Txn = (s: string) => /^[A-Za-z0-9+/]{40,}={0,2}$/.test(s.trim()) && (() => { const b = Buffer.from(s.trim(), 'base64'); return b[0] >= 0x80 && b[0] <= 0x8f; })();

/** Accepts base64 msgpack (one or a JSON array), WalletConnect [{ txn }] groups, { txns: [...] }, or indexer JSON. */
export function parseAlgo(v: unknown): AlgoTx[] | undefined {
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('[') || s.startsWith('{')) { try { return parseAlgo(JSON.parse(s)); } catch { return undefined; } }
    if (!looksB64Txn(s)) return undefined;
    const t = decodeB64(s); return t ? [t] : undefined;
  }
  if (Array.isArray(v)) {
    const flat = v.flat(2);
    const out = flat.map((x: any) => (typeof x === 'string' ? (looksB64Txn(x) ? decodeB64(x) : undefined) : typeof x?.txn === 'string' ? decodeB64(x.txn) : fromIndexer(x)));
    return out.length && out.every(Boolean) ? (out as AlgoTx[]) : undefined;
  }
  if (v && typeof v === 'object') {
    const o = v as any;
    if (Array.isArray(o.txns)) return parseAlgo(o.txns);
    if (Array.isArray(o.params)) return parseAlgo(o.params);
    if (typeof o.txn === 'string') return parseAlgo([o]);
    if (o.transaction) return parseAlgo([o.transaction]);
    const t = fromIndexer(o); return t ? [t] : undefined;
  }
  return undefined;
}

async function asset(id: string, lookup: AlgoLookup): Promise<TokenRef> {
  const k = KNOWN[id] ?? (await lookup.asset?.(id).catch(() => undefined));
  return { address: id, symbol: k?.symbol ?? `asset ${id}`, decimals: k?.decimals };
}

export async function algoFacts(txs: AlgoTx[], lookup: AlgoLookup = {}): Promise<Facts> {
  const from = txs[0].sender;
  const base: Facts = { kind: 'unknown_call', chainId: ALGO_ID, chain: CHAIN, from, owner: from };
  // 1. Rekey anywhere in the group: the account stops answering to your key. Rekeying back to yourself is an undo.
  const rk = txs.find((t) => t.rekeyTo && t.rekeyTo !== t.sender);
  if (rk) return { ...base, kind: 'account_control', control: 'rekey', spender: rk.rekeyTo, from: rk.sender, owner: rk.sender };
  // 2. Closing the account: every remaining ALGO goes to the close address.
  const cl = txs.find((t) => t.type === 'pay' && t.closeTo);
  if (cl) return { ...base, kind: 'account_control', control: 'account_delete', recipient: cl.closeTo, from: cl.sender, owner: cl.sender };
  const one = async (t: AlgoTx) => {
    if (t.type === 'pay') return { kind: 'native_send', token: ALGO, amount: formatAmount(t.amount ?? 0n, ALGO), spender: t.receiver! };
    if (t.type === 'axfer') { const tok = await asset(t.assetId!, lookup); return { kind: 'transfer', token: tok, amount: formatAmount(t.amount ?? 0n, tok), spender: t.receiver!, close: t.closeTo }; }
    return undefined;
  };
  const moves = (await Promise.all(txs.filter((t) => t.sender === from).map(one))).filter(Boolean) as Array<{ kind: string; token: TokenRef; amount: ReturnType<typeof formatAmount>; spender: string; close?: string }>;
  // Asset opt-in: a zero transfer to yourself.
  const real = moves.filter((m) => !(m.spender === from && m.amount.raw === '0' && !m.close));
  const closes = moves.filter((m) => m.close);
  if (closes.length) return { ...base, kind: 'ledger_action', ledgerAction: 'close_out', token: closes[0].token, recipient: closes[0].close };
  const apps = txs.filter((t) => t.type === 'appl');
  // Several different assets to one outside address in one group: the drainer sweep shape.
  const outs = real.filter((m) => m.spender !== from);
  const byTo = new Map<string, Set<string>>();
  for (const m of outs) byTo.set(m.spender, (byTo.get(m.spender) ?? new Set()).add(m.token.address));
  const sweepTo = [...byTo].find(([, s]) => s.size >= 2)?.[0];
  const bundle = outs.map(({ kind, token, amount, spender }) => ({ kind, token, amount, spender }));
  if (sweepTo && !apps.length) return { ...base, kind: 'transfer', token: outs[0].token, amount: outs[0].amount, recipient: sweepTo, via: 'batch', bundle, sweep: { recipient: sweepTo, assets: outs.filter((m) => m.spender === sweepTo).map((m) => m.token.symbol ?? m.token.address) } };
  if (apps.length) {
    // Payments into an app call (swaps, deposits): name the app, show what goes in.
    const first = outs[0];
    if (first) return { ...base, kind: 'ledger_action', ledgerAction: 'app_deposit', token: first.token, amount: first.amount, recipient: first.spender, appName: `app ${apps[0].appId}`, ...(outs.length > 1 ? { via: 'batch' as const, bundle } : {}) };
    return { ...base, appName: `app ${apps[0].appId}`, selector: `app ${apps[0].appId}` };
  }
  if (outs.length) {
    const m = outs[0];
    const memo = txs.find((t) => t.note)?.note;
    return { ...base, kind: m.kind as Facts['kind'], token: m.token, amount: m.amount, recipient: m.spender, ...(m.kind === 'transfer' ? { contract: m.token.address } : {}), ...(outs.length > 1 ? { via: 'batch' as const, bundle } : {}), ...(memo ? { memo } : {}) };
  }
  if (moves.length) return { ...base, kind: 'ledger_action', ledgerAction: 'setup', token: moves[0].token };
  if (txs.some((t) => t.type === 'keyreg')) return { ...base, kind: 'ledger_action', ledgerAction: 'stake' };
  return { ...base, kind: 'ledger_action', ledgerAction: 'settings' };
}

async function get(path: string): Promise<any> {
  const r = await fetch(`${INDEXER}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`algorand ${r.status}`);
  return r.json();
}
const cache = new Map<string, { symbol?: string; decimals?: number } | undefined>();
export const algoLookup: AlgoLookup = {
  asset: async (id) => {
    if (!/^\d{1,20}$/.test(id)) return undefined;
    if (cache.has(id)) return cache.get(id);
    const r = await get(`/assets/${id}`).catch(() => undefined);
    const p = r?.asset?.params;
    const v = p ? { symbol: p['unit-name'] ?? p.name, decimals: Number(p.decimals) } : undefined;
    if (cache.size > 2000) cache.clear();
    cache.set(id, v);
    return v;
  },
  tx: async (id) => (await get(`/transactions/${id}`))?.transaction,
};
export async function fetchAlgoTx(id: string, lookup: AlgoLookup = algoLookup): Promise<Facts> {
  if (!ALGO_TXID_RE.test(id)) throw new Error('bad id');
  const t = fromIndexer(await lookup.tx?.(id));
  if (!t) throw new Error('not found');
  return algoFacts([t], lookup);
}
export const isAlgoAddress = (a: string) => ADDR_RE.test(a);
