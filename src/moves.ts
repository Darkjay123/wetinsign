/**
 * What actually happened in a mined EVM transaction, read from its receipt logs:
 * every token, NFT and approval change, plus the native coin sent with the call.
 * This is the record the chain kept, not a guess from the input data.
 */
import type { Hex } from 'viem';
import { client, onchainResolver } from './rpc.js';
import { formatAmount } from './format.js';
import { drainerSet } from './drainers.js';
import { CHAINS, rpcUrls } from './chains.js';
import { createPublicClient, http, type PublicClient } from 'viem';
import { trustedSpender } from './trusted.js';
import type { TokenRef } from './tokens.js';

export const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const T_APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
export const T_APPROVAL_ALL = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31';
export const T_1155_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const MAX_MOVES = 40;

export interface Move {
  type: 'token' | 'nft' | 'native' | 'approval' | 'approval_all' | 'approval_revoked';
  token?: { address: string; symbol?: string };
  from: string;
  to: string;
  amount?: string;
  unlimited?: boolean;
  tokenId?: string;
  /** Left the wallet that sent the transaction. */
  fromSender: boolean;
  /** Went to (or gave power to) an address publicly reported as a wallet drainer. */
  toDrainer: boolean;
  toName?: string;
}
export interface Moves {
  status: 'success' | 'reverted';
  sender: string;
  moves: Move[];
  truncated: boolean;
  /** Plain English, built only from the moves above. */
  summary: string;
}

const addr = (topic?: string | null) => (topic ? ('0x' + topic.slice(26)).toLowerCase() : '');

export function readLogs(
  chainId: number,
  sender: string,
  logs: { address: string; topics: (string | null)[]; data: string }[],
  tokens: Map<string, TokenRef>,
  native?: { to: string; value: bigint; decimals?: number; symbol: string },
): { moves: Move[]; truncated: boolean } {
  const drainers = drainerSet();
  const me = sender.toLowerCase();
  const out: Move[] = [];
  const mk = (m: Omit<Move, 'fromSender' | 'toDrainer' | 'toName'>): Move => ({
    ...m,
    fromSender: m.from === me,
    toDrainer: drainers.has(m.to),
    ...(trustedSpender(chainId, m.to) ? { toName: trustedSpender(chainId, m.to) } : {}),
  });
  if (native && native.value > 0n) {
    out.push(mk({ type: 'native', token: { address: 'native', symbol: native.symbol }, from: me, to: native.to.toLowerCase(), amount: formatAmount(native.value, { decimals: native.decimals ?? 18 }).display }));
  }
  for (const l of logs) {
    const t0 = (l.topics[0] ?? '').toLowerCase();
    const contract = l.address.toLowerCase();
    const tok = tokens.get(contract);
    const ref = { address: contract, symbol: tok?.symbol };
    const val = () => (l.data && l.data.length >= 66 ? BigInt(l.data.slice(0, 66)) : 0n);
    if (t0 === T_TRANSFER && l.topics.length === 3) {
      const a = formatAmount(val(), tok);
      out.push(mk({ type: 'token', token: ref, from: addr(l.topics[1]), to: addr(l.topics[2]), amount: a.display }));
    } else if (t0 === T_TRANSFER && l.topics.length === 4) {
      out.push(mk({ type: 'nft', token: ref, from: addr(l.topics[1]), to: addr(l.topics[2]), tokenId: BigInt(l.topics[3] ?? '0x0').toString() }));
    } else if (t0 === T_1155_SINGLE && l.topics.length === 4 && l.data.length >= 130) {
      const id = BigInt('0x' + l.data.slice(2, 66));
      const v = BigInt('0x' + l.data.slice(66, 130));
      out.push(mk({ type: 'nft', token: ref, from: addr(l.topics[2]), to: addr(l.topics[3]), tokenId: id.toString(), amount: v.toString() }));
    } else if (t0 === T_APPROVAL && l.topics.length === 3) {
      const raw = val();
      const a = formatAmount(raw, tok);
      out.push(mk({ type: raw === 0n ? 'approval_revoked' : 'approval', token: ref, from: addr(l.topics[1]), to: addr(l.topics[2]), amount: a.display, unlimited: a.unlimited }));
    } else if (t0 === T_APPROVAL_ALL && l.topics.length === 3) {
      const on = val() !== 0n;
      out.push(mk({ type: on ? 'approval_all' : 'approval_revoked', token: ref, from: addr(l.topics[1]), to: addr(l.topics[2]) }));
    }
  }
  // The sender's own losses and new permissions matter most; keep them first.
  out.sort((a, b) => Number(b.fromSender) - Number(a.fromSender));
  return { moves: out.slice(0, MAX_MOVES), truncated: out.length > MAX_MOVES };
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function summarize(r: { status: 'success' | 'reverted'; moves: Move[] }): string {
  if (r.status === 'reverted') return 'This transaction failed on-chain, so nothing moved (only the network fee was paid).';
  const mine = r.moves.filter((m) => m.fromSender);
  // Permit drains: the thief sends the transaction, so the victim is the owner in the logs, not the sender.
  const others = !mine.length;
  const list = others ? r.moves.slice(0, 6) : mine;
  if (!list.length) return 'Nothing moved in this transaction apart from the network fee.';
  const parts = list.map((m) => {
    const who = m.toName ?? short(m.to);
    if (others) {
      const owner = short(m.from);
      if (m.type === 'approval') return `${owner} gave ${who} permission to take ${m.unlimited ? 'all of its' : m.amount} ${m.token?.symbol ?? 'tokens'}`;
      if (m.type === 'approval_all') return `${owner} gave ${who} permission over every ${m.token?.symbol ?? 'NFT'} it owns`;
      if (m.type === 'nft') return `${m.token?.symbol ?? 'an NFT'} #${m.tokenId} moved from ${owner} to ${who}`;
      if (m.type === 'approval_revoked') return `${owner} removed the permission for ${who}`;
      return `${m.amount} ${m.token?.symbol ?? 'tokens'} moved from ${owner} to ${who}`;
    }
    const what = m.token?.symbol ?? 'a token';
    if (m.type === 'native' || m.type === 'token') return `${m.amount} ${what} went to ${who}`;
    if (m.type === 'nft') return `${what} #${m.tokenId} went to ${who}`;
    if (m.type === 'approval') return `${who} was allowed to take ${m.unlimited ? 'all of your' : m.amount} ${what}`;
    if (m.type === 'approval_all') return `${who} was allowed to take every ${what} NFT you own`;
    return `the permission for ${who} on ${what} was removed`;
  });
  const drained = list.some((m) => m.toDrainer);
  const lead = others ? 'The sender lost nothing itself, but this is what it did to other wallets: ' : 'What the chain recorded: ';
  return `${drained ? 'Warning: some of this went to an address reported as a wallet drainer. ' : ''}${lead}${parts.join('; ')}.`;
}

export async function fetchMoves(chainId: number, hash: string): Promise<Moves> {
  const c = client(chainId);
  const tx = await c.getTransaction({ hash: hash as Hex });
  // Some public nodes prune old receipts and answer null; ask each one in turn.
  let rc: Awaited<ReturnType<PublicClient['getTransactionReceipt']>> | undefined;
  for (const u of rpcUrls(chainId)) {
    try { rc = await (createPublicClient({ transport: http(u, { timeout: 12_000, retryCount: 0 }) }) as PublicClient).getTransactionReceipt({ hash: hash as Hex }); break; } catch { /* next node */ }
  }
  if (!rc) throw new Error('receipt not found');
  const contracts = [...new Set(rc.logs.map((l) => l.address.toLowerCase()))].slice(0, 25);
  const tokens = new Map<string, TokenRef>();
  await Promise.all(contracts.map(async (a) => tokens.set(a, await Promise.resolve(onchainResolver(chainId, a)).catch(() => ({ address: a } as TokenRef)))));
  const chain = CHAINS[chainId];
  const r = readLogs(chainId, tx.from, rc.logs as never, tokens, tx.to ? { to: tx.to, value: tx.value, decimals: chain?.nativeDecimals, symbol: chain?.nativeSymbol ?? 'ETH' } : undefined);
  const status = rc.status === 'success' ? 'success' : 'reverted';
  return { status, sender: tx.from.toLowerCase(), ...r, summary: summarize({ status, moves: r.moves }) };
}
