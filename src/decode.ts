import { decodeAbiParameters, decodeFunctionData, parseAbi, type Hex } from 'viem';
import { chainName, CHAINS, nativeSymbol } from './chains.js';
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
const EXECUTE_ABI = parseAbi(['function execute(bytes32 mode, bytes executionData)']);
const EXECUTION_ARRAY = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }] as const;

// Handing over a contract you own outranks everything: it gave one victim's $55M vault away. A plain coin send inside a
// batch is last but still counted, so a batch that only empties your ETH is not called "unreadable".
const BUNDLE_PRIORITY = ['ownership_transfer', 'nft_approve_all', 'nft_approve', 'erc20_approve', 'permit2', 'transfer_from', 'transfer', 'native_send'] as const;
/** Bundles inside bundles: real wallets nest one or two deep. Deeper is someone trying to exhaust us. */
const MAX_DEPTH = 4;

const PERMIT2_ABI = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

export interface CallInput {
  chainId?: number;
  to: string;
  data?: string;
  value?: string | bigint;
  /** EIP-7702 (type 4) transactions: the contracts the sender's account, or other signers' accounts, get pointed at. */
  authorizations?: { address: string; chainId?: number }[];
}

export type TokenResolver = (chainId: number | undefined, address: string) => Promise<TokenRef> | TokenRef;

const offlineResolver: TokenResolver = (chainId, address) => knownToken(chainId, address);

/** Decode a contract call or plain send into facts. Pure apart from the optional token lookup. */
export async function decodeCall(input: CallInput, resolveToken: TokenResolver = offlineResolver, depth = 0): Promise<Facts> {
  const chainId = input.chainId;
  const base = { chainId, chain: chainName(chainId), contract: input.to };
  const value = BigInt(input.value ?? 0);
  const data = (input.data ?? '0x') as Hex;
  const nativeDecimals = chainId !== undefined && CHAINS[chainId] ? (CHAINS[chainId].nativeDecimals ?? 18) : undefined;

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

  if (depth >= MAX_DEPTH) return { ...base, kind: 'unknown_call', selector: data.slice(0, 10), nativeValue };

  // Drainers hide an approve() inside multicall() so wallets show a harmless-looking top-level call.
  try {
    const { args } = decodeFunctionData({ abi: MULTICALL_ABI, data });
    const calls = (args.length === 1 ? args[0] : args[1]) as readonly Hex[];
    const inner: Facts[] = [];
    for (const c of calls) inner.push(await decodeCall({ chainId, to: input.to, data: c }, resolveToken, depth + 1));
    for (const kind of BUNDLE_PRIORITY) {
      const hit = inner.find((f) => f.kind === kind && !(kind === 'native_send' && f.amount?.raw === '0'));
      if (hit) return { ...hit, via: 'multicall', nativeValue };
    }
  } catch {
    // not a multicall either
  }

  // EIP-7702 wallets (MetaMask delegator, ERC-7821) run a batch of calls from your own address in one go.
  // Inferno Drainer used this in May 2025 to get 10 unlimited approvals out of one "swap" click.
  try {
    const { args } = decodeFunctionData({ abi: EXECUTE_ABI, data });
    const [mode, exec] = args as readonly [Hex, Hex];
    const calls: Array<{ target: string; value: bigint; callData: Hex }> = [];
    if (mode.slice(2, 4) === '01') {
      const [arr] = decodeAbiParameters(EXECUTION_ARRAY, exec);
      for (const c of arr) calls.push({ target: c.target, value: c.value, callData: c.callData });
    } else if (mode.slice(2, 4) === '00' && exec.length >= 2 + 104) {
      calls.push({ target: '0x' + exec.slice(2, 42), value: BigInt('0x' + exec.slice(42, 106)), callData: ('0x' + exec.slice(106)) as Hex });
    }
    if (calls.length) {
      const inner: Facts[] = [];
      for (const c of calls) inner.push(await decodeCall({ chainId, to: c.target, data: c.callData, value: c.value }, resolveToken, depth + 1));
      const bundle = inner
        .filter((f) => (BUNDLE_PRIORITY as readonly string[]).includes(f.kind) && !(f.kind === 'native_send' && f.amount?.raw === '0'))
        .map((f) => ({ kind: f.kind, token: f.token, spender: f.spender ?? f.recipient, amount: f.amount }));
      for (const kind of BUNDLE_PRIORITY) {
        const hit = inner.find((f) => f.kind === kind && !(kind === 'native_send' && f.amount?.raw === '0'));
        if (hit) return { ...hit, via: 'batch', bundle, nativeValue };
      }
      return { ...base, kind: 'unknown_call', selector: data.slice(0, 10), via: 'batch', bundle, nativeValue };
    }
  } catch {
    // not a wallet batch
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
const MAX_UINT256 = (1n << 256n) - 1n;
/**
 * DAI-style permits (Permit(holder, spender, nonce, expiry, allowed)) carry no
 * amount: allowed=true is an UNLIMITED approval, allowed=false is a revoke.
 * Reading them as EIP-2612 (msg.value) made a real DAI drain look like a revoke.
 */
function permitAmount(msg: Record<string, any>): bigint {
  if (msg.allowed !== undefined && msg.value === undefined) {
    const on = msg.allowed === true || String(msg.allowed).toLowerCase() === 'true' || String(msg.allowed) === '1';
    return on ? MAX_UINT256 : 0n;
  }
  return big(msg.value);
}
/** DAI uses expiry, and expiry 0 means the permission never expires. */
function permitDeadline(msg: Record<string, any>): bigint {
  if (msg.deadline !== undefined) return big(msg.deadline);
  if (msg.expiry !== undefined) return big(msg.expiry) === 0n ? MAX_UINT256 : big(msg.expiry);
  return MAX_UINT256;
}

export async function decodeTypedData(
  raw: TypedData | string,
  resolveToken: TokenResolver = offlineResolver,
  nowSec?: number,
  /** The wallet that is being asked to sign, when the caller knows it (wallets always do). */
  signer?: string,
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
      owner: msg.owner ?? msg.holder,
      spender: msg.spender,
      amount: formatAmount(permitAmount(msg), token),
      deadline: formatDeadline(permitDeadline(msg), nowSec),
    };
  }

  if ((td.primaryType === 'PermitSingle' || td.primaryType === 'PermitBatch') && msg.details) {
    // PermitBatch approves EVERY token in the list. Showing only the first hid the rest (a drainer asks for all of them).
    const all = (Array.isArray(msg.details) ? msg.details : [msg.details]).filter((d: any) => d?.token);
    const batch = [];
    for (const d of all) {
      const token = await resolveToken(chainId, d.token);
      batch.push({ token, amount: formatAmount(big(d.amount), token), deadline: formatDeadline(big(d.expiration), nowSec) });
    }
    if (!batch.length) return { ...base, kind: 'unknown_signature' };
    // Lead with the worst item: an unlimited one, else the first.
    const lead = batch.find((b) => b.amount.unlimited) ?? batch[0];
    const never = batch.find((b) => b.deadline.never);
    return {
      ...base,
      kind: 'permit2',
      token: lead.token,
      spender: msg.spender,
      amount: lead.amount,
      deadline: never ? never.deadline : lead.deadline,
      ...(batch.length > 1 ? { batch: batch.map(({ token, amount }) => ({ token, amount })) } : {}),
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

  // Permit2 "SignatureTransfer": unlike PermitSingle, this lets the spender pull the tokens right away, once.
  // Drainers point it at a fresh address that has no code yet. UniswapX swaps use the witness version legitimately.
  if (/^Permit(Batch)?(Witness)?TransferFrom$/.test(td.primaryType ?? '') && msg.permitted) {
    const items = Array.isArray(msg.permitted) ? msg.permitted : [msg.permitted];
    const batch = [];
    for (const it of items) {
      const token = await resolveToken(chainId, it.token);
      batch.push({ token, amount: formatAmount(big(it.amount), token) });
    }
    return {
      ...base,
      kind: 'permit2_transfer',
      token: batch[0]?.token,
      amount: batch[0]?.amount,
      ...(batch.length > 1 ? { batch } : {}),
      spender: msg.spender,
      deadline: msg.deadline !== undefined ? formatDeadline(big(msg.deadline), nowSec) : undefined,
    };
  }

  // CoW Swap order (GPv2Order). The owner is not inside the message: it is whoever signs. The danger is the
  // receiver: a fake swap site sets it to its own address, so you sell your tokens and the proceeds go to them.
  if (td.primaryType === 'Order' && msg.sellToken && msg.buyToken && msg.kind !== undefined) {
    const sellToken = await swapToken(chainId, msg.sellToken, resolveToken);
    const buyToken = await swapToken(chainId, msg.buyToken, resolveToken);
    return {
      ...base,
      kind: 'swap_order',
      protocol: 'CoW Swap',
      spender: td.domain?.verifyingContract,
      owner: signer,
      recipient: zeroToUndef(msg.receiver),
      token: sellToken,
      amount: formatAmount(big(msg.sellAmount) + big(msg.feeAmount ?? 0), sellToken),
      buyToken,
      buyAmount: formatAmount(big(msg.buyAmount), buyToken),
      swapKind: String(msg.kind) === 'buy' ? 'buy' : 'sell',
      deadline: msg.validTo !== undefined ? formatDeadline(big(msg.validTo), nowSec) : undefined,
    };
  }

  // 1inch Limit Order Protocol v4. Expiry sits in makerTraits bits 80..119; 0 means it never expires.
  if (td.primaryType === 'Order' && msg.maker && msg.makerAsset && msg.takerAsset) {
    const sellToken = await swapToken(chainId, asAddr(msg.makerAsset), resolveToken);
    const buyToken = await swapToken(chainId, asAddr(msg.takerAsset), resolveToken);
    const expiry = (big(msg.makerTraits ?? 0) >> 80n) & ((1n << 40n) - 1n);
    return {
      ...base,
      kind: 'swap_order',
      protocol: '1inch',
      spender: td.domain?.verifyingContract,
      owner: asAddr(msg.maker),
      recipient: zeroToUndef(asAddr(msg.receiver ?? '0x0')),
      token: sellToken,
      amount: formatAmount(big(msg.makingAmount), sellToken),
      buyToken,
      buyAmount: formatAmount(big(msg.takingAmount), buyToken),
      swapKind: 'sell',
      deadline: expiry === 0n ? { unix: '0', display: 'never expires', never: true } : formatDeadline(expiry, nowSec),
    };
  }

  // Blur marketplace. A sell Order for (almost) nothing is how Blur listings get drained;
  // a Root signs a whole batch of listings at once and does not show which ones.
  if (/blur/i.test(td.domain?.name ?? '')) {
    if (td.primaryType === 'Order' && msg.trader) {
      const pay = String(msg.paymentToken ?? '').toLowerCase();
      const symbol = /^0x0{40}$/.test(pay) ? 'ETH' : pay === BLUR_POOL ? 'Blur Pool ETH' : undefined;
      const payToken = symbol ? { address: msg.paymentToken, symbol, decimals: 18 } : await resolveToken(chainId, msg.paymentToken);
      return {
        ...base,
        kind: 'blur_order',
        owner: msg.trader,
        side: Number(msg.side) === 1 ? 'sell' : 'buy',
        collection: msg.collection,
        tokenId: big(msg.tokenId).toString(),
        token: payToken,
        price: formatAmount(big(msg.price), payToken),
        deadline: msg.expirationTime !== undefined ? formatDeadline(big(msg.expirationTime), nowSec) : undefined,
      };
    }
    if (td.primaryType === 'Root') return { ...base, kind: 'blur_bulk' };
  }

  return { ...base, kind: 'unknown_signature' };
}

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
async function swapToken(chainId: number | undefined, a: string, resolveToken: TokenResolver): Promise<TokenRef> {
  if (String(a).toLowerCase() === NATIVE) return { address: a, symbol: nativeSymbol(chainId), decimals: 18 };
  return resolveToken(chainId, a);
}
/** 1inch encodes addresses as uint256 ("Address" type); the address is the low 160 bits. */
function asAddr(v: unknown): string {
  const s = String(v);
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s;
  return '0x' + (big(s) & ((1n << 160n) - 1n)).toString(16).padStart(40, '0');
}
function zeroToUndef(a?: string): string | undefined {
  return !a || /^0x0{40}$/i.test(a) ? undefined : a;
}

const BLUR_POOL = '0x0000000000a39bb272e79075ade125fd351887ac';

/**
 * EIP-7702 account upgrade: the wallet asks you to sign an authorization that points your whole account at a
 * contract's code. Whoever wrote that contract can then move everything you own. Zero address undoes it.
 */
export function decodeDelegation(input: { chainId?: number; address: string }): Facts {
  return { kind: 'delegation', chainId: input.chainId, chain: chainName(input.chainId), spender: input.address, contract: input.address };
}
