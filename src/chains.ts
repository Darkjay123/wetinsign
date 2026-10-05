export interface Chain {
  id: number;
  name: string;
  nativeSymbol: string;
  defaultRpc: string;
}

// Public RPC defaults. Override any of them with RPC_<chainId> in the environment.
export const CHAINS: Record<number, Chain> = {
  1: { id: 1, name: 'Ethereum', nativeSymbol: 'ETH', defaultRpc: 'https://ethereum-rpc.publicnode.com' },
  56: { id: 56, name: 'BNB Smart Chain', nativeSymbol: 'BNB', defaultRpc: 'https://bsc-rpc.publicnode.com' },
  8453: { id: 8453, name: 'Base', nativeSymbol: 'ETH', defaultRpc: 'https://base-rpc.publicnode.com' },
  137: { id: 137, name: 'Polygon', nativeSymbol: 'POL', defaultRpc: 'https://polygon-bor-rpc.publicnode.com' },
  42161: { id: 42161, name: 'Arbitrum One', nativeSymbol: 'ETH', defaultRpc: 'https://arbitrum-one-rpc.publicnode.com' },
};

export function chainName(id?: number): string {
  if (id === undefined) return 'an unknown network';
  return CHAINS[id]?.name ?? `chain ${id}`;
}

export function rpcUrl(id: number): string | undefined {
  return process.env[`RPC_${id}`] ?? CHAINS[id]?.defaultRpc;
}
