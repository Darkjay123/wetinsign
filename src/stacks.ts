import * as S from '@stacks/transactions';
import type { Facts } from './facts.js';
import { formatAmount } from './format.js';
import type { TokenRef } from './tokens.js';

/**
 * Stacks (STX, Bitcoin layer). Not EVM: Leather and Xverse sign serialized transactions. Each one carries a
 * post-condition mode: "deny" means only the listed amounts may leave your wallet; "allow" means the contract
 * may move ANY of your assets, the setting Stacks drainers rely on. Decoding via @stacks/transactions 7.6.
 * 5757 is STX's SLIP-44 coin type.
 */
export const STX_ID = 5757;
const CHAIN = 'Stacks';
const HIRO = process.env.STX_API ?? 'https://api.hiro.so';
const STX: TokenRef = { address: 'native', symbol: 'STX', decimals: 6 };
const POX = /^SP000000000000000000002Q6VF78\.pox(-\d+)?$/;
export const STX_TXID_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const PRINCIPAL_RE = /^S[PM][0-9A-Z]{28,41}(\.[a-zA-Z][a-zA-Z0-9-]{0,127})?$/;

export interface StxTx {
  sender?: string; type: 'stx' | 'call' | 'other'; recipient?: string; amount?: bigint; memo?: string;
  contract?: string; fn?: string; args?: unknown[]; allowMode: boolean; limits: number;
}
export interface StxLookup {
  ft?: (contract: string) => Promise<{ symbol?: string; decimals?: number } | undefined>;
  tx?: (id: string) => Promise<any>;
}

const cvVal = (cv: any): unknown => { try { const v = S.cvToValue(cv, true); return v && typeof v === 'object' && 'value' in v ? (v as any).value : v; } catch { return undefined; } };
const str = (x: any): string => (typeof x === 'string' ? x : x?.content ?? '');
function senderOf(tx: any): string | undefined {
  try {
    const sc = tx.auth?.spendingCondition;
    const version = sc.hashMode === 1 || sc.hashMode === 3 || sc.hashMode === 5 || sc.hashMode === 7 ? S.AddressVersion.MainnetMultiSig : S.AddressVersion.MainnetSingleSig;
    return S.addressToString(S.addressFromVersionHash(version, sc.signer));
  } catch { return undefined; }
}
export const looksLikeStxHex = (s: string) => /^(0x)?0000000001(04|05)[0-9a-fA-F]{100,}$/.test(s.trim());

export function fromHex(hex: string): StxTx | undefined {
  try {
    const tx: any = S.deserializeTransaction(hex.trim().replace(/^0x/, ''));
    const p: any = tx.payload;
    const base = { sender: senderOf(tx), allowMode: tx.postConditionMode === S.PostConditionMode.Allow, limits: tx.postConditions?.values?.length ?? tx.postConditions?.length ?? 0 };
    if (p.payloadType === S.PayloadType.TokenTransfer) return { ...base, type: 'stx', recipient: String(cvVal(p.recipient) ?? ''), amount: BigInt(p.amount), memo: str(p.memo).replace(/\0+$/, '') || undefined };
    if (p.payloadType === S.PayloadType.ContractCall) {
      const addr = S.addressToString(p.contractAddress);
      return { ...base, type: 'call', contract: `${addr}.${str(p.contractName)}`, fn: str(p.functionName), args: p.functionArgs.map(cvVal) };
    }
    return { ...base, type: 'other' };
  } catch { return undefined; }
}
/** Hiro API JSON (a hash lookup) or a wallet request { contract, functionName, functionArgs (hex), postConditionMode }. */
export function fromJson(t: any): StxTx | undefined {
  if (!t || typeof t !== 'object') return undefined;
  if (t.tx_type === 'token_transfer') return { sender: t.sender_address, type: 'stx', recipient: t.token_transfer?.recipient_address, amount: BigInt(t.token_transfer?.amount ?? 0), memo: undefined, allowMode: t.post_condition_mode === 'allow', limits: (t.post_conditions ?? []).length };
  if (t.tx_type === 'contract_call' && t.contract_call) {
    const args = (t.contract_call.function_args ?? []).map((a: any) => { try { return cvVal(S.deserializeCV(String(a.hex).replace(/^0x/, ''))); } catch { return a.repr; } });
    return { sender: t.sender_address, type: 'call', contract: t.contract_call.contract_id, fn: t.contract_call.function_name, args, allowMode: t.post_condition_mode === 'allow', limits: (t.post_conditions ?? []).length };
  }
  if (t.tx_type) return { sender: t.sender_address, type: 'other', allowMode: t.post_condition_mode === 'allow', limits: 0 };
  const contract = typeof t.contract === 'string' ? t.contract : t.contractAddress && t.contractName ? `${t.contractAddress}.${t.contractName}` : undefined;
  if (contract && PRINCIPAL_RE.test(contract) && typeof t.functionName === 'string') {
    const args = (Array.isArray(t.functionArgs) ? t.functionArgs : []).map((a: unknown) => { try { return typeof a === 'string' ? cvVal(S.deserializeCV(a.replace(/^0x/, ''))) : cvVal(a); } catch { return a; } });
    const mode = String(t.postConditionMode ?? 'deny').toLowerCase();
    return { sender: typeof t.address === 'string' ? t.address : undefined, type: 'call', contract, fn: t.functionName, args, allowMode: mode === 'allow' || mode === '1', limits: Array.isArray(t.postConditions) ? t.postConditions.length : 0 };
  }
  return undefined;
}
export function parseStx(v: unknown): StxTx | undefined {
  if (typeof v === 'string') { const s = v.trim(); if (looksLikeStxHex(s)) return fromHex(s); if (s.startsWith('{')) { try { return fromJson(JSON.parse(s)); } catch { return undefined; } } return undefined; }
  return fromJson(v);
}

const big = (x: unknown) => { try { return BigInt(String(x)); } catch { return undefined; } };
const principal = (x: unknown) => (typeof x === 'string' && PRINCIPAL_RE.test(x.replace(/^'/, '')) ? x.replace(/^'/, '') : undefined);

export async function stxFacts(t: StxTx, lookup: StxLookup = {}): Promise<Facts> {
  const base: Facts = { kind: 'unknown_call', chainId: STX_ID, chain: CHAIN, ...(t.sender ? { from: t.sender, owner: t.sender } : {}) };
  if (t.type === 'stx') return { ...base, kind: 'native_send', token: STX, amount: formatAmount(t.amount ?? 0n, STX), recipient: t.recipient, ...(t.memo ? { memo: t.memo.slice(0, 200) } : {}) };
  if (t.type !== 'call' || !t.contract || !t.fn) return { ...base, kind: 'ledger_action', ledgerAction: 'settings' };
  const a = t.args ?? [];
  const noLimits = t.allowMode ? { noLimits: true } : {};
  if (POX.test(t.contract)) return { ...base, kind: 'ledger_action', ledgerAction: 'stake', appName: `${t.contract}::${t.fn}`, ...noLimits };
  // SIP-010 fungible token: transfer(amount uint, sender principal, recipient principal, memo (optional buff))
  if (t.fn === 'transfer' && a.length === 4 && big(a[0]) !== undefined && principal(a[2])) {
    const m = await lookup.ft?.(t.contract).catch(() => undefined);
    const token: TokenRef = { address: t.contract, symbol: m?.symbol ?? t.contract.split('.')[1], decimals: m?.decimals };
    return { ...base, kind: 'transfer', token, contract: t.contract, amount: formatAmount(big(a[0])!, token), recipient: principal(a[2]), ...noLimits };
  }
  // SIP-009 NFT: transfer(id uint, sender principal, recipient principal)
  if (t.fn === 'transfer' && a.length === 3 && big(a[0]) !== undefined && principal(a[2])) {
    const token: TokenRef = { address: t.contract, symbol: `${t.contract.split('.')[1]} #${big(a[0])}`, decimals: 0 };
    return { ...base, kind: 'transfer', token, contract: t.contract, amount: formatAmount(1n, token), recipient: principal(a[2]), ...noLimits };
  }
  return { ...base, contract: t.contract, appName: `${t.contract}::${t.fn}`.slice(0, 160), selector: t.fn.slice(0, 80), ...noLimits };
}

async function get(path: string): Promise<any> {
  const r = await fetch(`${HIRO}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`stacks ${r.status}`);
  return r.json();
}
const cache = new Map<string, { symbol?: string; decimals?: number } | undefined>();
export const stxLookup: StxLookup = {
  ft: async (c) => {
    if (!PRINCIPAL_RE.test(c)) return undefined;
    if (cache.has(c)) return cache.get(c);
    const r = await get(`/metadata/v1/ft/${c}`).catch(() => undefined);
    const v = r ? { symbol: r.symbol, decimals: r.decimals !== undefined ? Number(r.decimals) : undefined } : undefined;
    if (cache.size > 2000) cache.clear();
    cache.set(c, v);
    return v;
  },
  tx: async (id) => get(`/extended/v1/tx/${id.startsWith('0x') ? id : '0x' + id}`),
};
export async function fetchStxTx(id: string, lookup: StxLookup = stxLookup): Promise<Facts> {
  const t = fromJson(await lookup.tx?.(id));
  if (!t) throw new Error('not found');
  return stxFacts(t, lookup);
}
