import { decodeFunctionData, parseAbi, type Hex } from 'viem';
import { chainName, CHAINS } from './chains.js';
import type { Facts, SeaportItem } from './facts.js';
import { formatAmount, formatDeadline } from './format.js';
import { knownToken, type TokenRef } from './tokens.js';

const ERC_ABI = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 addedValue)',
  'function increaseApproval(address spender, uint256 addedValue)',
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function setApprovalForAll(address operator, bool approved)',
]);

const OWNER_ABI = parseAbi([
  'function setOwner(address owner)',
  'function transferOwnership(address newOwner)',
]);

const MULTICALL_ABI = parseAbi([
  'function multicall(bytes[] data)',
  'function multicall(uint256 deadline, bytes[] data)',
]);

/** Inner actions worth surfacing, most dangerous first. */
const BUNDLE_PRIORITY = ['nft_approve_all', 'nft_approve', 'erc20_approve', 'permit2', 'transfer_from', 'transfer'] as const;

const PERMIT2_ABI = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

export interface CallInput {
  chainId?: number;
  to: string;
  data?: string;
  value?: string | bigint;
}

export type TokenResolver = (chainId: number | undefined, address: string) => Promise<TokenRef> | TokenRef;

const offlineResolver: TokenResolver = (chainId, address) => knownToken(chainId, address);

/** Decode a contract call or plain send into facts. Pure apart from the optional token lookup. */
export async function decodeCall(input: CallInput, resolveToken: TokenResolver = offlineResolver): Promise<Facts> {
  const chainId = input.chainId;
  const base = { chainId, chain: chainName(chainId), contract: input.to };
  const value = BigInt(input.value ?? 0);
  const data = (input.data ?? '0x') as Hex;
  const nativeDecimals = chainId !== undefined && CHAINS[chainId] ? 18 : undefined;

  if (data === '0x' || data.length < 10) {
    return {
      ...base,
      kind: 'native_send',
      recipient: input.to,
      token: { address: 'native', symbol: chainId !== undefined ? CHAINS[chainId]?.nativeSymbol : undefined, decimals: nativeDecimals },
      amount: formatAmount(value, { decimals: nativeDecimals }),
    };
  }

  const nativeValue = value > 0n ? formatAmount(value, { decimals: nativeDecimals }) : undefined;

  try {
    const { functionName, args } = decodeFunctionData({ abi: ERC_ABI, data });
    const token = await resolveToken(chainId, input.to);
    switch (functionName) {
      case 'approve':
      case 'increaseAllowance':
      case 'increaseApproval': {
        const [spender, amount] = args as readonly [string, bigint];
        // On an NFT collection, approve(spender, id) hands over ONE NFT. Reading the id as a token amount was a real bug
        // (a drained PepeLand NFT #378 showed up as "378 tokens").
        if (token.isNft && functionName === 'approve') {
          return { ...base, kind: 'nft_approve', token, spender, tokenId: amount.toString(), nativeValue };
        }
        return { ...base, kind: 'erc20_approve', token, spender, amount: formatAmount(amount, token), nativeValue };
      }
      case 'transfer': {
        const [to, amount] = args as readonly [string, bigint];
        return { ...base, kind: 'transfer', token, recipient: to, amount: formatAmount(amount, token), nativeValue };
      }
      case 'transferFrom': {
        const [from, to, amount] = args as readonly [string, string, bigint];
        return { ...base, kind: 'transfer_from', token, from, recipient: to, amount: formatAmount(amount, token), nativeValue };
      }
      case 'setApprovalForAll': {
        const [operator, approved] = args as readonly [string, boolean];
        return { ...base, kind: 'nft_approve_all', token, spender: operator, approved, nativeValue };
      }
    }
  } catch {
    // not a standard token call; fall through
  }

  // Handing over a contract you own (e.g. the DSProxy that holds a Maker vault). This alone cost one victim $55M in Aug 2024.
  try {
    const { args } = decodeFunctionData({ abi: OWNER_ABI, data });
    return { ...base, kind: 'ownership_transfer', recipient: args[0] as string, nativeValue };
  } catch {
    // not an ownership change
  }

  try {
    const { args } = decodeFunctionData({ abi: PERMIT2_ABI, data });
    const [tokenAddr, spender, amount, expiration] = args as readonly [string, string, bigint, number];
    const token = await resolveToken(chainId, tokenAddr);
    return {
      ...base,
      kind: 'permit2',
      token,
      spender,
      amount: formatAmount(amount, token),
      deadline: formatDeadline(BigInt(expiration)),
      nativeValue,
    };
  } catch {
    // unknown
  }

  // Drainers hide an approve() inside multicall() so wallets show a harmless-looking top-level call.
  try {
    const { args } = decodeFunctionData({ abi: MULTICALL_ABI, data });
    const calls = (args.length === 1 ? args[0] : args[1]) as readonly Hex[];
    const inner: Facts[] = [];
    for (const c of calls) inner.push(await decodeCall({ chainId, to: input.to, data: c }, resolveToken));
    for (const kind of BUNDLE_PRIORITY) {
      const hit = inner.find((f) => f.kind === kind);
      if (hit) return { ...hit, via: 'multicall', nativeValue };
    }
  } catch {
    // not a multicall either
  }

  return { ...base, kind: 'unknown_call', selector: data.slice(0, 10), nativeValue };
}

interface TypedData {
  domain?: { name?: string; chainId?: number | string; verifyingContract?: string };
  primaryType?: string;
  message?: Record<string, any>;
}

function big(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v === 'string' && v.trim() !== '') return BigInt(v);
  return 0n;
}

/** Decode an EIP-712 signature request (what a wallet shows as "Sign message"). */
export async function decodeTypedData(
  raw: TypedData | string,
  resolveToken: TokenResolver = offlineResolver,
  nowSec?: number,
): Promise<Facts> {
  const td: TypedData = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const chainId = td.domain?.chainId !== undefined ? Number(td.domain.chainId) : undefined;
  const msg = td.message ?? {};
  const base = { chainId, chain: chainName(chainId), contract: td.domain?.verifyingContract, primaryType: td.primaryType, appName: td.domain?.name };

  if (td.primaryType === 'Permit' && msg.spender) {
    const token = await resolveToken(chainId, td.domain?.verifyingContract ?? 'unknown');
    return {
      ...base,
      kind: 'permit',
      token,
      owner: msg.owner,
      spender: msg.spender,
      amount: formatAmount(big(msg.value), token),
      deadline: formatDeadline(big(msg.deadline), nowSec),
    };
  }

  if ((td.primaryType === 'PermitSingle' || td.primaryType === 'PermitBatch') && msg.details) {
    const details = Array.isArray(msg.details) ? msg.details[0] : msg.details;
    const token = await resolveToken(chainId, details.token);
    return {
      ...base,
      kind: 'permit2',
      token,
      spender: msg.spender,
      amount: formatAmount(big(details.amount), token),
      deadline: formatDeadline(big(details.expiration), nowSec),
    };
  }

  if (td.primaryType === 'OrderComponents' && Array.isArray(msg.offer)) {
    const toItem = (i: any): SeaportItem => ({
      itemType: Number(i.itemType),
      token: i.token,
      amount: formatAmount(big(i.endAmount ?? i.startAmount)),
      recipient: i.recipient,
    });
    return {
      ...base,
      kind: 'seaport_order',
      owner: msg.offerer,
      offer: msg.offer.map(toItem),
      consideration: (msg.consideration ?? []).map(toItem),
      deadline: msg.endTime !== undefined ? formatDeadline(big(msg.endTime), nowSec) : undefined,
    };
  }

  return { ...base, kind: 'unknown_signature' };
}
