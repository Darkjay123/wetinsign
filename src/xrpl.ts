import { decode } from 'ripple-binary-codec';
import type { Facts } from './facts.js';
import type { Amount } from './format.js';

/**
 * XRP Ledger. Not EVM: wallets (Xaman, Crossmark, Ledger) sign a JSON transaction, or its binary blob in hex.
 * 144 is XRP's SLIP-44 coin type; no EVM chain we list uses it.
 */
export const XRPL_ID = 144;
const XRPL_RPC = process.env.XRPL_RPC ?? 'https://xrplcluster.com';
const CHAIN = 'XRP Ledger';
// Flag values from the XRPL docs (xrpl.org): tfSellNFToken, asfDisableMaster.
const TF_SELL_NFTOKEN = 1;
const ASF_DISABLE_MASTER = 4;

export type XrplTx = Record<string, any> & { TransactionType: string };
export interface XrplLookup {
  tx?: (hash: string) => Promise<XrplTx | undefined>;
  /** An NFT offer on the ledger, to show the price when you accept it. */
  offer?: (index: string) => Promise<{ Amount: unknown; Flags?: number; Owner?: string } | undefined>;
}

export const isXrplTx = (v: unknown): v is XrplTx => !!v && typeof v === 'object' && typeof (v as XrplTx).TransactionType === 'string' && typeof (v as XrplTx).Account === 'string';
export const isXrplAddress = (s: unknown) => typeof s === 'string' && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s);

/** Pasted text → XRPL transaction: JSON (with or without a tx_json/txjson wrapper) or the signed hex blob. */
export function parseXrplText(text: string): XrplTx | undefined {
  const t = text.trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      const c = [j, j?.tx_json, j?.txjson, j?.transaction, j?.result?.tx_json, j?.result].find(isXrplTx);
      return c;
    } catch { return undefined; }
  }
  if (/^[0-9A-Fa-f]{40,}$/.test(t) && t.length % 2 === 0) {
    try { const d = decode(t) as XrplTx; return isXrplTx(d) ? d : undefined; } catch { return undefined; }
  }
  return undefined;
}

const group = (s: string) => { const [i, f] = s.split('.'); return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? `.${f}` : ''); };
function plain(v: string): string {
  if (!/e/i.test(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) : v;
}
/** XRPL currency code: 3 letters, or 40 hex characters holding a longer name (RLUSD, SOLO...). */
export function currencyName(c: string): string {
  if (/^[0-9A-Fa-f]{40}$/.test(c)) {
    const s = Buffer.from(c, 'hex').toString('latin1').replace(/\0+$/, '');
    return /^[\x20-\x7e]+$/.test(s) ? s : c;
  }
  return c;
}
interface Money { symbol: string; issuer?: string; amount: Amount; zero: boolean }
export function readAmount(a: unknown): Money | undefined {
  if (typeof a === 'string' && /^\d+$/.test(a)) {
    const drops = BigInt(a);
    const whole = drops / 1_000_000n, frac = (drops % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return { symbol: 'XRP', amount: { raw: a, display: group(whole.toString() + (frac ? `.${frac}` : '')), unlimited: false }, zero: drops === 0n };
  }
  if (a && typeof a === 'object' && typeof (a as any).currency === 'string') {
    const v = plain(String((a as any).value ?? '0'));
    return { symbol: currencyName((a as any).currency), issuer: (a as any).issuer, amount: { raw: v, display: group(v.replace(/^-/, '')), unlimited: false }, zero: Number(v) === 0 };
  }
  // MPT (multi-purpose tokens): { mpt_issuance_id, value }
  if (a && typeof a === 'object' && typeof (a as any).mpt_issuance_id === 'string') {
    const v = String((a as any).value ?? '0');
    return { symbol: 'token', issuer: (a as any).mpt_issuance_id, amount: { raw: v, display: `${group(v)} raw units`, unlimited: false }, zero: v === '0' };
  }
  return undefined;
}
const tokenOf = (m: Money) => ({ address: m.issuer ?? 'XRP', symbol: m.symbol, ...(m.symbol === 'XRP' ? { decimals: 6 } : {}) });

function memoText(tx: XrplTx): string | undefined {
  const parts: string[] = [];
  for (const m of tx.Memos ?? []) {
    const d = m?.Memo?.MemoData;
    if (typeof d !== 'string') continue;
    const s = /^[0-9A-Fa-f]+$/.test(d) ? Buffer.from(d, 'hex').toString('utf8') : d;
    if (/^[\x20-\x7e\u00a0-\uffff\n]+$/.test(s)) parts.push(s.slice(0, 200));
  }
  return parts.length ? parts.join(' | ') : undefined;
}

function base(tx: XrplTx): Facts {
  return { kind: 'unknown_call', chainId: XRPL_ID, chain: CHAIN, from: tx.Account, appName: tx.TransactionType };
}

/** One XRPL transaction → facts. Never trusts memos; reads only the fields the ledger acts on. */
export async function xrplFacts(tx: XrplTx, lookup: XrplLookup = {}): Promise<Facts> {
  const f = base(tx);
  const memo = memoText(tx);
  if (memo) f.memo = memo;
  if (tx.DestinationTag !== undefined) f.destinationTag = String(tx.DestinationTag);
  const flags = Number(tx.Flags ?? 0);
  switch (tx.TransactionType) {
    case 'Payment': {
      const m = readAmount(tx.DeliverMax ?? tx.Amount);
      if (!m) return f;
      if (tx.Destination === tx.Account) {
        // Paying yourself through the DEX: a currency conversion.
        const src = readAmount(tx.SendMax);
        Object.assign(f, { kind: 'ledger_action', ledgerAction: 'swap', buyToken: tokenOf(m), buyAmount: m.amount });
        if (src) Object.assign(f, { token: tokenOf(src), amount: src.amount });
        return f;
      }
      return Object.assign(f, { kind: m.symbol === 'XRP' ? 'native_send' : 'transfer', recipient: tx.Destination, token: tokenOf(m), amount: m.amount, ...(m.issuer ? { contract: m.issuer } : {}) });
    }
    case 'SetRegularKey':
      return Object.assign(f, { kind: 'account_control', control: tx.RegularKey ? 'regular_key' : 'remove_key', spender: tx.RegularKey });
    case 'SignerListSet': {
      const entries = (tx.SignerEntries ?? []).map((e: any) => e?.SignerEntry ?? e).filter((e: any) => e?.Account);
      const quorum = Number(tx.SignerQuorum ?? 0);
      if (!quorum || !entries.length) return Object.assign(f, { kind: 'account_control', control: 'remove_key' });
      const others = entries.filter((e: any) => e.Account !== tx.Account);
      const otherWeight = others.reduce((s: number, e: any) => s + Number(e.SignerWeight ?? 0), 0);
      const yourWeight = entries.filter((e: any) => e.Account === tx.Account).reduce((s: number, e: any) => s + Number(e.SignerWeight ?? 0), 0);
      return Object.assign(f, {
        kind: 'account_control', control: 'signer_list',
        permission: [{ scope: 'owner', threshold: quorum, yourWeight, others: others.map((e: any) => e.Account), othersCanActAlone: otherWeight >= quorum }],
      });
    }
    case 'AccountDelete':
      return Object.assign(f, { kind: 'account_control', control: 'account_delete', recipient: tx.Destination });
    case 'AccountSet':
      if (Number(tx.SetFlag) === ASF_DISABLE_MASTER) return Object.assign(f, { kind: 'account_control', control: 'disable_master' });
      return Object.assign(f, { kind: 'ledger_action', ledgerAction: 'settings' });
    case 'TrustSet': {
      const m = readAmount(tx.LimitAmount);
      if (!m) return f;
      return Object.assign(f, { kind: 'ledger_action', ledgerAction: m.zero ? 'trustline_remove' : 'trustline', token: tokenOf(m), amount: m.amount, contract: m.issuer });
    }
    case 'OfferCreate': {
      const give = readAmount(tx.TakerGets), get = readAmount(tx.TakerPays);
      return Object.assign(f, { kind: 'ledger_action', ledgerAction: 'dex_order', ...(give ? { token: tokenOf(give), amount: give.amount } : {}), ...(get ? { buyToken: tokenOf(get), buyAmount: get.amount } : {}) });
    }
    case 'NFTokenCreateOffer': {
      const m = readAmount(tx.Amount);
      const sell = (flags & TF_SELL_NFTOKEN) !== 0;
      if (sell && (!m || m.zero)) return Object.assign(f, { kind: 'ledger_action', ledgerAction: 'nft_sell_free', tokenId: tx.NFTokenID, recipient: tx.Destination });
      return Object.assign(f, { kind: 'ledger_action', ledgerAction: sell ? 'nft_sell' : 'nft_buy', tokenId: tx.NFTokenID, recipient: tx.Destination, ...(m ? { price: m.amount, token: tokenOf(m) } : {}) });
    }
    case 'NFTokenAcceptOffer': {
      Object.assign(f, { kind: 'ledger_action', ledgerAction: 'nft_accept' });
      // Accepting a sell offer pays its price; accepting a buy offer sells your NFT. Read the offer:
      // from the transaction's own record once it ran (the offer is deleted then), else live from the ledger.
      const sellIdx = tx.NFTokenSellOffer, buyIdx = tx.NFTokenBuyOffer;
      const idx = typeof sellIdx === 'string' ? sellIdx : typeof buyIdx === 'string' ? buyIdx : undefined;
      if (idx) {
        const gone = (tx.__meta?.AffectedNodes ?? []).map((n: any) => n.DeletedNode).find((d: any) => d?.LedgerEntryType === 'NFTokenOffer' && d.LedgerIndex === idx)?.FinalFields;
        const o = gone ?? (lookup.offer ? await lookup.offer(idx).catch(() => undefined) : undefined);
        const m = o ? readAmount(o.Amount) : undefined;
        if (m) Object.assign(f, { price: m.amount, token: tokenOf(m), recipient: o?.Owner, side: idx === sellIdx ? 'buy' : 'sell' });
      }
      return f;
    }
    case 'CheckCreate': {
      const m = readAmount(tx.SendMax);
      return Object.assign(f, { kind: 'ledger_action', ledgerAction: 'check', spender: tx.Destination, ...(m ? { token: tokenOf(m), amount: m.amount } : {}) });
    }
    case 'EscrowCreate': {
      const m = readAmount(tx.Amount);
      return Object.assign(f, { kind: 'ledger_action', ledgerAction: 'escrow', recipient: tx.Destination, ...(m ? { token: tokenOf(m), amount: m.amount } : {}) });
    }
    case 'AMMDeposit': case 'AMMWithdraw': case 'AMMCreate': case 'AMMVote': case 'AMMBid':
      return Object.assign(f, { kind: 'ledger_action', ledgerAction: 'amm' });
    case 'OfferCancel': case 'NFTokenCancelOffer': case 'EscrowCancel': case 'CheckCancel':
      return Object.assign(f, { kind: 'ledger_action', ledgerAction: 'cancel' });
    case 'TicketCreate': case 'NFTokenMint': case 'CheckCash': case 'EscrowFinish': case 'DepositPreauth': case 'DIDSet': case 'OracleSet': case 'CredentialAccept': case 'MPTokenAuthorize':
      return Object.assign(f, { kind: 'ledger_action', ledgerAction: 'setup' });
    case 'Batch': {
      // XLS-56 Batch: several transactions signed as one. Read each; the worst one leads.
      const inner: Facts[] = [];
      for (const r of tx.RawTransactions ?? []) {
        const t = r?.RawTransaction ?? r;
        if (isXrplTx(t)) inner.push(await xrplFacts(t, lookup));
      }
      return combine(f, inner);
    }
    default:
      return f;
  }
}

const RANK: Record<string, number> = { account_control: 5, ledger_action: 2, transfer: 3, native_send: 3, unknown_call: 4 };
function combine(f: Facts, inner: Facts[]): Facts {
  if (!inner.length) return f;
  const lead = [...inner].sort((a, b) => (RANK[b.kind] ?? 0) - (RANK[a.kind] ?? 0) || (b.ledgerAction === 'nft_sell_free' ? 1 : 0) - (a.ledgerAction === 'nft_sell_free' ? 1 : 0))[0];
  const out: Facts = { ...lead, via: 'batch', bundle: inner.map((i) => ({ kind: i.kind, token: i.token, spender: i.spender ?? i.recipient, amount: i.amount })) };
  // Several different assets to one address that is not you: how drainers empty a wallet in one signature.
  const sends = inner.filter((i) => (i.kind === 'transfer' || i.kind === 'native_send') && i.recipient && i.recipient !== f.from);
  const byTo = new Map<string, Set<string>>();
  for (const s of sends) byTo.set(s.recipient!, (byTo.get(s.recipient!) ?? new Set()).add(s.token?.symbol ?? '?'));
  for (const [to, set] of byTo) if (set.size >= 2) out.sweep = { recipient: to, assets: [...set] };
  return out;
}

async function rpc(method: string, params: object, url = XRPL_RPC): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }), signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (j?.result?.error || j?.result?.status === 'error') throw new Error(j.result.error_message ?? j.result.error ?? 'XRPL error');
  return j.result;
}

export const xrplLookup: XrplLookup = {
  tx: async (hash) => {
    const r = await rpc('tx', { transaction: hash.replace(/^0x/i, '').toUpperCase(), binary: false });
    const tx = r.tx_json ? { ...r.tx_json } : { ...r };
    if (r.meta && typeof r.meta === 'object') tx.__meta = r.meta;
    return isXrplTx(tx) ? tx : undefined;
  },
  offer: async (index) => {
    const r = await rpc('ledger_entry', { index, ledger_index: 'validated' });
    return r.node;
  },
};

export async function fetchXrplTx(hash: string, lookup: XrplLookup = xrplLookup): Promise<Facts> {
  const tx = await lookup.tx?.(hash);
  if (!tx) throw new Error('not found');
  return xrplFacts(tx, lookup);
}
