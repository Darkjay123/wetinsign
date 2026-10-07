import { Decoder } from 'cbor-x';
import type { Facts } from './facts.js';
import { formatAmount } from './format.js';
import type { TokenRef } from './tokens.js';
import { CHARSET, convertBits, hrpExpand, polymod } from './multiversx.js';

/**
 * Cardano. Not EVM and not accounts: a transaction spends old outputs (UTxOs) and makes new ones.
 * Wallets (Eternl, Lace, Yoroi, Vespr) hand dapps a CBOR transaction through CIP-30 signTx.
 * The drain shape is a transaction that sends your tokens to someone else's wallet with nothing coming back.
 * Change outputs are yours when they share the payment or stake key with what you spend.
 * Layout from the Conway CDDL (github.com/IntersectMBO/cardano-ledger, read 7 Oct 2026).
 * Inputs are resolved through Koios (api.koios.rest). 1815 is ADA's SLIP-44 coin type.
 */
export const CARDANO_ID = 1815;
const CHAIN = 'Cardano';
const KOIOS = process.env.KOIOS_URL ?? 'https://api.koios.rest/api/v1';
const ADA: TokenRef = { address: 'native', symbol: 'ADA', decimals: 6 };
export const CARDANO_HASH_RE = /^(0x)?[0-9a-fA-F]{64}$/;

export interface AdaAsset { unit: string; qty: bigint }
export interface AdaOut { address: string; lovelace: bigint; assets: AdaAsset[] }
export interface AdaTx { inputs: AdaOut[]; unresolved: number; outputs: AdaOut[]; certs: string[]; withdrawal: bigint; mint: boolean }
export interface AdaLookup {
  utxos?: (refs: string[]) => Promise<AdaOut[] | undefined>;
  asset?: (unit: string) => Promise<{ ticker?: string; decimals?: number } | undefined>;
  tx?: (hash: string) => Promise<any>;
}

// --- addresses ---
export function addrToBech32(bytes: Uint8Array): string {
  const head = bytes[0] >> 4;
  if (head === 8) return 'byron:' + Buffer.from(bytes).toString('hex').slice(0, 24);
  const hrp = (head === 14 || head === 15 ? 'stake' : 'addr') + ((bytes[0] & 0x0f) === 1 ? '' : '_test');
  const words = convertBits([...bytes], 8, 5, true)!;
  const chk = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const sum = Array.from({ length: 6 }, (_, i) => (chk >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...words, ...sum].map((w) => CHARSET[w]).join('');
}
export function bech32ToBytes(a: string): Uint8Array | undefined {
  const i = a.lastIndexOf('1');
  if (i < 1) return undefined;
  const hrp = a.slice(0, i).toLowerCase();
  const w = [...a.slice(i + 1).toLowerCase()].map((c) => CHARSET.indexOf(c));
  if (w.some((x) => x < 0) || polymod([...hrpExpand(hrp), ...w]) !== 1) return undefined;
  const b = convertBits(w.slice(0, -6), 5, 8, false);
  return b ? Uint8Array.from(b) : undefined;
}
/** Payment key, stake key and whether the payment side is a script (an app), from an address. */
export function creds(address: string): { pay?: string; stake?: string; script: boolean } {
  const b = bech32ToBytes(address);
  if (!b || b.length < 29) return { script: false };
  const t = b[0] >> 4;
  const hex = (x: Uint8Array) => Buffer.from(x).toString('hex');
  return { pay: hex(b.slice(1, 29)), stake: t <= 3 && b.length >= 57 ? hex(b.slice(29, 57)) : undefined, script: t <= 7 && (t & 1) === 1 };
}

// --- CBOR ---
const dec = new Decoder({ mapsAsObjects: false, useRecords: false } as any);
const untag = (v: any): any => (v instanceof Set ? [...v] : v && typeof v === 'object' && 'tag' in v && 'value' in v ? untag(v.value) : v);
const big = (v: any): bigint => { try { return BigInt(untag(v) ?? 0); } catch { return 0n; } };
const hexOf = (v: any) => Buffer.from(v as Uint8Array).toString('hex');
function value(v: any): { lovelace: bigint; assets: AdaAsset[] } {
  v = untag(v);
  if (!Array.isArray(v)) return { lovelace: big(v), assets: [] };
  const assets: AdaAsset[] = [];
  const ma = untag(v[1]);
  if (ma instanceof Map) for (const [p, names] of ma) for (const [n, q] of untag(names) as Map<any, any>) assets.push({ unit: hexOf(p) + hexOf(n), qty: big(q) });
  return { lovelace: big(v[0]), assets };
}
const CERT: Record<number, string> = { 0: 'register', 1: 'deregister', 2: 'delegate', 7: 'register', 8: 'deregister', 9: 'vote', 10: 'delegate', 11: 'delegate', 12: 'vote', 13: 'delegate' };

/** A hex CBOR transaction (or bare body) as CIP-30 signTx receives it. Returns the body plus the input refs to resolve. */
export function parseCardanoCbor(hex: string): { body: Omit<AdaTx, 'inputs' | 'unresolved'>; refs: string[] } | undefined {
  const h = hex.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]+$/.test(h) || h.length < 40 || h.length % 2) return undefined;
  let d: any;
  try { d = dec.decode(Buffer.from(h, 'hex')); } catch { return undefined; }
  const body = d instanceof Map ? d : Array.isArray(d) && d[0] instanceof Map ? d[0] : undefined;
  if (!body || !body.has(0) || !body.has(1)) return undefined;
  const refs = (untag(body.get(0)) as any[]).map((i) => `${hexOf(i[0])}#${Number(i[1])}`);
  const outputs: AdaOut[] = (untag(body.get(1)) as any[]).map((o) => {
    const addr = o instanceof Map ? o.get(0) : o[0];
    const v = value(o instanceof Map ? o.get(1) : o[1]);
    return { address: addrToBech32(addr), ...v };
  });
  const certs = ((untag(body.get(4)) as any[]) ?? []).map((c) => CERT[Number(c[0])] ?? 'other');
  let withdrawal = 0n;
  const w = untag(body.get(5));
  if (w instanceof Map) for (const v of w.values()) withdrawal += big(v);
  return { body: { outputs, certs, withdrawal, mint: body.has(9) }, refs };
}

/** Koios tx_info row (hash lookup). */
export function fromKoios(t: any): AdaTx | undefined {
  if (!t?.outputs) return undefined;
  const o = (x: any): AdaOut => ({ address: x.payment_addr?.bech32 ?? '', lovelace: big(x.value), assets: (x.asset_list ?? []).map((a: any) => ({ unit: a.policy_id + (a.asset_name ?? ''), qty: big(a.quantity) })) });
  const certs = (t.certificates ?? []).map((c: any) => String(c.type ?? '')).map((s: string) => (/deleg/.test(s) ? (/vote/.test(s) && !/stake/.test(s) ? 'vote' : 'delegate') : /dereg/.test(s) ? 'deregister' : /reg/.test(s) ? 'register' : 'other'));
  return { inputs: (t.inputs ?? []).map(o), unresolved: 0, outputs: t.outputs.map(o), certs, withdrawal: (t.withdrawals ?? []).reduce((s: bigint, w: any) => s + big(w.amount), 0n), mint: !!(t.assets_minted ?? []).length };
}

function assetName(unit: string): string {
  let n = unit.slice(56);
  if (/^(000de140|0014df10|000643b0)/.test(n)) n = n.slice(8);
  const s = Buffer.from(n, 'hex').toString('utf8');
  return n && /^[\x20-\x7e]+$/.test(s) ? s.slice(0, 32) : unit.slice(0, 8) + '…' + unit.slice(-4);
}
async function tokenOf(unit: string, lookup: AdaLookup): Promise<TokenRef> {
  const m = await lookup.asset?.(unit).catch(() => undefined);
  return { address: unit, symbol: m?.ticker || assetName(unit), decimals: Number.isInteger(m?.decimals) ? m!.decimals! : 0 };
}

export async function cardanoFacts(tx: AdaTx, lookup: AdaLookup = {}): Promise<Facts> {
  const mine = tx.inputs.map((i) => ({ a: i.address, ...creds(i.address) }));
  const from = mine[0]?.a;
  const base: Facts = { kind: 'unknown_call', chainId: CARDANO_ID, chain: CHAIN, ...(from ? { from, owner: from } : {}) };
  const isMine = (address: string) => {
    if (mine.some((m) => m.a === address)) return true;
    const c = creds(address);
    return mine.some((m) => (c.pay && m.pay === c.pay) || (c.stake && m.stake && m.stake === c.stake));
  };
  const resolved = tx.inputs.length > 0;
  const own = resolved ? tx.outputs.filter((o) => isMine(o.address)) : [];
  const ext = resolved ? tx.outputs.filter((o) => !isMine(o.address)) : tx.outputs;

  if (resolved && !ext.length) {
    if (tx.certs.includes('delegate') || tx.certs.includes('vote')) return { ...base, kind: 'ledger_action', ledgerAction: 'stake', appName: tx.certs.includes('delegate') ? 'stake pool delegation' : 'governance vote delegation' };
    if (tx.certs.length) return { ...base, kind: 'ledger_action', ledgerAction: tx.certs.includes('deregister') ? 'settings' : 'setup', appName: tx.certs.includes('deregister') ? 'stake key deregistration' : 'stake key registration' };
    return { ...base, kind: 'ledger_action', ledgerAction: 'internal_move', token: ADA, amount: formatAmount(tx.outputs.reduce((s, o) => s + o.lovelace, 0n), ADA), recipient: from };
  }

  // Merge outputs per receiving address.
  const by = new Map<string, AdaOut>();
  for (const o of ext) {
    const cur = by.get(o.address) ?? { address: o.address, lovelace: 0n, assets: [] };
    cur.lovelace += o.lovelace;
    for (const a of o.assets) { const e = cur.assets.find((x) => x.unit === a.unit); if (e) e.qty += a.qty; else cur.assets.push({ ...a }); }
    by.set(o.address, cur);
  }
  const receivers = [...by.values()];
  const scripts = receivers.filter((r) => creds(r.address).script);
  const wallets = receivers.filter((r) => !creds(r.address).script);
  const ownTokens = own.reduce((n, o) => n + o.assets.length, 0);
  const inTokens = new Set(tx.inputs.flatMap((i) => i.assets.map((a) => a.unit)));

  // Sweep: two or more different tokens to one ordinary wallet and none of your tokens come back as change.
  for (const r of wallets) {
    if (resolved && r.assets.length >= 2 && ownTokens === 0 && inTokens.size >= 2) {
      const items = await Promise.all(r.assets.map(async (a) => { const t = await tokenOf(a.unit, lookup); return { kind: 'transfer', token: t, spender: r.address, amount: formatAmount(a.qty, t) }; }));
      if (r.lovelace > 0n) items.unshift({ kind: 'transfer', token: ADA, spender: r.address, amount: formatAmount(r.lovelace, ADA) });
      return { ...base, kind: 'transfer', token: items[0].token, amount: items[0].amount, recipient: r.address, via: 'batch', bundle: items, sweep: { recipient: r.address, assets: items.map((x) => x.token.symbol ?? x.token.address) } };
    }
  }
  if (scripts.length && !wallets.length) {
    const s = scripts[0];
    const a = s.assets[0];
    const t = a ? await tokenOf(a.unit, lookup) : ADA;
    return { ...base, kind: 'ledger_action', ledgerAction: 'app_deposit', token: t, amount: formatAmount(a ? a.qty : s.lovelace, t), recipient: s.address, appName: s.address };
  }
  const items = (await Promise.all(wallets.map(async (r) => {
    const rows: Array<{ kind: string; token: TokenRef; spender: string; amount: ReturnType<typeof formatAmount> }> = [];
    for (const a of r.assets) { const t = await tokenOf(a.unit, lookup); rows.push({ kind: 'transfer', token: t, spender: r.address, amount: formatAmount(a.qty, t) }); }
    // A token on Cardano always rides with a little ADA (the minimum-ADA rule), so only plain ADA sends count as an ADA payment.
    if (!r.assets.length) rows.push({ kind: 'transfer', token: ADA, spender: r.address, amount: formatAmount(r.lovelace, ADA) });
    return rows;
  }))).flat();
  if (!items.length) return { ...base, appName: 'Cardano transaction' };
  const first = items[0];
  const multi = items.length > 1 ? { via: 'batch' as const, bundle: items } : {};
  if (first.token === ADA && items.length === 1) return { ...base, kind: 'native_send', token: ADA, amount: first.amount, recipient: first.spender };
  return { ...base, kind: 'transfer', token: first.token, amount: first.amount, recipient: first.spender, contract: first.token.address, ...multi };
}

async function koios(path: string, body: unknown): Promise<any> {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(KOIOS + path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1200)); continue; }
    if (!r.ok) throw new Error('koios ' + r.status);
    return r.json();
  }
  throw new Error('koios 429');
}
const assetCache = new Map<string, { ticker?: string; decimals?: number } | undefined>();
export const cardanoLookup: AdaLookup = {
  utxos: async (refs) => {
    const rows = await koios('/utxo_info', { _utxo_refs: refs.slice(0, 100), _extended: true });
    return (rows ?? []).map((x: any) => ({ address: x.address, lovelace: big(x.value), assets: (x.asset_list ?? []).map((a: any) => ({ unit: a.policy_id + (a.asset_name ?? ''), qty: big(a.quantity) })) }));
  },
  asset: async (unit) => {
    if (assetCache.has(unit)) return assetCache.get(unit);
    const rows = await koios('/asset_info', { _asset_list: [[unit.slice(0, 56), unit.slice(56)]] }).catch(() => []);
    const m = rows?.[0]?.token_registry_metadata;
    const v = m ? { ticker: m.ticker ?? undefined, decimals: m.decimals ?? undefined } : undefined;
    if (assetCache.size > 2000) assetCache.clear();
    assetCache.set(unit, v);
    return v;
  },
  tx: async (hash) => (await koios('/tx_info', { _tx_hashes: [hash], _inputs: true, _assets: true, _certs: true, _withdrawals: true, _metadata: false, _scripts: false }))?.[0],
};

export async function cardanoFromCbor(hex: string, lookup: AdaLookup = cardanoLookup): Promise<Facts | undefined> {
  const p = parseCardanoCbor(hex);
  if (!p) return undefined;
  const inputs = (await lookup.utxos?.(p.refs).catch(() => undefined)) ?? [];
  return cardanoFacts({ ...p.body, inputs, unresolved: p.refs.length - inputs.length }, lookup);
}
export async function fetchCardanoTx(hash: string, lookup: AdaLookup = cardanoLookup): Promise<Facts> {
  const t = fromKoios(await lookup.tx?.(hash.replace(/^0x/, '').toLowerCase()));
  if (!t) throw new Error('not found');
  return cardanoFacts(t, lookup);
}
