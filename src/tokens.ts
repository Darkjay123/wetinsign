export interface TokenRef {
  address: string;
  symbol?: string;
  decimals?: number;
  /** True when the contract says it is an ERC-721 NFT collection. approve() on it hands over one NFT, not an amount. */
  isNft?: boolean;
}

// A small offline table of the stablecoins Nigerians actually hold. Anything else is
// looked up on-chain when a network connection is available, and shown as raw units if not.
const KNOWN: Record<string, { symbol: string; decimals: number }> = {
  '1:0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  '1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '56:0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18 },
  '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
};

export function knownToken(chainId: number | undefined, address: string): TokenRef {
  const hit = chainId === undefined ? undefined : KNOWN[`${chainId}:${address.toLowerCase()}`];
  return hit ? { address, ...hit } : { address };
}
