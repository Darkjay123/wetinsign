import { Address, Cell } from '@ton/core';
import type { Facts } from './facts.js';
import { formatAmount, type Amount } from './format.js';
import type { TokenRef } from './tokens.js';
import { STONFI_PTON_WALLETS, STONFI_ROUTERS } from './ton-trusted.js';

/**
 * TON. Not EVM: wallets sign "messages" (TON Connect sendTransaction), each sending TON and optionally a payload.
 * 607 is TON's SLIP-44 coin type; no EVM chain we list uses it.
 */
export const TON_ID = 607;
const OP_COMMENT = 0;
const OP_JETTON_TRANSFER = 0x0f8a7ea5;
const OP_NFT_TRANSFER = 0x5fcc3d14;
const OP_JETTON_BURN = 0x595f07bc;
// STON.fi v2 pTON ton_transfer: how a swap or deposit from TON starts. Layout read off a real swap on 6 Oct 2026.
const OP_PTON_TRANSFER = 0x01f3835d;
const TONCENTER = process.env.TONCENTER_API ?? 'https://toncenter.com/api/v3';
const TONAPI = process.env.TONAPI ?? 'https://tonapi.io/v2';

// Tether USD on TON. Master and decimals read from toncenter and tonapi (verification "whitelist") on 2026-10-06.
const KNOWN_MASTERS: Record<string, { symbol: string; decimals: number }> = {
  '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe': { symbol: 'USDT', decimals: 6 },
};

export interface TonMessage { address: string; amount: string | number; payload?: string; stateInit?: string }
export interface TonRequest { messages: TonMessage[]; from?: string; valid_until?: number }

export interface TonLookup {
  /** Jetton wallet → which jetton (master) and whose wallet it is. */
  jettonWallet?: (raw: string) => Promise<{ master: string; owner?: string } | undefined>;
  jetton?: (master: string) => Promise<{ symbol?: string; decimals?: number } | undefined>;
  /** Tonkeeper's scam label (tonapi is_scam). */
  isScam?: (raw: string) => Promise<boolean | undefined>;
  /** A transaction (any hash in its trace) → the messages the wallet sent. */
  tx?: (hash: string) => Promise<TonRequest | undefined>;
}

const raw = (a: Address) => `${a.workChain}:${a.hash.toString('hex')}`;
const friendly = (a: Address) => a.toString({ urlSafe: true, bounceable: true });
export const parseTonAddress = (s: string): Address | undefined => { try { return Address.parse(s.trim()); } catch { return undefined; } };
// Shape only: a request with a mistyped address is still a TON request, and should get a TON error, not a Tron one.
export const isTonRequest = (v: unknown): v is TonRequest =>
  !!v && typeof v === 'object' && Array.isArray((v as TonRequest).messages) && (v as TonRequest).messages.length > 0 &&
  (v as TonRequest).messages.every((m) => typeof m?.address === 'string' && m.amount !== undefined);
export const badTonAddress = (r: TonRequest): string | undefined => r.messages.map((m) => m.address).find((a) => !parseTonAddress(a));

interface Move {
  to: Address;
  ton: bigint;
  kind: 'ton' | 'jetton' | 'nft' | 'burn' | 'pton' | 'unknown';
  recipient?: Address;
  jettonAmount?: bigint;
  comment?: string;
  op?: number;
}

function readPayload(m: TonMessage): Move {
  const to = Address.parse(m.address);
  const ton = BigInt(String(m.amount));
  if (!m.payload) return { to, ton, kind: 'ton' };
  let cell: Cell;
  try { cell = Cell.fromBase64(m.payload); } catch { try { cell = Cell.fromBoc(Buffer.from(m.payload, 'hex'))[0]; } catch { return { to, ton, kind: 'unknown' }; } }
  const s = cell.beginParse();
  if (s.remainingBits < 32) return { to, ton, kind: 'ton' };
  const op = s.loadUint(32);
  try {
    if (op === OP_COMMENT) return { to, ton, kind: 'ton', comment: s.loadStringTail().slice(0, 120) };
    if (op === OP_JETTON_TRANSFER) {
      s.loadUintBig(64);
      const jettonAmount = s.loadCoins();
      const recipient = s.loadAddress();
      // Forward payload often carries a text note (e.g. a Fragment Stars purchase reference).
      let comment: string | undefined;
      try {
        s.loadMaybeAddress(); s.loadMaybeRef(); s.loadCoins();
        const fp = s.loadBit() ? s.loadRef().beginParse() : s;
        if (fp.remainingBits >= 32 && fp.loadUint(32) === 0) comment = fp.loadStringTail().slice(0, 120);
      } catch { /* note is optional */ }
      return { to, ton, kind: 'jetton', jettonAmount, recipient, comment, op };
    }
    if (op === OP_PTON_TRANSFER) {
      const router = STONFI_PTON_WALLETS[raw(to)];
      if (router) { s.loadUintBig(64); return { to, ton, kind: 'pton', jettonAmount: s.loadCoins(), recipient: Address.parse(router), op }; }
    }
    if (op === OP_NFT_TRANSFER) { s.loadUintBig(64); return { to, ton, kind: 'nft', recipient: s.loadAddress(), op }; }
    if (op === OP_JETTON_BURN) { s.loadUintBig(64); return { to, ton, kind: 'burn', jettonAmount: s.loadCoins(), op }; }
  } catch { /* fall through */ }
  return { to, ton, kind: 'unknown', op };
}

const TON_TOKEN: TokenRef = { address: 'native', symbol: 'TON', decimals: 9 };

/** What a TON Connect request (or a sent transaction) does, reduced to what matters to the person signing. */
export async function tonFacts(req: TonRequest, look: TonLookup = {}): Promise<Facts> {
  const from = req.from ? parseTonAddress(req.from) : undefined;
  const base = { chainId: TON_ID, chain: 'TON', ...(from ? { from: friendly(from) } : {}) };
  const moves = req.messages.map(readPayload);

  const tokenOf = async (jw: Address): Promise<TokenRef> => {
    const w = await look.jettonWallet?.(raw(jw)).catch(() => undefined);
    const master = w?.master?.toLowerCase();
    const known = master ? KNOWN_MASTERS[master] : undefined;
    const meta = !known && master ? await look.jetton?.(master).catch(() => undefined) : undefined;
    return { address: master ? friendly(Address.parse(master)) : friendly(jw), symbol: known?.symbol ?? meta?.symbol, decimals: known?.decimals ?? meta?.decimals };
  };

  type Item = { kind: string; token: TokenRef; amount: Amount; recipient: Address; comment?: string };
  const stonfi = (a: Address) => !!STONFI_ROUTERS[raw(a)];
  const items: Item[] = [];
  let unreadable: Move | undefined;
  for (const m of moves) {
    if (m.kind === 'jetton' && m.recipient) {
      const token = await tokenOf(m.to);
      items.push({ kind: 'transfer', token, amount: formatAmount(m.jettonAmount ?? 0n, token), recipient: m.recipient, comment: m.comment });
    } else if (m.kind === 'nft' && m.recipient) {
      items.push({ kind: 'transfer', token: { address: friendly(m.to), symbol: 'NFT', isNft: true }, amount: { raw: '1', display: '1', unlimited: false }, recipient: m.recipient });
    } else if (m.kind === 'pton' && m.recipient) {
      items.push({ kind: 'native_send', token: TON_TOKEN, amount: formatAmount(m.jettonAmount ?? 0n, TON_TOKEN), recipient: m.recipient });
    } else if (m.kind === 'ton') {
      items.push({ kind: 'native_send', token: TON_TOKEN, amount: formatAmount(m.ton, TON_TOKEN), recipient: m.to, comment: m.comment });
    } else if (m.kind === 'unknown') unreadable ??= m;
  }

  const recipients = [...new Set(items.map((i) => raw(i.recipient)))];
  const scam = look.isScam ? (await Promise.all([...recipients, ...moves.map((m) => raw(m.to))].map((r) => look.isScam!(r).catch(() => undefined)))).some(Boolean) : false;

  // Several different assets going to one address in one request: how TON drainers empty a wallet in one signature.
  const byRecipient = new Map<string, Set<string>>();
  for (const i of items) {
    const r = raw(i.recipient);
    if ((from && r === raw(from)) || stonfi(i.recipient)) continue;
    if (!byRecipient.has(r)) byRecipient.set(r, new Set());
    byRecipient.get(r)!.add(i.token.address);
  }
  const sweepTo = [...byRecipient.entries()].find(([, s]) => s.size >= 2)?.[0];

  if (!items.length) {
    const u = unreadable ?? moves[0];
    return { ...base, kind: 'unknown_call', contract: friendly(u.to), selector: u.op !== undefined ? `op 0x${u.op.toString(16)}` : undefined, nativeValue: formatAmount(u.ton, TON_TOKEN), ...(scam ? { reportedScam: true } : {}) };
  }
  // Lead with the jetton (or NFT) if there is one: the TON attached to those messages is mostly fees.
  const main = items.find((i) => i.kind === 'transfer') ?? items[0];
  const extra = {
    ...(items.length > 1 || unreadable ? { via: 'batch' as const, bundle: items.map((i) => ({ kind: i.kind, token: i.token, amount: i.amount, spender: friendly(i.recipient) })) } : {}),
    ...(sweepTo ? { sweep: { recipient: friendly(Address.parse(sweepTo)), assets: items.filter((i) => raw(i.recipient) === sweepTo).map((i) => i.token.symbol ?? 'tokens') } } : {}),
    ...(scam ? { reportedScam: true } : {}),
    ...(main.comment ? { memo: main.comment } : {}),
    ...(stonfi(main.recipient) ? { protocol: 'STON.fi' } : {}),
    ...(unreadable ? { selector: unreadable.op !== undefined ? `op 0x${unreadable.op.toString(16)}` : 'unreadable message' } : {}),
  };
  return { ...base, kind: main.kind as 'transfer' | 'native_send', token: main.token, amount: main.amount, recipient: friendly(main.recipient), ...extra };
}

// toncenter and tonapi allow about one request a second without a key. Seen live: a second lookup straight after the
// first got rate-limited and the USDT name went missing. Wait and retry on 429, and remember answers that never change.
const cache = new Map<string, unknown>();
async function getJson(url: string): Promise<any> {
  if (cache.has(url)) return cache.get(url);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: process.env.TONCENTER_API_KEY && url.startsWith(TONCENTER) ? { 'X-API-Key': process.env.TONCENTER_API_KEY } : {}, signal: AbortSignal.timeout(12_000) });
    if (r.status === 429 && attempt < 4) { await new Promise((res) => setTimeout(res, 1200 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error(`${r.status}`);
    const j = await r.json();
    if (/\/jetton\/wallets|\/jettons\//.test(url)) { if (cache.size > 2000) cache.clear(); cache.set(url, j); }
    return j;
  }
}

export const tonLookup: TonLookup = {
  jettonWallet: async (a) => {
    const j = await getJson(`${TONCENTER}/jetton/wallets?address=${encodeURIComponent(a)}&limit=1`);
    const w = j?.jetton_wallets?.[0];
    return w ? { master: String(w.jetton).toLowerCase(), owner: w.owner } : undefined;
  },
  jetton: async (master) => {
    const j = await getJson(`${TONAPI}/jettons/${encodeURIComponent(master)}`);
    const m = j?.metadata;
    return m ? { symbol: m.symbol, decimals: m.decimals !== undefined ? Number(m.decimals) : undefined } : undefined;
  },
  isScam: async (a) => (await getJson(`${TONAPI}/accounts/${encodeURIComponent(a)}`))?.is_scam === true,
  tx: async (hash) => {
    const h = /^(0x)?[0-9a-fA-F]{64}$/.test(hash) ? Buffer.from(hash.replace(/^0x/, ''), 'hex').toString('base64') : hash;
    const j = await getJson(`${TONCENTER}/traces?tx_hash=${encodeURIComponent(h)}&include_actions=false`);
    const t = j?.traces?.[0];
    const root = t?.transactions?.[t?.trace?.tx_hash];
    if (!root?.out_msgs?.length) return undefined;
    return { from: root.account, messages: root.out_msgs.map((m: any) => ({ address: m.destination, amount: m.value, payload: m.message_content?.body })) };
  },
};

export async function fetchTonTx(hash: string, look: TonLookup = tonLookup): Promise<Facts> {
  const req = await look.tx?.(hash);
  if (!req) throw new Error('not found');
  return tonFacts(req, look);
}
