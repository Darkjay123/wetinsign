export interface TokenRef {
  address: string;
  symbol?: string;
  decimals?: number;
  /** True when the contract says it is an ERC-721 NFT collection. approve() on it hands over one NFT, not an amount. */
  isNft?: boolean;
  /** Raw total supply, when the chain told us. An approval for more than exists is unlimited in practice. */
  totalSupply?: string;
}

// A small offline table of the stablecoins Nigerians actually hold. Anything else is
// looked up on-chain when a network connection is available, and shown as raw units if not.
const KNOWN: Record<string, { symbol: string; decimals: number }> = {
  '1:0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  '1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '56:0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18 },
  '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
  // Tron: USDT TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t (decimals and symbol read from the contract on 2026-10-06).
  '728126428:0xa614f803b6fd780986a42c78ec9c7f77e6ded13c': { symbol: 'USDT', decimals: 6 },
};

export function knownToken(chainId: number | undefined, address: string): TokenRef {
  const hit = chainId === undefined ? undefined : KNOWN[`${chainId}:${address.toLowerCase()}`];
  return hit ? { address, ...hit } : { address };
}
