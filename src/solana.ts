import type { Facts } from './facts.js';
import { formatAmount, type Amount } from './format.js';

/**
 * Solana. Not an EVM chain, so it gets its own reader. 501 is Solana's SLIP-44 coin type; we use it as its id
 * here because no EVM chain we list uses it.
 */
export const SOLANA_ID = 501;
export const SYSTEM = '11111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
// Programs that only set things up (fees, memos, creating your own token account). They never move or hand over money.
const SETUP = new Set(['ComputeBudget111111111111111111111111111111', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EQVDDwQDxFMNo', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL']);
const U64_MAX = (1n << 64n) - 1n;
const RPCS = (process.env.SOLANA_RPC ?? 'https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com').split(',').map((s) => s.trim()).filter(Boolean);

// Mint addresses of the coins Nigerians mostly hold on Solana. Decimals were read from each mint with getTokenSupply on 2026-10-06.
const KNOWN_MINTS: Record<string, { symbol: string; decimals: number }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
  So11111111111111111111111111111111111111112: { symbol: 'wrapped SOL', decimals: 9 },
};

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(buf: Uint8Array): string {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; out = '1' + out; }
  return out;
}
export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) { const i = ALPHABET.indexOf(ch); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  const lead = s.match(/^1*/)![0].length;
  return Uint8Array.from([...new Array(lead).fill(0), ...bytes]);
}
export const isSolSignature = (s: unknown): boolean => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s);
export const isSolAddress = (s: unknown): boolean => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

class Reader {
  o = 0;
  constructor(readonly b: Uint8Array) {}
  need(n: number) { if (this.o + n > this.b.length) throw new Error('short'); }
  u8() { this.need(1); return this.b[this.o++]; }
  u16() { this.need(2); const v = this.b[this.o] | (this.b[this.o + 1] << 8); this.o += 2; return v; }
  u32() { this.need(4); const v = new DataView(this.b.buffer, this.b.byteOffset + this.o, 4).getUint32(0, true); this.o += 4; return v; }
  bytes(n: number) { this.need(n); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  key() { return b58encode(this.bytes(32)); }
  compact() { let v = 0; for (let s = 0; s < 21; s += 7) { const x = this.u8(); v |= (x & 0x7f) << s; if (!(x & 0x80)) return v; } throw new Error('bad compact-u16'); }
  get done() { return this.o === this.b.length; }
}
const u64 = (d: Uint8Array, at: number) => { if (d.length < at + 8) throw new Error('short'); let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i]); return v; };

interface RawIx { pid: number; accs: number[]; data: Uint8Array }
export interface SolMessage {
  version: 'legacy' | 0 | 1;
  staticKeys: string[];
  numSigners: number;
  ixs: RawIx[];
  lookups: Array<{ table: string; writable: number[]; readonly: number[] }>;
}

function readLegacyOrV0(r: Reader): SolMessage {
  let version: 'legacy' | 0 = 'legacy';
  if (r.b[r.o] & 0x80) { if ((r.b[r.o] & 0x7f) !== 0) throw new Error('unknown version'); version = 0; r.o++; }
  const numSigners = r.u8(); r.u8(); r.u8();
  const staticKeys = Array.from({ length: r.compact() }, () => r.key());
  r.bytes(32);
  const ixs = Array.from({ length: r.compact() }, () => {
    const pid = r.u8();
    const accs = Array.from({ length: r.compact() }, () => r.u8());
    return { pid, accs, data: r.bytes(r.compact()) };
  });
  const lookups = version === 0
    ? Array.from({ length: r.compact() }, () => ({ table: r.key(), writable: Array.from({ length: r.compact() }, () => r.u8()), readonly: Array.from({ length: r.compact() }, () => r.u8()) }))
    : [];
  return { version, staticKeys, numSigners, ixs, lookups };
}

// SIMD-0385 transaction v1 (live on mainnet since 15 Sep 2026): 0x81, header, config mask, blockhash, counts,
// inline addresses, config values, instruction headers, payloads, then the signatures at the end.
function readV1(r: Reader): SolMessage {
  if (r.u8() !== 0x81) throw new Error('not v1');
  const numSigners = r.u8(); r.u8(); r.u8();
  let mask = r.u32();
  r.bytes(32);
  const nIx = r.u8();
  const nAddr = r.u8();
  const staticKeys = Array.from({ length: nAddr }, () => r.key());
  let bits = 0; while (mask) { bits += mask & 1; mask >>>= 1; }
  r.bytes(bits * 4);
  const heads = Array.from({ length: nIx }, () => ({ pid: r.u8(), na: r.u8(), nd: r.u16() }));
  const ixs = heads.map((h) => ({ pid: h.pid, accs: Array.from(r.bytes(h.na)), data: r.bytes(h.nd) }));
  const rest = r.b.length - r.o;
  if (rest !== 0 && rest !== numSigners * 64) throw new Error('bad v1 length');
  r.o = r.b.length;
  return { version: 1, staticKeys, numSigners, ixs, lookups: [] };
}

/** Read a Solana transaction (signed or not) or just its message, in any of the three formats. */
export function parseSolanaBytes(bytes: Uint8Array): SolMessage {
  const attempts: Array<() => SolMessage> = [
    () => { const r = new Reader(bytes); const m = readV1(r); return m; },
    () => { const r = new Reader(bytes); const n = r.compact(); r.bytes(n * 64); const m = readLegacyOrV0(r); if (!r.done || n !== m.numSigners) throw new Error('trailing'); return m; },
    () => { const r = new Reader(bytes); const m = readLegacyOrV0(r); if (!r.done) throw new Error('trailing'); return m; },
  ];
  for (const a of attempts) { try { return a(); } catch { /* next */ } }
  throw new Error('That does not look like a Solana transaction.');
}

/** base64 (what dApps hand wallets) or base58 (what some explorers show). */
export function solanaBytesFromText(s: string): Uint8Array {
  const t = s.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(t)) { try { return b58decode(t); } catch { /* try base64 */ } }
  if (/^[A-Za-z0-9+/=\s]+$/.test(t)) return Uint8Array.from(Buffer.from(t.replace(/\s+/g, ''), 'base64'));
  throw new Error('not base64 or base58');
}
export const looksLikeSolanaTx = (s: unknown): boolean => {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 100 || t.startsWith('0x') || t.startsWith('{')) return false;
  try { parseSolanaBytes(solanaBytesFromText(t)); return true; } catch { return false; }
};

export type Rpc = (method: string, params: unknown[]) => Promise<any>;
export const solanaRpc: Rpc = async (method, params) => {
  let last: unknown;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12_000) });
      const j = (await r.json()) as { result?: unknown; error?: unknown };
      if (j.error) { last = j.error; continue; }
      return j.result;
    } catch (e) { last = e; }
  }
  throw new Error(`Solana RPC failed: ${JSON.stringify(last)}`);
};

interface TokenAcct { mint?: string; owner?: string; decimals?: number }
interface Meta {
  loadedAddresses?: { writable?: string[]; readonly?: string[] };
  innerInstructions?: Array<{ index: number; instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }> }>;
  preTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string; uiTokenAmount?: { decimals: number } }>;
  postTokenBalances?: Meta['preTokenBalances'];
}

interface Ix { program: string; accounts: string[]; data: Uint8Array; inner: boolean }

async function resolve(m: SolMessage, meta: Meta | undefined, rpc?: Rpc) {
  let loaded: string[] = [];
  if (meta?.loadedAddresses) loaded = [...(meta.loadedAddresses.writable ?? []), ...(meta.loadedAddresses.readonly ?? [])];
  else if (m.lookups.length) {
    const tables = await Promise.all(m.lookups.map((l) => (rpc ? rpc('getAccountInfo', [l.table, { encoding: 'jsonParsed' }]).then((x) => (x?.value?.data?.parsed?.info?.addresses ?? []) as string[]).catch(() => [] as string[]) : Promise.resolve([] as string[]))));
    const w = m.lookups.flatMap((l, i) => l.writable.map((j) => tables[i][j] ?? '?'));
    const ro = m.lookups.flatMap((l, i) => l.readonly.map((j) => tables[i][j] ?? '?'));
    loaded = [...w, ...ro];
  }
  const keys = [...m.staticKeys, ...loaded];
  const k = (i: number) => keys[i] ?? '?';
  const ixs: Ix[] = [];
  m.ixs.forEach((x, i) => {
    ixs.push({ program: k(x.pid), accounts: x.accs.map(k), data: x.data, inner: false });
    for (const g of meta?.innerInstructions ?? []) if (g.index === i) for (const y of g.instructions) ixs.push({ program: k(y.programIdIndex), accounts: y.accounts.map(k), data: b58decode(y.data), inner: true });
  });
  const balances = new Map<string, TokenAcct>();
  for (const b of [...(meta?.preTokenBalances ?? []), ...(meta?.postTokenBalances ?? [])]) balances.set(k(b.accountIndex), { mint: b.mint, owner: b.owner, decimals: b.uiTokenAmount?.decimals });
  return { keys, ixs, signers: new Set(m.staticKeys.slice(0, m.numSigners)), feePayer: m.staticKeys[0], balances };
}

type Pending = { rank: number; build: () => Promise<Facts> };

/** What a Solana transaction does to the signer, reduced to the one action that matters most. */
export async function solanaFacts(m: SolMessage, meta?: Meta, rpc?: Rpc): Promise<Facts> {
  const { ixs, signers, feePayer, balances } = await resolve(m, meta, rpc);
  const base = { chainId: SOLANA_ID, chain: 'Solana', from: feePayer };
  const tokenAcct = async (a: string): Promise<TokenAcct> => {
    if (balances.has(a)) return balances.get(a)!;
    if (!rpc) return {};
    const info = await rpc('getAccountInfo', [a, { encoding: 'jsonParsed' }]).then((x) => x?.value?.data?.parsed?.info).catch(() => undefined);
    return info ? { mint: info.mint, owner: info.owner, decimals: info.tokenAmount?.decimals } : {};
  };
  const token = async (mint: string | undefined, decimals?: number) => {
    if (!mint) return { address: 'unknown', decimals };
    const known = KNOWN_MINTS[mint];
    let totalSupply: string | undefined;
    if (rpc) {
      const s = await rpc('getTokenSupply', [mint]).then((x) => x?.value).catch(() => undefined);
      if (s) { totalSupply = s.amount; decimals ??= s.decimals; }
    }
    return { address: mint, symbol: known?.symbol, decimals: decimals ?? known?.decimals, ...(totalSupply ? { totalSupply } : {}) };
  };
  const amountOf = (raw: bigint, t: { decimals?: number; totalSupply?: string }): Amount =>
    raw >= U64_MAX ? { raw: raw.toString(), display: 'unlimited', unlimited: true } : formatAmount(raw, t);

  // Accounts this same transaction creates are new, not yours being handed over.
  const created = new Set<string>();
  for (const x of ixs) if (x.program === SYSTEM && x.data.length >= 4) {
    const tag = x.data[0] | (x.data[1] << 8);
    if (tag === 0 || tag === 3) created.add(x.accounts[1]);
    if (tag === 8 || tag === 9) created.add(x.accounts[0]);
  }

  const found: Pending[] = [];
  const unknownPrograms: string[] = [];
  for (const x of ixs) {
    const d = x.data;
    if (x.program === SYSTEM && d.length >= 4) {
      const tag = new DataView(d.buffer, d.byteOffset, 4).getUint32(0, true);
      if (tag === 1 && d.length >= 36) {
        // Assign: the account's Owner field moves to another program. On your main wallet that is the
        // Solana owner-change scam (SlowMist, Dec 2025: one victim lost over $3 million this way).
        const acct = x.accounts[0];
        const newOwner = b58encode(d.subarray(4, 36));
        if (newOwner !== SYSTEM && signers.has(acct) && !created.has(acct)) {
          found.push({ rank: 100, build: async () => ({ ...base, kind: 'sol_authority', authority: 'wallet_owner', owner: acct, spender: newOwner, contract: SYSTEM }) });
        }
      } else if (tag === 2 && d.length >= 12 && !x.inner) {
        const lamports = u64(d, 4);
        found.push({ rank: 20, build: async () => ({ ...base, kind: 'native_send', from: x.accounts[0], recipient: x.accounts[1], token: { address: 'native', symbol: 'SOL', decimals: 9 }, amount: formatAmount(lamports, { decimals: 9 }) }) });
      }
      continue;
    }
    if (x.program === TOKEN || x.program === TOKEN22) {
      const tag = d[0];
      if ((tag === 4 || tag === 13) && d.length >= 9) {
        const checked = tag === 13;
        const [src, a1, a2, a3] = x.accounts;
        const delegate = checked ? a2 : a1;
        const owner = checked ? a3 : a2;
        if (!signers.has(owner)) continue;
        const raw = u64(d, 1);
        found.push({ rank: raw >= U64_MAX ? 80 : 60, build: async () => {
          const acct = await tokenAcct(src);
          const t = await token(checked ? a1 : acct.mint, checked ? d[9] : acct.decimals);
          return { ...base, kind: 'erc20_approve', contract: x.program, token: t, spender: delegate, owner, from: owner, amount: amountOf(raw, t) };
        } });
      } else if (tag === 5) {
        const [src, owner] = x.accounts;
        if (!signers.has(owner)) continue;
        found.push({ rank: 5, build: async () => {
          const acct = await tokenAcct(src);
          return { ...base, kind: 'erc20_approve', contract: x.program, token: await token(acct.mint, acct.decimals), owner, from: owner, amount: formatAmount(0n) };
        } });
      } else if (tag === 6 && d.length >= 3) {
        const [acct, current] = x.accounts;
        if (!signers.has(current)) continue; // a program changing its own account, not you
        const type = d[1];
        const next = d[2] === 1 && d.length >= 35 ? b58encode(d.subarray(3, 35)) : undefined;
        const authority = !next ? 'remove' : type === 2 ? 'token_owner' : type === 3 ? 'close' : type === 0 ? 'mint' : type === 1 ? 'freeze' : 'other';
        // Handing it to another key you are also signing with (your own wallet, or a temporary account) is not a handover.
        if (next === current || (next && signers.has(next)) || created.has(acct)) continue;
        const rank = authority === 'token_owner' ? 90 : authority === 'close' ? 40 : 10;
        found.push({ rank, build: async () => {
          const info = authority === 'token_owner' || authority === 'close' ? await tokenAcct(acct) : { mint: acct };
          return { ...base, kind: 'sol_authority', authority, owner: current, spender: next, contract: x.program, token: await token(info.mint, (info as TokenAcct).decimals) };
        } });
      } else if ((tag === 3 || tag === 12) && d.length >= 9 && !x.inner) {
        const checked = tag === 12;
        const [src, a1, a2, a3] = x.accounts;
        const dst = checked ? a2 : a1;
        const auth = checked ? a3 : a2;
        const raw = u64(d, 1);
        found.push({ rank: 20, build: async () => {
          const s = await tokenAcct(src);
          const t = await token(checked ? a1 : s.mint, checked ? d[9] : s.decimals);
          const to = await tokenAcct(dst);
          return { ...base, kind: 'transfer', contract: x.program, from: auth, token: t, recipient: to.owner ?? dst, amount: formatAmount(raw, t) };
        } });
      }
      continue;
    }
    if (!x.inner && !SETUP.has(x.program)) unknownPrograms.push(x.program);
  }
  found.sort((a, b) => b.rank - a.rank);
  // An app program we cannot read, plus only a small transfer (a fee or tip): say plainly we cannot read the app part,
  // instead of describing the tip as if it were the whole transaction.
  if (unknownPrograms.length && (!found.length || found[0].rank < 40)) {
    const sent = found.find((x) => x.rank === 20);
    const f = sent ? await sent.build() : undefined;
    return { ...base, kind: 'unknown_call', contract: unknownPrograms[0], selector: `program ${unknownPrograms[0]}`, ...(f?.kind === 'native_send' ? { nativeValue: f.amount } : {}) };
  }
  if (found.length) return found[0].build();
  return { ...base, kind: 'sol_authority', authority: 'setup' };
}

/** A transaction the user pasted (base64 or base58), before signing. */
export async function explainSolanaText(text: string, rpc: Rpc | undefined = solanaRpc): Promise<Facts> {
  return solanaFacts(parseSolanaBytes(solanaBytesFromText(text)), undefined, rpc);
}

/** A transaction already on chain, by its signature. */
export async function fetchSolanaTx(signature: string, rpc: Rpc = solanaRpc): Promise<Facts> {
  const t = await rpc('getTransaction', [signature, { encoding: 'base64', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  if (!t?.transaction?.[0]) throw new Error('not found');
  return solanaFacts(parseSolanaBytes(Uint8Array.from(Buffer.from(t.transaction[0], 'base64'))), t.meta, rpc);
}
