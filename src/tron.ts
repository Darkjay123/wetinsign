import { createHash } from 'node:crypto';
import type { CallInput } from './decode.js';
import type { Facts } from './facts.js';

/** Tron mainnet's EVM chain id (eth_chainId on TronGrid's JSON-RPC answers 0x2b6653dc). */
export const TRON_ID = 728126428;
const API = process.env.TRON_API ?? 'https://api.trongrid.io';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha = (b: Buffer) => createHash('sha256').update(b).digest();

function b58encode(buf: Buffer): string {
  let n = BigInt('0x' + buf.toString('hex'));
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of buf) { if (byte !== 0) break; out = '1' + out; }
  return out;
}
function b58decode(s: string): Buffer {
  let n = 0n;
  for (const ch of s) { const i = ALPHABET.indexOf(ch); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const lead = s.match(/^1*/)![0].length;
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, 'hex')]);
}

export const isTronBase58 = (a: unknown): boolean => typeof a === 'string' && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);

/** Any Tron address form (T…, 41…, 0x…) to the 0x form the EVM tools use. Returns undefined when it is not an address. */
export function tronToHex(a: string | undefined): string | undefined {
  if (!a) return undefined;
  if (isTronBase58(a)) {
    const raw = b58decode(a as string);
    if (raw.length !== 25 || raw[0] !== 0x41) return undefined;
    const body = raw.subarray(0, 21);
    if (!sha(sha(body)).subarray(0, 4).equals(raw.subarray(21))) return undefined;
    return '0x' + body.subarray(1).toString('hex');
  }
  if (/^41[0-9a-fA-F]{40}$/.test(a)) return '0x' + a.slice(2).toLowerCase();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return a.toLowerCase();
  return undefined;
}

/** 0x… or 41… to the T… address Tron wallets show. */
export function tronToBase58(a: string | undefined): string | undefined {
  const hex = tronToHex(a);
  if (!hex) return a;
  const body = Buffer.from('41' + hex.slice(2), 'hex');
  return b58encode(Buffer.concat([body, sha(sha(body)).subarray(0, 4)]));
}

async function api<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`TronGrid ${r.status}`);
  return (await r.json()) as T;
}

/** True when Tron says the address holds a smart contract. */
export async function tronIsContract(a: string | undefined): Promise<boolean | undefined> {
  const hex = tronToHex(a);
  if (!hex) return undefined;
  try {
    const c = await api<{ bytecode?: string }>('/wallet/getcontract', { value: '41' + hex.slice(2) });
    return !!c?.bytecode;
  } catch { return undefined; }
}

interface TronKey { address: string; weight: number | string }
interface TronPerm { permission_name?: string; threshold?: number | string; keys?: TronKey[] }

export interface TronParsed { call?: CallInput; facts?: Facts }
type Contract = { type: string; parameter: { value: Record<string, unknown> } };

/**
 * Read a Tron transaction (from TronGrid, or the JSON a wallet or dApp hands over for signing).
 * Smart-contract calls become an ordinary call for the EVM decoder (TRC-20 uses the same ABI).
 * Native actions become facts here.
 */
export async function parseTronTx(tx: unknown): Promise<TronParsed> {
  const t = tx as { raw_data?: { contract?: Contract[] }; contract?: Contract[] };
  const c = (t.raw_data?.contract ?? t.contract ?? [])[0];
  if (!c?.type) throw new Error('That does not look like a Tron transaction.');
  const v = c.parameter?.value ?? {};
  const owner = tronToHex(v.owner_address as string);
  const base = { chainId: TRON_ID, chain: 'Tron', from: owner };
  switch (c.type) {
    case 'TriggerSmartContract': {
      const to = tronToHex(v.contract_address as string);
      if (!to) throw new Error('No contract address in this Tron transaction.');
      const data = String(v.data ?? '');
      return { call: { chainId: TRON_ID, to, data: data ? (data.startsWith('0x') ? data : '0x' + data) : '0x', value: BigInt(String(v.call_value ?? 0)) } };
    }
    case 'TransferContract':
      return { call: { chainId: TRON_ID, to: tronToHex(v.to_address as string)!, data: '0x', value: BigInt(String(v.amount ?? 0)) } };
    case 'TransferAssetContract': {
      const id = String(v.asset_name ?? '');
      const assetId = /^[0-9a-fA-F]+$/.test(id) && !/^\d+$/.test(id) ? Buffer.from(id, 'hex').toString() : id;
      const meta = await api<{ abbr?: string; name?: string; precision?: number }>('/wallet/getassetissuebyid', { value: assetId }).catch(() => ({} as { abbr?: string; precision?: number }));
      const decimals = meta.precision ?? 0;
      const raw = BigInt(String(v.amount ?? 0));
      const { formatAmount } = await import('./format.js');
      return { facts: { ...base, kind: 'transfer', recipient: tronToHex(v.to_address as string), token: { address: `TRC10:${assetId}`, symbol: meta.abbr ? Buffer.from(meta.abbr, /^[0-9a-f]+$/i.test(meta.abbr) ? 'hex' : 'utf8').toString() : `TRC10 #${assetId}`, decimals }, amount: formatAmount(raw, { decimals }) } };
    }
    case 'AccountPermissionUpdateContract': {
      const perms: Array<{ scope: 'owner' | 'active'; p: TronPerm }> = [];
      if (v.owner) perms.push({ scope: 'owner', p: v.owner as TronPerm });
      for (const a of (v.actives as TronPerm[] | undefined) ?? []) perms.push({ scope: 'active', p: a });
      const permission = perms.map(({ scope, p }) => {
        const keys = (p.keys ?? []).map((k) => ({ address: tronToHex(k.address)!, weight: Number(k.weight) }));
        const yourWeight = keys.filter((k) => k.address === owner).reduce((s, k) => s + k.weight, 0);
        const others = keys.filter((k) => k.address !== owner);
        const threshold = Number(p.threshold ?? 1);
        return { scope, threshold, yourWeight, others: others.map((k) => k.address), othersCanActAlone: others.some((k) => k.weight >= threshold) || others.reduce((s, k) => s + k.weight, 0) >= threshold };
      });
      const takers = [...new Set(permission.flatMap((p) => p.others))];
      return { facts: { ...base, kind: 'tron_permission', owner, spender: takers[0], permission } };
    }
    case 'DelegateResourceContract':
      return { facts: { ...base, kind: 'tron_action', action: 'delegate_resource', recipient: tronToHex(v.receiver_address as string), resource: String(v.resource ?? 'BANDWIDTH') } };
    case 'UnDelegateResourceContract':
      return { facts: { ...base, kind: 'tron_action', action: 'undelegate_resource', recipient: tronToHex(v.receiver_address as string), resource: String(v.resource ?? 'BANDWIDTH') } };
    case 'FreezeBalanceV2Contract':
      return { facts: { ...base, kind: 'tron_action', action: 'stake' } };
    case 'UnfreezeBalanceV2Contract':
      return { facts: { ...base, kind: 'tron_action', action: 'unstake' } };
    case 'VoteWitnessContract':
      return { facts: { ...base, kind: 'tron_action', action: 'vote' } };
    case 'WithdrawBalanceContract':
      return { facts: { ...base, kind: 'tron_action', action: 'claim_rewards' } };
    default:
      return { facts: { ...base, kind: 'unknown_call', selector: c.type } };
  }
}

/** Fetch a Tron transaction by id (with or without 0x) and read it. */
export async function fetchTronTx(hash: string): Promise<TronParsed> {
  const id = hash.replace(/^0x/i, '');
  const tx = await api<Record<string, unknown>>('/wallet/gettransactionbyid', { value: id });
  if (!tx || !('raw_data' in tx)) throw new Error('not found');
  return parseTronTx(tx);
}

/** Show Tron addresses the way Tron wallets do (T…). Risk checks run on the 0x form before this. */
export function tronDisplay(f: Facts): Facts {
  if (f.chainId !== TRON_ID) return f;
  const b = (a?: string) => (a && /^0x[0-9a-fA-F]{40}$/.test(a) ? tronToBase58(a) : a);
  return {
    ...f,
    contract: b(f.contract), spender: b(f.spender), recipient: b(f.recipient), from: b(f.from), owner: b(f.owner),
    ...(f.token ? { token: { ...f.token, address: b(f.token.address)! } } : {}),
    ...(f.permission ? { permission: f.permission.map((p) => ({ ...p, others: p.others.map((o) => b(o)!) })) } : {}),
  };
}
