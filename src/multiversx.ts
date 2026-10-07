import type { Facts } from './facts.js';
import { formatAmount } from './format.js';
import type { TokenRef } from './tokens.js';

/**
 * MultiversX (EGLD). Not EVM: xPortal, DeFi Wallet and the web wallet sign a plain transaction
 * { nonce, value, receiver, sender, data, chainID }. Token moves live in the data field, e.g.
 * "ESDTTransfer@<token hex>@<amount hex>" or "MultiESDTNFTTransfer@<to>@<count>@(<token>@<nonce>@<amount>)...".
 * Built-in function names and argument order from docs.multiversx.com/tokens (read 7 Oct 2026).
 * 508 is EGLD's SLIP-44 coin type.
 */
export const MVX_ID = 508;
const CHAIN = 'MultiversX';
const API = process.env.MVX_API ?? 'https://api.multiversx.com';
const EGLD: TokenRef = { address: 'native', symbol: 'EGLD', decimals: 18 };

// --- bech32 (erd1...) ---
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}
const hrpExpand = (h: string) => [...[...h].map((c) => c.charCodeAt(0) >> 5), 0, ...[...h].map((c) => c.charCodeAt(0) & 31)];
function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | undefined {
  let acc = 0, bits = 0; const out: number[] = []; const maxv = (1 << to) - 1;
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); } }
  if (pad) { if (bits > 0) out.push((acc << (to - bits)) & maxv); } else if (bits >= from || ((acc << (to - bits)) & maxv)) return undefined;
  return out;
}
export function toErd(hex: string): string | undefined {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return undefined;
  const words = convertBits([...Buffer.from(hex, 'hex')], 8, 5, true)!;
  const chk = polymod([...hrpExpand('erd'), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const sum = Array.from({ length: 6 }, (_, i) => (chk >>> (5 * (5 - i))) & 31);
  return 'erd1' + [...words, ...sum].map((w) => CHARSET[w]).join('');
}
export const ERD_RE = /^erd1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/;
export function fromErd(a: string): string | undefined {
  if (!ERD_RE.test(a)) return undefined;
  const w = [...a.slice(4)].map((c) => CHARSET.indexOf(c));
  if (polymod([...hrpExpand('erd'), ...w]) !== 1) return undefined;
  const bytes = convertBits(w.slice(0, -6), 5, 8, false);
  return bytes && bytes.length === 32 ? Buffer.from(bytes).toString('hex') : undefined;
}
/** Smart contracts on MultiversX have 8 leading zero bytes (erd1qqqqqqqqqqqqq...). */
export const isMvxContract = (a?: string) => !!a && (fromErd(a) ?? '').startsWith('0000000000000000');

export interface MvxTx { receiver: string; sender?: string; value?: string; data?: string; nonce?: number | string; chainID?: string }
export interface MvxLookup {
  token?: (id: string) => Promise<{ ticker?: string; decimals?: number; name?: string } | undefined>;
  tx?: (hash: string) => Promise<any>;
}

/** Accepts one transaction, an array of them, or { transactions: [...] } (sdk-dapp / xPortal hub). */
export function asMvxTxs(v: any): MvxTx[] | undefined {
  const list = Array.isArray(v) ? v : Array.isArray(v?.transactions) ? v.transactions : v?.transaction && typeof v.transaction === 'object' ? [v.transaction] : [v];
  const ok = list.filter((t: any) => t && typeof t === 'object' && typeof t.receiver === 'string' && ERD_RE.test(t.receiver) && (t.sender === undefined || ERD_RE.test(String(t.sender))));
  return ok.length && ok.length === list.length ? ok : undefined;
}

/** The data field arrives base64 (wallet signing payloads, the API) or as plain text. */
export function mvxData(d?: string): string {
  if (!d) return '';
  if (!d.includes('@') && /^[A-Za-z0-9+/]+={0,2}$/.test(d) && d.length % 4 === 0) {
    const s = Buffer.from(d, 'base64').toString('utf8');
    if (/^[\x20-\x7e\n\r\t]*$/.test(s)) return s;
  }
  return d;
}
const hexStr = (h = '') => (/^([0-9a-fA-F]{2})*$/.test(h) ? Buffer.from(h, 'hex').toString('utf8') : h);
const hexBig = (h = '') => (/^[0-9a-fA-F]*$/.test(h) && h ? BigInt('0x' + h) : 0n);
const TOKEN_RE = /^[A-Z0-9]{3,10}-[0-9a-f]{6}$/;

async function token(id: string, nonce: bigint, lookup: MvxLookup): Promise<TokenRef> {
  const m = TOKEN_RE.test(id) ? await lookup.token?.(id).catch(() => undefined) : undefined;
  const label = nonce > 0n ? `${m?.ticker ?? id} #${nonce}` : m?.ticker ?? id;
  return { address: nonce > 0n ? `${id}-${nonce.toString(16).padStart(2, '0')}` : id, symbol: label, decimals: nonce > 0n && m?.decimals === undefined ? 0 : m?.decimals };
}

export async function mvxFacts(txs: MvxTx[], lookup: MvxLookup = {}): Promise<Facts> {
  const tx = txs[0];
  const data = mvxData(tx.data);
  const [fn, ...args] = data.split('@');
  const from = tx.sender;
  const base: Facts = { kind: 'unknown_call', chainId: MVX_ID, chain: CHAIN, ...(from ? { from, owner: from } : {}) };
  const value = (() => { try { return BigInt(String(tx.value ?? '0')); } catch { return 0n; } })();
  const nativeValue = value > 0n ? formatAmount(value, EGLD) : undefined;
  const toContract = isMvxContract(tx.receiver);

  if (fn === 'ESDTTransfer' && args.length >= 2) {
    const t = await token(hexStr(args[0]), 0n, lookup);
    const amount = formatAmount(hexBig(args[1]), t);
    if (args[2] && toContract) return { ...base, kind: 'ledger_action', ledgerAction: 'app_deposit', token: t, amount, recipient: tx.receiver, appName: tx.receiver, selector: hexStr(args[2]) };
    return { ...base, kind: 'transfer', token: t, amount, recipient: tx.receiver, contract: t.address };
  }
  if (fn === 'ESDTNFTTransfer' && args.length >= 4) {
    const t = await token(hexStr(args[0]), hexBig(args[1]), lookup);
    const to = toErd(args[3]) ?? args[3];
    const amount = formatAmount(hexBig(args[2]), t);
    if (args[4] && isMvxContract(to)) return { ...base, kind: 'ledger_action', ledgerAction: 'app_deposit', token: t, amount, recipient: to, appName: to, selector: hexStr(args[4]) };
    return { ...base, kind: 'transfer', token: t, amount, recipient: to, contract: t.address };
  }
  if (fn === 'MultiESDTNFTTransfer' && args.length >= 2) {
    const to = toErd(args[0]) ?? args[0];
    const n = Number(hexBig(args[1]));
    if (!Number.isFinite(n) || n < 1 || n > 100 || args.length < 2 + 3 * n) return { ...base, appName: fn, selector: fn };
    const items: Array<{ kind: string; token: TokenRef; spender: string; amount: ReturnType<typeof formatAmount>; collection: string }> = [];
    for (let i = 0; i < n; i++) {
      const id = hexStr(args[2 + 3 * i]);
      const t = id === 'EGLD-000000' ? EGLD : await token(id, hexBig(args[3 + 3 * i]), lookup);
      items.push({ kind: 'transfer', token: t, spender: to, amount: formatAmount(hexBig(args[4 + 3 * i]), t), collection: id });
    }
    const call = args[2 + 3 * n];
    const bundle = items.map(({ collection: _c, ...b }) => b);
    if (call && isMvxContract(to)) return { ...base, kind: 'ledger_action', ledgerAction: 'app_deposit', token: items[0].token, amount: items[0].amount, recipient: to, appName: to, selector: hexStr(call), via: 'batch', bundle };
    const distinct = [...new Set(items.map((x) => x.collection))];
    // Several different coins or collections to one ordinary wallet in one go: the drainer sweep shape.
    if (distinct.length >= 2 && !isMvxContract(to)) return { ...base, kind: 'transfer', token: items[0].token, amount: items[0].amount, recipient: to, via: 'batch', bundle, sweep: { recipient: to, assets: items.map((x) => x.token.symbol ?? x.collection) } };
    return { ...base, kind: 'transfer', token: items[0].token, amount: items[0].amount, recipient: to, contract: items[0].token.address, ...(n > 1 ? { via: 'batch' as const, bundle } : {}) };
  }
  // Guardian: a co-signer that must approve your transactions once GuardAccount runs.
  if (fn === 'SetGuardian' && args[0]) return { ...base, kind: 'account_control', control: 'guardian', spender: toErd(args[0]) ?? args[0], ...(args[1] ? { memo: hexStr(args[1]) } : {}) };
  if (fn === 'GuardAccount' || fn === 'UnGuardAccount') return { ...base, kind: 'ledger_action', ledgerAction: 'settings', appName: fn };
  if (fn === 'ChangeOwnerAddress' && args[0] && toContract) return { ...base, kind: 'ownership_transfer', contract: tx.receiver, recipient: toErd(args[0]) ?? args[0] };
  if (!fn) {
    if (value > 0n) return { ...base, kind: 'native_send', token: EGLD, amount: nativeValue, recipient: tx.receiver };
    return { ...base, kind: 'ledger_action', ledgerAction: 'settings', recipient: tx.receiver };
  }
  // Plain EGLD with a note (exchanges and apps read it). The note is shown verbatim, never trusted.
  if (!toContract && value > 0n) return { ...base, kind: 'native_send', token: EGLD, amount: nativeValue, recipient: tx.receiver, memo: data.slice(0, 300) };
  if (!toContract) return { ...base, kind: 'ledger_action', ledgerAction: 'settings', recipient: tx.receiver, memo: data.slice(0, 300) };
  return { ...base, contract: tx.receiver, appName: tx.receiver, selector: fn.slice(0, 80), ...(nativeValue ? { nativeValue } : {}) };
}

const metaCache = new Map<string, { ticker?: string; decimals?: number } | undefined>();
async function get(path: string): Promise<any> {
  const r = await fetch(`${API}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`multiversx ${r.status}`);
  return r.json();
}
export const mvxLookup: MvxLookup = {
  token: async (id) => {
    if (!TOKEN_RE.test(id)) return undefined;
    if (metaCache.has(id)) return metaCache.get(id);
    const r = await get(`/tokens/${id}`).catch(() => get(`/collections/${id}`).catch(() => undefined));
    const v = r ? { ticker: r.ticker ?? r.collection, decimals: r.decimals !== undefined ? Number(r.decimals) : undefined } : undefined;
    if (metaCache.size > 2000) metaCache.clear();
    metaCache.set(id, v);
    return v;
  },
  tx: async (hash) => get(`/transactions/${hash.replace(/^0x/, '').toLowerCase()}?withScResults=false&withOperations=false&withLogs=false`),
};
export async function fetchMvxTx(hash: string, lookup: MvxLookup = mvxLookup): Promise<Facts> {
  const t = await lookup.tx?.(hash);
  if (!t?.receiver) throw new Error('not found');
  return mvxFacts([{ receiver: t.receiver, sender: t.sender, value: t.value, data: t.data, nonce: t.nonce }], lookup);
}
