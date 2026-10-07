import { Metadata, TypeRegistry } from '@polkadot/types';
import { blake2AsHex, blake2AsU8a, encodeAddress, xxhashAsHex } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';
import type { Facts } from './facts.js';
import { formatAmount } from './format.js';
import type { TokenRef } from './tokens.js';

/**
 * Polkadot. Since the November 2025 migration, balances and tokens live on Polkadot Asset Hub; staking and
 * governance calls can still reach the relay chain. Wallets (Polkadot.js, Talisman, SubWallet, Nova) sign a
 * payload whose `method` is SCALE call data, decoded here against the live runtime metadata.
 * The scam moves: proxy.addProxy with type Any (someone else can do anything with your account),
 * balances.transferAll, and a utility.batch that sweeps several tokens at once.
 * 354 is DOT's SLIP-44 coin type.
 */
export const DOT_ID = 354;
const CHAIN = 'Polkadot';
export const GENESIS = {
  relay: '0x91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3',
  ah: '0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f',
} as const;
type Net = keyof typeof GENESIS;
const RPC: Record<Net, string> = {
  relay: process.env.DOT_RELAY_RPC ?? 'https://rpc.polkadot.io',
  ah: process.env.DOT_AH_RPC ?? 'https://polkadot-asset-hub-rpc.polkadot.io',
};
const DOT: TokenRef = { address: 'native', symbol: 'DOT', decimals: 10 };
const MAX_U128 = 2n ** 128n - 1n;

export interface DotRequest { net?: Net; call: string; signer?: string }
export interface DotLookup {
  metadata?: (net: Net) => Promise<string>;
  asset?: (id: string) => Promise<{ symbol?: string; decimals?: number } | undefined>;
  /** Explorer index: extrinsic hash -> block hash + position. */
  scan?: (net: Net, hash: string) => Promise<{ indexer?: { blockHash?: string; extrinsicIndex?: number } } | undefined>;
  /** Raw signed extrinsics of a block. */
  block?: (net: Net, blockHash: string) => Promise<string[] | undefined>;
}
const SCAN: Record<Net, string> = {
  relay: process.env.DOT_RELAY_SCAN ?? 'https://polkadot-api.statescan.io',
  ah: process.env.DOT_AH_SCAN ?? 'https://ahp-api.statescan.io',
};
export const DOT_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** Polkadot.js signPayload ({ address, genesisHash, method }), { callData }, or a bare 0x call hex. */
export function parseDot(v: any, chainIsDot = false): DotRequest | undefined {
  const hex = (x: unknown) => (typeof x === 'string' && /^0x[0-9a-fA-F]{4,}$/.test(x.trim()) ? x.trim().toLowerCase() : undefined);
  if (typeof v === 'string') return chainIsDot && hex(v) ? { call: hex(v)! } : undefined;
  if (!v || typeof v !== 'object') return undefined;
  const call = hex(v.method) ?? hex(v.callData) ?? hex(v.call);
  if (!call) return undefined;
  const g = typeof v.genesisHash === 'string' ? v.genesisHash.toLowerCase() : undefined;
  const net = (Object.keys(GENESIS) as Net[]).find((k) => GENESIS[k] === g);
  if (!net && !chainIsDot && !(v.specVersion && v.address)) return undefined;
  return { call, ...(net ? { net } : {}), ...(typeof v.address === 'string' ? { signer: v.address } : {}) };
}

const regs = new Map<Net, TypeRegistry>();
async function registry(net: Net, lookup: DotLookup): Promise<TypeRegistry> {
  const hit = regs.get(net);
  if (hit) return hit;
  const reg = new TypeRegistry();
  reg.setMetadata(new Metadata(reg, (await lookup.metadata!(net)) as `0x${string}`));
  regs.set(net, reg);
  setTimeout(() => regs.delete(net), 6 * 3600_000).unref?.(); // runtimes upgrade; refresh every 6h
  return reg;
}
export function resetDotRegistries() { regs.clear(); }

const ss58 = (a: any): string | undefined => {
  try {
    const v = a?.isId ? a.asId : a?.isAddress32 ? a.asAddress32 : a;
    const u8 = v?.toU8a?.(true) ?? v?.toU8a?.();
    return u8?.length === 32 ? encodeAddress(u8, 0) : a?.toString?.();
  } catch { return undefined; }
};
async function assetToken(id: string, lookup: DotLookup): Promise<TokenRef> {
  const m = await lookup.asset?.(id).catch(() => undefined);
  return { address: `asset:${id}`, symbol: m?.symbol || `asset ${id}`, decimals: Number.isInteger(m?.decimals) ? m!.decimals! : 0 };
}
const big = (x: any) => { try { return BigInt(x.toString()); } catch { return 0n; } };

async function callFacts(c: any, base: Facts, lookup: DotLookup, depth = 0): Promise<Facts> {
  const s = c.section as string, m = c.method as string;
  const a = c.args as any[];
  const name = `${s}.${m}`;
  if (s === 'balances' && /^transfer(KeepAlive|AllowDeath)?$/.test(m)) return { ...base, kind: 'native_send', token: DOT, amount: formatAmount(big(a[1]), DOT), recipient: ss58(a[0]) };
  if (s === 'balances' && m === 'transferAll') return { ...base, kind: 'ledger_action', ledgerAction: 'close_out', token: DOT, amount: { raw: '0', display: 'all', unlimited: false }, recipient: ss58(a[0]), appName: 'balances.transferAll' };
  if ((s === 'assets' || s === 'foreignAssets') && /^transfer(KeepAlive|AllowDeath)?$/.test(m)) { const t = await assetToken(a[0].toString(), lookup); return { ...base, kind: 'transfer', token: t, amount: formatAmount(big(a[2]), t), recipient: ss58(a[1]), contract: t.address }; }
  if ((s === 'assets' || s === 'foreignAssets') && m === 'transferAll') { const t = await assetToken(a[0].toString(), lookup); return { ...base, kind: 'ledger_action', ledgerAction: 'close_out', token: t, amount: { raw: '0', display: 'all', unlimited: false }, recipient: ss58(a[1]), appName: name }; }
  if ((s === 'assets' || s === 'foreignAssets') && m === 'approveTransfer') {
    const t = await assetToken(a[0].toString(), lookup);
    const raw = big(a[2]);
    return { ...base, kind: 'erc20_approve', token: t, spender: ss58(a[1]), amount: raw >= MAX_U128 / 2n ? { raw: raw.toString(), display: 'unlimited', unlimited: true } : formatAmount(raw, t), contract: t.address, deadline: { never: true } as any };
  }
  if (s === 'proxy' && m === 'addProxy') {
    const type = a[1].toString();
    return { ...base, kind: 'account_control', control: type === 'Any' ? 'proxy' : 'proxy_limited', spender: ss58(a[0]), appName: `${type} proxy` };
  }
  if (s === 'proxy' && (m === 'proxy' || m === 'proxyAnnounced') && depth < 4) {
    const inner = await callFacts(a[a.length - 1], base, lookup, depth + 1);
    return { ...inner, via: inner.via ?? 'batch' };
  }
  if (s === 'proxy' && /^(removeProxy|removeProxies|killPure|rejectAnnouncement|removeAnnouncement)$/.test(m)) return { ...base, kind: 'ledger_action', ledgerAction: 'settings', appName: name };
  if (s === 'proxy' && m === 'createPure') return { ...base, kind: 'ledger_action', ledgerAction: 'setup', appName: name };
  if (s === 'utility' && /^(batch|batchAll|forceBatch)$/.test(m) && depth < 4) {
    const inner: Facts[] = [];
    for (const x of a[0] as any[]) inner.push(await callFacts(x, base, lookup, depth + 1));
    const control = inner.find((f) => f.kind === 'account_control');
    if (control) return { ...control, via: 'batch' };
    const approve = inner.find((f) => f.kind === 'erc20_approve');
    if (approve) return { ...approve, via: 'batch' };
    const moves = inner.filter((f) => f.kind === 'native_send' || f.kind === 'transfer' || (f.kind === 'ledger_action' && f.ledgerAction === 'close_out'));
    if (moves.length) {
      const bundle = moves.map((f) => ({ kind: 'transfer', token: f.token!, spender: f.recipient!, amount: f.amount! }));
      const to = moves[0].recipient!;
      const kinds = new Set(moves.map((f) => f.token?.address));
      const self = base.from && to === base.from;
      if (!self && moves.every((f) => f.recipient === to) && kinds.size >= 2) return { ...base, kind: 'transfer', token: moves[0].token, amount: moves[0].amount, recipient: to, via: 'batch', bundle, sweep: { recipient: to, assets: moves.map((f) => f.token?.symbol ?? '?') } };
      return { ...moves[0], kind: moves[0].kind === 'ledger_action' ? 'transfer' : moves[0].kind, via: 'batch', bundle };
    }
    return { ...(inner[0] ?? base), via: 'batch' };
  }
  if (/^(staking|nominationPools|convictionVoting|delegatedStaking|stakingAhClient)$/.test(s)) return { ...base, kind: 'ledger_action', ledgerAction: 'stake', appName: name };
  if (s === 'system' && /^remark/.test(m)) return { ...base, kind: 'ledger_action', ledgerAction: 'settings', appName: name, memo: Buffer.from(a[0].toU8a(true)).toString('utf8').replace(/[^\x20-\x7e]/g, '').slice(0, 200) };
  return { ...base, appName: name, selector: name };
}

export async function dotFacts(req: DotRequest, lookup: DotLookup = dotLookup): Promise<Facts> {
  const base: Facts = { kind: 'unknown_call', chainId: DOT_ID, chain: CHAIN, ...(req.signer ? { from: req.signer, owner: req.signer } : {}) };
  const nets: Net[] = req.net ? [req.net] : ['ah', 'relay'];
  for (const net of nets) {
    let c: any;
    try { c = (await registry(net, lookup)).createType('Call', req.call); } catch { continue; }
    if (c.toHex() !== req.call) continue; // trailing bytes: wrong runtime
    return callFacts(c, { ...base, chain: net === 'ah' ? 'Polkadot Asset Hub' : CHAIN }, lookup);
  }
  throw new Error('could not decode call');
}

/**
 * Polkadot extrinsic by hash. Statescan says which block and position it sits at (Asset Hub and relay are
 * asked together); the raw bytes then come from a public node, are checked against the hash, and go through
 * the same decoder as a pasted request. The explorer is only trusted for where to look, never for what it says.
 */
export async function fetchDotTx(hash: string, lookup: DotLookup = dotLookup): Promise<Facts> {
  const h = hash.toLowerCase();
  if (!DOT_HASH_RE.test(h)) throw new Error('bad hash');
  const hits = await Promise.all((['ah', 'relay'] as Net[]).map(async (net) => ({ net, s: await lookup.scan?.(net, h).catch(() => undefined) })));
  for (const { net, s } of hits) {
    const at = s?.indexer;
    if (!at?.blockHash || !Number.isInteger(at.extrinsicIndex)) continue;
    const xt = (await lookup.block?.(net, at.blockHash).catch(() => undefined))?.[at.extrinsicIndex!];
    if (!xt || blake2AsHex(xt) !== h) continue;
    const e: any = (await registry(net, lookup)).createType('Extrinsic', xt);
    return dotFacts({ net, call: e.method.toHex(), ...(e.isSigned ? { signer: e.signer.toString() } : {}) }, lookup);
  }
  throw new Error('not found');
}

const rpc = async (u: string, method: string, params: unknown[] = []) => {
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('rpc ' + r.status);
  return (await r.json()).result;
};
const assetCache = new Map<string, { symbol?: string; decimals?: number } | undefined>();
export const dotLookup: DotLookup = {
  metadata: (net) => rpc(RPC[net], 'state_getMetadata'),
  scan: async (net, hash) => { const r = await fetch(`${SCAN[net]}/extrinsics/${hash}`, { signal: AbortSignal.timeout(45000) }); return r.ok ? r.json() : undefined; },
  block: async (net, bh) => (await rpc(RPC[net], 'chain_getBlock', [bh]))?.block?.extrinsics,
  asset: async (id) => {
    if (assetCache.has(id)) return assetCache.get(id);
    if (!/^\d{1,10}$/.test(id)) return undefined;
    const n = Number(id);
    const le = new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
    const key = xxhashAsHex('Assets', 128) + xxhashAsHex('Metadata', 128).slice(2) + u8aToHex(blake2AsU8a(le, 128)).slice(2) + u8aToHex(le).slice(2);
    const raw: string | null = await rpc(RPC.ah, 'state_getStorage', [key]);
    let v: { symbol?: string; decimals?: number } | undefined;
    if (raw) { const t = new TypeRegistry().createType('(u128, Bytes, Bytes, u8, bool)', raw) as any; v = { symbol: Buffer.from(t[2].toU8a(true)).toString('utf8'), decimals: t[3].toNumber() }; }
    if (assetCache.size > 2000) assetCache.clear();
    assetCache.set(id, v);
    return v;
  },
};
