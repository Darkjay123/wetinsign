import { createPublicClient, http, parseAbi, type Hex, type PublicClient } from 'viem';
import { rpcUrl } from './chains.js';
import { knownToken, type TokenRef } from './tokens.js';
import type { CallInput, TokenResolver } from './decode.js';

const clients = new Map<number, PublicClient>();

function client(chainId: number): PublicClient {
  let c = clients.get(chainId);
  if (!c) {
    const url = rpcUrl(chainId);
    if (!url) throw new Error(`No RPC configured for chain ${chainId}`);
    c = createPublicClient({ transport: http(url, { timeout: 10_000 }) }) as PublicClient;
    clients.set(chainId, c);
  }
  return c;
}

const META_ABI = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function supportsInterface(bytes4 id) view returns (bool)']);
const ERC721_ID = '0x80ac58cd';

/** Token symbol and decimals: offline table first, then the chain. Unknown fields stay unknown. */
export const onchainResolver: TokenResolver = async (chainId, address): Promise<TokenRef> => {
  const known = knownToken(chainId, address);
  if (known.symbol || chainId === undefined || !/^0x[0-9a-fA-F]{40}$/.test(address)) return known;
  const c = client(chainId);
  const [symbol, decimals] = await Promise.all([
    c.readContract({ address: address as Hex, abi: META_ABI, functionName: 'symbol' }).catch(() => undefined),
    c.readContract({ address: address as Hex, abi: META_ABI, functionName: 'decimals' }).catch(() => undefined),
  ]);
  let isNft: boolean | undefined;
  if (decimals === undefined) {
    isNft = (await c.readContract({ address: address as Hex, abi: META_ABI, functionName: 'supportsInterface', args: [ERC721_ID] }).catch(() => false)) as boolean;
  }
  return { address, symbol: symbol as string | undefined, decimals: decimals === undefined ? undefined : Number(decimals), ...(isNft ? { isNft } : {}) };
};

export async function fetchTransaction(chainId: number, hash: string): Promise<CallInput> {
  const tx = await client(chainId).getTransaction({ hash: hash as Hex });
  if (!tx.to) throw new Error('This transaction created a contract; there is nothing to approve or send.');
  return { chainId, to: tx.to, data: tx.input, value: tx.value };
}

export async function isContract(chainId: number | undefined, address?: string): Promise<boolean | undefined> {
  if (chainId === undefined || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  try {
    const code = await client(chainId).getCode({ address: address as Hex });
    return !!code && code !== '0x';
  } catch {
    return undefined;
  }
}
