import type { Facts } from './facts.js';
import { formatAmount, type Amount } from './format.js';
import { b58encode } from './solana.js';
import type { TokenRef } from './tokens.js';

/**
 * NEAR. Not EVM: a transaction is a list of actions (Transfer, FunctionCall, AddKey, DeleteAccount...) from one
 * account to another. Wallets (HOT, Meteor, MyNearWallet, NEAR Mobile) get it as wallet-selector JSON, near-api-js
 * JSON or base64 borsh bytes. 397 is NEAR's SLIP-44 coin type.
 *
 * The NEAR drainer move is AddKey with FullAccess: a new key that can do anything the account can, forever.
 * Action list and tags read from nearcore core/primitives/src/action/mod.rs on 7 Oct 2026.
 */
export const NEAR_ID = 397;
const CHAIN = 'NEAR';
const RPC = process.env.NEAR_RPC ?? 'https://archival-rpc.mainnet.fastnear.com';
const NEARBLOCKS = process.env.NEARBLOCKS_API ?? 'https://api.nearblocks.io/v1';
const NEAR_TOKEN: TokenRef = { address: 'native', symbol: 'NEAR', decimals: 24 };
// Read with ft_metadata on mainnet on 7 Oct 2026.
const KNOWN_FT: Record<string, { symbol: string; decimals: number }> = {
  'usdt.tether-token.near': { symbol: 'USDt', decimals: 6 },
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': { symbol: 'USDC', decimals: 6 },
  'wrap.near': { symbol: 'wNEAR', decimals: 24 },
};
const ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isNearAccount = (s: unknown): s is string => typeof s === 'string' && ACCOUNT_RE.test(s);

export type NearAction =
  | { type: 'CreateAccount' }
  | { type: 'DeployContract' }
  | { type: 'FunctionCall'; method: string; args: unknown; deposit: bigint }
  | { type: 'Transfer'; deposit: bigint }
  | { type: 'Stake'; stake: bigint }
  | { type: 'AddKey'; publicKey: string; full: boolean; allowance?: bigint; keyReceiver?: string; methods?: string[] }
  | { type: 'DeleteKey'; publicKey: string }
  | { type: 'DeleteAccount'; beneficiary: string }
  | { type: 'Unknown'; name: string };
export interface NearTx { signer?: string; receiver: string; actions: NearAction[] }
export interface NearLookup {
  ft?: (contract: string) => Promise<{ symbol?: string; decimals?: number } | undefined>;
  tx?: (hash: string) => Promise<NearTx[] | undefined>;
}

const big = (v: unknown): bigint => { try { return BigInt(typeof v === 'number' ? Math.trunc(v) : String(v ?? 0)); } catch { return 0n; } };
/** Function-call args: base64 (RPC, borsh), a byte array, a JSON string, or already an object. */
function readArgs(a: unknown): unknown {
  if (a && typeof a === 'object' && !Array.isArray(a) && !(a instanceof Uint8Array)) return a;
  let text: string | undefined;
  if (a instanceof Uint8Array || Array.isArray(a)) text = Buffer.from(a as number[]).toString('utf8');
  else if (typeof a === 'string') {
    const t = a.trim();
    if (t.startsWith('{')) text = t;
    else if (/^[A-Za-z0-9+/]+={0,2}$/.test(t)) text = Buffer.from(t, 'base64').toString('utf8');
  }
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/** One action in any of the three JSON shapes wallets and the RPC use. */
function readAction(a: any): NearAction {
  if (a === 'CreateAccount' || a?.type === 'CreateAccount' || a?.createAccount || a?.CreateAccount !== undefined && a?.CreateAccount !== null) {
    if (a === 'CreateAccount' || a?.type === 'CreateAccount' || a?.createAccount !== undefined || 'CreateAccount' in (a ?? {})) return { type: 'CreateAccount' };
  }
  const p = a?.params ?? {};
  const t = a?.type;
  const fc = a?.FunctionCall ?? a?.functionCall ?? (t === 'FunctionCall' ? p : undefined);
  if (fc) return { type: 'FunctionCall', method: String(fc.method_name ?? fc.methodName ?? ''), args: readArgs(fc.args), deposit: big(fc.deposit) };
  const tr = a?.Transfer ?? a?.transfer ?? (t === 'Transfer' ? p : undefined);
  if (tr) return { type: 'Transfer', deposit: big(tr.deposit) };
  const ak = a?.AddKey ?? a?.addKey ?? (t === 'AddKey' ? p : undefined);
  if (ak) {
    const key = String(ak.public_key ?? ak.publicKey ?? '');
    const perm = (ak.access_key ?? ak.accessKey)?.permission;
    const full = perm === 'FullAccess' || perm === 'fullAccess' || !!perm?.fullAccess || !!perm?.FullAccess;
    if (full) return { type: 'AddKey', publicKey: key, full: true };
    const f = perm?.FunctionCall ?? perm?.functionCall ?? perm ?? {};
    const allowance = f.allowance === null || f.allowance === undefined ? undefined : big(f.allowance);
    return { type: 'AddKey', publicKey: key, full: false, allowance, keyReceiver: f.receiver_id ?? f.receiverId, methods: f.method_names ?? f.methodNames ?? [] };
  }
  const dk = a?.DeleteKey ?? a?.deleteKey ?? (t === 'DeleteKey' ? p : undefined);
  if (dk) return { type: 'DeleteKey', publicKey: String(dk.public_key ?? dk.publicKey ?? '') };
  const da = a?.DeleteAccount ?? a?.deleteAccount ?? (t === 'DeleteAccount' ? p : undefined);
  if (da) return { type: 'DeleteAccount', beneficiary: String(da.beneficiary_id ?? da.beneficiaryId ?? '') };
  const st = a?.Stake ?? a?.stake ?? (t === 'Stake' ? p : undefined);
  if (st) return { type: 'Stake', stake: big(st.stake) };
  if (a?.DeployContract ?? a?.deployContract ?? t === 'DeployContract') return { type: 'DeployContract' };
  return { type: 'Unknown', name: String(t ?? (a && typeof a === 'object' ? Object.keys(a)[0] : a) ?? 'unknown') };
}

/** A transaction in JSON, with meta-transactions (Delegate) unwrapped to what they do to their sender. */
function readTxJson(v: any): NearTx[] {
  const receiver = v.receiver_id ?? v.receiverId;
  const signer = v.signer_id ?? v.signerId;
  const out: NearTx[] = [];
  const own: NearAction[] = [];
  for (const a of v.actions ?? []) {
    const d = a?.Delegate?.delegate_action ?? a?.delegate?.delegateAction;
    if (d) out.push(...readTxJson({ signer_id: d.sender_id ?? d.senderId, receiver_id: d.receiver_id ?? d.receiverId, actions: d.actions }));
    else own.push(readAction(a));
  }
  if (own.length) out.unshift({ signer, receiver, actions: own });
  return out;
}

export function isNearRequest(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const one = (x: any) => !!x && typeof x === 'object' && isNearAccount(x.receiver_id ?? x.receiverId) && Array.isArray(x.actions) && x.actions.length > 0;
  const o = v as any;
  if (Array.isArray(o)) return o.length > 0 && o.every(one);
  if (Array.isArray(o.transactions)) return o.transactions.length > 0 && o.transactions.every(one);
  return one(o) || one(o.transaction);
}
export function nearFromJson(v: any): NearTx[] {
  const list = Array.isArray(v) ? v : Array.isArray(v?.transactions) ? v.transactions : [v?.transaction && !v.actions ? v.transaction : v];
  return list.flatMap(readTxJson);
}

// ---- borsh: the bytes MyNearWallet-style links and near-api-js hand to a wallet ----
class Borsh {
  o = 0;
  constructor(readonly b: Uint8Array) {}
  need(n: number) { if (n < 0 || this.o + n > this.b.length) throw new Error('short'); }
  u8() { this.need(1); return this.b[this.o++]; }
  u32() { this.need(4); const v = this.b[this.o] | (this.b[this.o + 1] << 8) | (this.b[this.o + 2] << 16) | (this.b[this.o + 3] << 24); this.o += 4; return v >>> 0; }
  uint(bytes: number) { this.need(bytes); let v = 0n; for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.b[this.o + i]); this.o += bytes; return v; }
  bytes(n: number) { this.need(n); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  vec() { const n = this.u32(); if (n > 4_000_000) throw new Error('too long'); return this.bytes(n); }
  str() { const s = Buffer.from(this.vec()).toString('utf8'); return s; }
  account() { const s = this.str(); if (!isNearAccount(s)) throw new Error('bad account'); return s; }
  key() { const t = this.u8(); if (t === 0) return 'ed25519:' + b58encode(this.bytes(32)); if (t === 1) return 'secp256k1:' + b58encode(this.bytes(64)); throw new Error('bad key'); }
}
function borshAction(r: Borsh, inDelegate = false): NearAction | NearTx {
  const tag = r.u8();
  switch (tag) {
    case 0: return { type: 'CreateAccount' };
    case 1: r.vec(); return { type: 'DeployContract' };
    case 2: { const method = r.str(); const args = readArgs(r.vec()); r.uint(8); return { type: 'FunctionCall', method, args, deposit: r.uint(16) }; }
    case 3: return { type: 'Transfer', deposit: r.uint(16) };
    case 4: { const stake = r.uint(16); r.key(); return { type: 'Stake', stake }; }
    case 5: {
      const publicKey = r.key(); r.uint(8);
      const p = r.u8();
      if (p === 1) return { type: 'AddKey', publicKey, full: true };
      if (p !== 0) throw new Error('unknown permission');
      const allowance = r.u8() ? r.uint(16) : undefined;
      const keyReceiver = r.account();
      const n = r.u32(); if (n > 1000) throw new Error('too many');
      const methods = Array.from({ length: n }, () => r.str());
      return { type: 'AddKey', publicKey, full: false, allowance, keyReceiver, methods };
    }
    case 6: return { type: 'DeleteKey', publicKey: r.key() };
    case 7: return { type: 'DeleteAccount', beneficiary: r.account() };
    case 8: {
      if (inDelegate) throw new Error('nested delegate');
      const signer = r.account(); const receiver = r.account();
      const n = r.u32(); if (n > 100) throw new Error('too many');
      const actions = Array.from({ length: n }, () => borshAction(r, true) as NearAction);
      r.uint(8); r.uint(8); r.key();
      r.u8(); r.bytes(64); // signature
      return { signer, receiver, actions };
    }
    default: throw new Error(`action ${tag}`);
  }
}
/** A borsh Transaction or SignedTransaction. Strict: every byte must be accounted for. */
export function nearFromBorsh(bytes: Uint8Array): NearTx[] {
  const r = new Borsh(bytes);
  const signer = r.account(); r.key(); r.uint(8);
  const receiver = r.account(); r.bytes(32);
  const n = r.u32(); if (n > 100) throw new Error('too many');
  const own: NearAction[] = []; const inner: NearTx[] = [];
  for (let i = 0; i < n; i++) { const a = borshAction(r); if ('actions' in a) inner.push(a); else own.push(a); }
  const rest = r.b.length - r.o;
  if (rest !== 0 && rest !== 65) throw new Error('trailing bytes');
  return [...(own.length ? [{ signer, receiver, actions: own }] : []), ...inner];
}
/** Pasted text: JSON, base64 borsh (one or several, comma-separated), or a wallet link carrying ?transactions=. */
export function parseNearText(text: string): NearTx[] | undefined {
  let t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { const j = JSON.parse(t); return isNearRequest(j) ? nearFromJson(j) : undefined; } catch { return undefined; }
  }
  const m = t.match(/[?&]transactions=([^&#\s]+)/);
  if (m) t = decodeURIComponent(m[1]);
  const parts = t.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length || !parts.every((p) => /^[A-Za-z0-9+/_-]+={0,2}$/.test(p))) return undefined;
  try {
    return parts.flatMap((p) => nearFromBorsh(Uint8Array.from(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))));
  } catch { return undefined; }
}
export const looksLikeNearTx = (s: unknown) => typeof s === 'string' && !!parseNearText(s);

type Item = { rank: number; facts: Partial<Facts>; send?: { to: string; token: TokenRef; amount: Amount } };

/** What a set of NEAR transactions does to the signer, led by the most dangerous action. */
export async function nearFacts(txs: NearTx[], lookup: NearLookup = {}): Promise<Facts> {
  const me = txs.find((t) => t.signer)?.signer;
  const base: Facts = { kind: 'unknown_call', chainId: NEAR_ID, chain: CHAIN, ...(me ? { from: me } : {}) };
  const ft = async (contract: string): Promise<TokenRef> => {
    const k = KNOWN_FT[contract];
    if (k) return { address: contract, ...k };
    const m = await lookup.ft?.(contract).catch(() => undefined);
    return { address: contract, symbol: m?.symbol, decimals: m?.decimals };
  };
  const items: Item[] = [];
  for (const tx of txs) {
    const creates = tx.actions.some((a) => a.type === 'CreateAccount');
    const own = !tx.signer || tx.receiver === tx.signer;
    for (const a of tx.actions) {
      switch (a.type) {
        case 'Transfer':
          if (a.deposit > 0n) items.push({ rank: 40, facts: { kind: 'native_send', token: NEAR_TOKEN, amount: formatAmount(a.deposit, NEAR_TOKEN), recipient: tx.receiver }, send: { to: tx.receiver, token: NEAR_TOKEN, amount: formatAmount(a.deposit, NEAR_TOKEN) } });
          break;
        case 'AddKey':
          // A key on an account this same transaction creates belongs to the new account, not yours.
          if (creates || !own) { items.push({ rank: 5, facts: { kind: 'ledger_action', ledgerAction: 'setup' } }); break; }
          if (a.full) items.push({ rank: 100, facts: { kind: 'account_control', control: 'full_access_key', spender: a.publicKey } });
          else items.push({ rank: 10, facts: { kind: 'ledger_action', ledgerAction: 'app_key', contract: a.keyReceiver, ...(a.allowance !== undefined ? { amount: formatAmount(a.allowance, NEAR_TOKEN), token: NEAR_TOKEN } : { token: NEAR_TOKEN }) } });
          break;
        case 'DeleteKey':
          items.push({ rank: 8, facts: { kind: 'account_control', control: 'remove_key' } });
          break;
        case 'DeleteAccount':
          items.push({ rank: 95, facts: { kind: 'account_control', control: 'account_delete', recipient: a.beneficiary } });
          break;
        case 'DeployContract':
          if (!creates) items.push({ rank: 98, facts: { kind: 'account_control', control: 'deploy_code' } });
          break;
        case 'Stake':
          items.push({ rank: 15, facts: { kind: 'ledger_action', ledgerAction: 'stake' } });
          break;
        case 'CreateAccount':
          items.push({ rank: 3, facts: { kind: 'ledger_action', ledgerAction: 'setup' } });
          break;
        case 'FunctionCall': {
          const args = (a.args ?? {}) as Record<string, any>;
          const m = a.method;
          if ((m === 'ft_transfer' || m === 'ft_transfer_call') && isNearAccount(args.receiver_id)) {
            const token = await ft(tx.receiver);
            const amount = formatAmount(big(args.amount), token);
            if (m === 'ft_transfer') items.push({ rank: 50, facts: { kind: 'transfer', token, amount, recipient: args.receiver_id, contract: tx.receiver }, send: { to: args.receiver_id, token, amount } });
            // ft_transfer_call hands the tokens to an app contract with instructions: a swap, a deposit, a bridge.
            else items.push({ rank: 35, facts: { kind: 'ledger_action', ledgerAction: 'app_deposit', token, amount, recipient: args.receiver_id, appName: args.receiver_id, contract: tx.receiver }, send: { to: args.receiver_id, token, amount } });
          } else if (m === 'nft_transfer' && isNearAccount(args.receiver_id)) {
            const token = { address: tx.receiver, symbol: 'NFT', isNft: true };
            const amount = { raw: '1', display: '1', unlimited: false };
            items.push({ rank: 50, facts: { kind: 'transfer', token, amount, recipient: args.receiver_id, tokenId: String(args.token_id ?? ''), contract: tx.receiver }, send: { to: args.receiver_id, token, amount } });
          } else if (m === 'nft_approve' && isNearAccount(args.account_id)) {
            items.push({ rank: 70, facts: { kind: 'nft_approve', token: { address: tx.receiver, symbol: tx.receiver }, spender: args.account_id, tokenId: String(args.token_id ?? ''), contract: tx.receiver } });
          } else if (m === 'near_deposit' && tx.receiver === 'wrap.near') {
            const w = await ft('wrap.near');
            items.push({ rank: 20, facts: { kind: 'ledger_action', ledgerAction: 'swap', token: NEAR_TOKEN, amount: formatAmount(a.deposit, NEAR_TOKEN), buyToken: w, buyAmount: formatAmount(a.deposit, w) } });
          } else if (m === 'storage_deposit' || m === 'storage_withdraw' || m === 'near_withdraw' && tx.receiver === 'wrap.near') {
            items.push({ rank: 4, facts: { kind: 'ledger_action', ledgerAction: 'setup' } });
          } else {
            items.push({ rank: a.deposit > 1n ? 30 : 25, facts: { kind: 'unknown_call', contract: tx.receiver, appName: `${tx.receiver} ${m}`, selector: m, ...(a.deposit > 1n ? { nativeValue: formatAmount(a.deposit, NEAR_TOKEN) } : {}) } });
          }
          break;
        }
        default:
          items.push({ rank: 26, facts: { kind: 'unknown_call', selector: a.name } });
      }
    }
  }
  if (!items.length) return base;
  const lead = [...items].sort((x, y) => y.rank - x.rank)[0];
  const out: Facts = { ...base, ...lead.facts } as Facts;
  const sends = items.filter((i) => i.send);
  const meaningful = items.filter((i) => i.rank > 5);
  if (meaningful.length > 1) {
    out.via = 'batch';
    out.bundle = meaningful.map((i) => ({ kind: String(i.facts.kind === 'ledger_action' ? i.facts.ledgerAction : i.facts.kind), token: i.send?.token ?? i.facts.token, spender: i.send?.to ?? i.facts.spender ?? i.facts.recipient, amount: i.send?.amount ?? i.facts.amount }));
  }
  // Several different coins to one account in one go: how NEAR drainers empty a wallet with one approval.
  const byTo = new Map<string, Set<string>>();
  for (const s of sends) if (s.send!.to !== me) byTo.set(s.send!.to, (byTo.get(s.send!.to) ?? new Set()).add(s.send!.token.symbol ?? s.send!.token.address));
  for (const [to, set] of byTo) if (set.size >= 2) out.sweep = { recipient: to, assets: [...set] };
  return out;
}

async function rpc(method: string, params: unknown): Promise<any> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error?.cause?.name ?? j.error?.message ?? 'NEAR RPC error');
  return j.result;
}
const ftCache = new Map<string, { symbol?: string; decimals?: number } | undefined>();
export const nearLookup: NearLookup = {
  ft: async (contract) => {
    if (!isNearAccount(contract)) return undefined;
    if (ftCache.has(contract)) return ftCache.get(contract);
    const r = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: contract, method_name: 'ft_metadata', args_base64: 'e30=' }).catch(() => undefined);
    let v: { symbol?: string; decimals?: number } | undefined;
    try { const m = JSON.parse(Buffer.from(r.result).toString('utf8')); v = { symbol: String(m.symbol).slice(0, 20), decimals: Number(m.decimals) }; } catch { v = undefined; }
    if (ftCache.size > 2000) ftCache.clear();
    ftCache.set(contract, v);
    return v;
  },
  // The RPC needs the sender to find a transaction, and a hash alone does not say who sent it. NearBlocks does.
  tx: async (hash) => {
    const r = await fetch(`${NEARBLOCKS}/txns/${encodeURIComponent(hash)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return undefined;
    const signer = (await r.json())?.txns?.[0]?.signer_account_id;
    if (!isNearAccount(signer)) return undefined;
    const res = await rpc('tx', { tx_hash: hash, sender_account_id: signer, wait_until: 'NONE' });
    return res?.transaction ? readTxJson(res.transaction) : undefined;
  },
};

export async function fetchNearTx(hash: string, lookup: NearLookup = nearLookup): Promise<Facts> {
  const txs = await lookup.tx?.(hash);
  if (!txs?.length) throw new Error('not found');
  return nearFacts(txs, lookup);
}
