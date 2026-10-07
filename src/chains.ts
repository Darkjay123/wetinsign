export interface Chain {
  id: number;
  name: string;
  nativeSymbol: string;
  /** Public RPCs, tried in order. Each answered eth_chainId with this id on 2026-10-06 (chain list: chainid.network). */
  rpcs: string[];
  explorer: string;
  /** Decimals of the native coin. 18 unless set (TRX has 6). */
  nativeDecimals?: number;
  /** @deprecated first of rpcs */
  defaultRpc?: string;
}

// Every EVM network WetinSign reads. Override the RPC with RPC_<chainId> in the environment.
export const CHAINS: Record<number, Chain> = {
  1: { id: 1, name: "Ethereum", nativeSymbol: "ETH", rpcs: ["https://ethereum-rpc.publicnode.com", "https://cloudflare-eth.com", "https://mainnet.gateway.tenderly.co"], explorer: "https://etherscan.io" },
  56: { id: 56, name: "BNB Smart Chain", nativeSymbol: "BNB", rpcs: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed1.bnbchain.org", "https://bsc-dataseed2.bnbchain.org"], explorer: "https://bscscan.com" },
  8453: { id: 8453, name: "Base", nativeSymbol: "ETH", rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org/", "https://developer-access-mainnet.base.org/"], explorer: "https://basescan.org" },
  137: { id: 137, name: "Polygon", nativeSymbol: "POL", rpcs: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org", "https://rpc-mainnet.matic.quiknode.pro"], explorer: "https://polygonscan.com" },
  369: { id: 369, name: "PulseChain", nativeSymbol: "PLS", rpcs: ["https://pulsechain-rpc.publicnode.com", "https://rpc.pulsechain.com", "https://rpc-pulsechain.g4mm4.io"], explorer: "https://ipfs.scan.pulsechain.com" },
  25: { id: 25, name: "Cronos", nativeSymbol: "CRO", rpcs: ["https://cronos-evm-rpc.publicnode.com", "https://evm.cronos.org", "https://cronos.drpc.org"], explorer: "https://explorer.cronos.org" },
  43114: { id: 43114, name: "Avalanche", nativeSymbol: "AVAX", rpcs: ["https://avalanche-c-chain-rpc.publicnode.com", "https://api.avax.network/ext/bc/C/rpc"], explorer: "https://snowscan.xyz" },
  999: { id: 999, name: "HyperEVM", nativeSymbol: "HYPE", rpcs: ["https://rpc.hyperliquid.xyz/evm", "https://hyperliquid-json-rpc.stakely.io"], explorer: "https://hyperevmscan.io" },
  143: { id: 143, name: "Monad", nativeSymbol: "MON", rpcs: ["https://rpc.monad.xyz", "https://rpc1.monad.xyz", "https://monad-mainnet.drpc.org"], explorer: "https://monadvision.com" },
  42161: { id: 42161, name: "Arbitrum One", nativeSymbol: "ETH", rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"], explorer: "https://arbiscan.io" },
  57073: { id: 57073, name: "Ink", nativeSymbol: "ETH", rpcs: ["https://rpc-gel.inkonchain.com", "https://rpc-qnd.inkonchain.com"], explorer: "https://explorer.inkonchain.com" },
  146: { id: 146, name: "Sonic", nativeSymbol: "S", rpcs: ["https://sonic-rpc.publicnode.com", "https://rpc.soniclabs.com", "https://sonic.drpc.org"], explorer: "https://sonicscan.org" },
  480: { id: 480, name: "World Chain", nativeSymbol: "ETH", rpcs: ["https://worldchain-mainnet.g.alchemy.com/public", "https://480.rpc.thirdweb.com", "https://worldchain-mainnet.gateway.tenderly.co"], explorer: "https://worldscan.org" },
  295: { id: 295, name: "Hedera", nativeSymbol: "HBAR", rpcs: ["https://mainnet.hashio.io/api", "https://hedera.linkpool.pro"], explorer: "https://explorer.arkhia.io" },
  2741: { id: 2741, name: "Abstract", nativeSymbol: "ETH", rpcs: ["https://api.mainnet.abs.xyz"], explorer: "https://abscan.org" },
  10: { id: 10, name: "Optimism", nativeSymbol: "ETH", rpcs: ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io", "https://optimism.gateway.tenderly.co"], explorer: "https://optimistic.etherscan.io" },
  988: { id: 988, name: "Stable", nativeSymbol: "USDT0", rpcs: ["https://rpc.stable.xyz"], explorer: "https://stablescan.xyz" },
  9745: { id: 9745, name: "Plasma", nativeSymbol: "XPL", rpcs: ["https://rpc.plasma.to"], explorer: "https://plasmascan.to" },
  1329: { id: 1329, name: "Sei", nativeSymbol: "SEI", rpcs: ["https://evm-rpc.sei-apis.com"], explorer: "https://seiscan.io" },
  4326: { id: 4326, name: "MegaETH", nativeSymbol: "ETH", rpcs: ["https://mainnet.megaeth.com/rpc"], explorer: "https://mega.etherscan.io" },
  59144: { id: 59144, name: "Linea", nativeSymbol: "ETH", rpcs: ["https://linea-rpc.publicnode.com", "https://rpc.linea.build"], explorer: "https://lineascan.build" },
  5000: { id: 5000, name: "Mantle", nativeSymbol: "MNT", rpcs: ["https://mantle-rpc.publicnode.com", "https://rpc.mantle.xyz"], explorer: "https://mantlescan.xyz" },
  81457: { id: 81457, name: "Blast", nativeSymbol: "ETH", rpcs: ["https://blast-rpc.publicnode.com", "https://rpc.blast.io"], explorer: "https://blastscan.io" },
  80094: { id: 80094, name: "Berachain", nativeSymbol: "BERA", rpcs: ["https://berachain-rpc.publicnode.com", "https://rpc.berachain.com", "https://rpc.berachain-apis.com"], explorer: "https://berascan.com" },
  204: { id: 204, name: "opBNB", nativeSymbol: "BNB", rpcs: ["https://opbnb-rpc.publicnode.com", "https://opbnb-mainnet-rpc.bnbchain.org", "https://opbnb-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3"], explorer: "https://mainnet.opbnbscan.com" },
  324: { id: 324, name: "zkSync Era", nativeSymbol: "ETH", rpcs: ["https://mainnet.era.zksync.io", "https://zksync.drpc.org"], explorer: "https://explorer.zksync.io" },
  33139: { id: 33139, name: "ApeChain", nativeSymbol: "APE", rpcs: ["https://rpc.apechain.com"], explorer: "https://apescan.io" },
  250: { id: 250, name: "Fantom", nativeSymbol: "FTM", rpcs: ["https://fantom.drpc.org"], explorer: "https://ftmscan.com" },
  1088: { id: 1088, name: "Metis", nativeSymbol: "METIS", rpcs: ["https://metis-rpc.publicnode.com", "https://andromeda.metis.io/?owner=1088", "https://metis.drpc.org"], explorer: "https://andromeda-explorer.metis.io" },
  130: { id: 130, name: "Unichain", nativeSymbol: "ETH", rpcs: ["https://unichain-rpc.publicnode.com", "https://mainnet.unichain.org"], explorer: "https://uniscan.xyz" },
  42220: { id: 42220, name: "Celo", nativeSymbol: "CELO", rpcs: ["https://forno.celo.org"], explorer: "https://celoscan.io" },
  4337: { id: 4337, name: "Beam", nativeSymbol: "BEAM", rpcs: ["https://build.onbeam.com/rpc", "https://subnets.avax.network/beam/mainnet/rpc"], explorer: "https://subnets.avax.network/beam" },
  1868: { id: 1868, name: "Soneium", nativeSymbol: "ETH", rpcs: ["https://rpc.soneium.org"], explorer: "https://soneium.blockscout.com" },
  1030: { id: 1030, name: "Conflux eSpace", nativeSymbol: "CFX", rpcs: ["https://evm.confluxrpc.com"], explorer: "https://evm.confluxscan.net" },
  747: { id: 747, name: "Flow EVM", nativeSymbol: "FLOW", rpcs: ["https://mainnet.evm.nodes.onflow.org"], explorer: "https://evm.flowscan.io" },
  4200: { id: 4200, name: "Merlin Chain", nativeSymbol: "BTC", rpcs: ["https://rpc.merlinchain.io"], explorer: "https://scan.merlinchain.io" },
  534352: { id: 534352, name: "Scroll", nativeSymbol: "ETH", rpcs: ["https://scroll-rpc.publicnode.com", "https://rpc.scroll.io"], explorer: "https://scrollscan.com" },
  2222: { id: 2222, name: "Kava", nativeSymbol: "KAVA", rpcs: ["https://kava-evm-rpc.publicnode.com", "https://evm.kava.io", "https://evm.kava-rpc.com"], explorer: "https://kavascan.com" },
  747474: { id: 747474, name: "Katana", nativeSymbol: "ETH", rpcs: ["https://rpc.katana.network", "https://katana.gateway.tenderly.co/", "https://rpc.katanarpc.com/"], explorer: "https://katanascan.com" },
  14: { id: 14, name: "Flare", nativeSymbol: "FLR", rpcs: ["https://flare-api.flare.network/ext/C/rpc", "https://rpc.ankr.com/flare"], explorer: "https://flare-explorer.flare.network" },
  122: { id: 122, name: "Fuse", nativeSymbol: "FUSE", rpcs: ["https://rpc.fuse.io", "https://fuse.drpc.org"], explorer: "https://explorer.fuse.io" },
  1514: { id: 1514, name: "Story", nativeSymbol: "IP", rpcs: ["https://mainnet.storyrpc.io"], explorer: "https://www.storyscan.io" },
  169: { id: 169, name: "Manta Pacific", nativeSymbol: "ETH", rpcs: ["https://pacific-rpc.manta.network/http", "https://manta-pacific.drpc.org"], explorer: "https://pacific-explorer.manta.network" },
  40: { id: 40, name: "Telos", nativeSymbol: "TLOS", rpcs: ["https://rpc.telos.net", "https://telos.drpc.org"], explorer: "https://teloscan.io" },
  1776: { id: 1776, name: "Injective EVM", nativeSymbol: "INJ", rpcs: ["https://sentry.evm-rpc.injective.network", "https://injectiveevm-rpc.polkachu.com"], explorer: "https://blockscout.injective.network" },
  4663: { id: 4663, name: "Robinhood Chain", nativeSymbol: "ETH", rpcs: ["https://robinhood-rpc.publicnode.com", "https://rpc.mainnet.chain.robinhood.com/rpc", "https://rpc.mainnet.chain.robinhood.com"], explorer: "https://robinscan.io" },
  5042: { id: 5042, name: "Arc", nativeSymbol: "USDC", rpcs: ["https://rpc.mainnet.arc.io", "https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.drpc.mainnet.arc.io"], explorer: "https://explorer.arc.io" },
  728126428: { id: 728126428, name: "Tron", nativeSymbol: "TRX", nativeDecimals: 6, rpcs: ["https://api.trongrid.io/jsonrpc"], explorer: "https://tronscan.org" },
  // Solana is not EVM; src/solana.ts reads it. 501 is its SLIP-44 coin type.
  501: { id: 501, name: "Solana", nativeSymbol: "SOL", nativeDecimals: 9, rpcs: ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"], explorer: "https://solscan.io" },
  // TON is not EVM; src/ton.ts reads it. 607 is its SLIP-44 coin type.
  607: { id: 607, name: "TON", nativeSymbol: "TON", nativeDecimals: 9, rpcs: ["https://toncenter.com/api/v3"], explorer: "https://tonviewer.com" },
  // Sui, Aptos and the XRP Ledger are not EVM; src/sui.ts, src/aptos.ts and src/xrpl.ts read them. IDs are SLIP-44 coin types.
  784: { id: 784, name: "Sui", nativeSymbol: "SUI", nativeDecimals: 9, rpcs: ["https://graphql.mainnet.sui.io/graphql"], explorer: "https://suiscan.xyz/mainnet" },
  637: { id: 637, name: "Aptos", nativeSymbol: "APT", nativeDecimals: 8, rpcs: ["https://api.mainnet.aptoslabs.com/v1"], explorer: "https://explorer.aptoslabs.com" },
  // NEAR is not EVM; src/near.ts reads it. 397 is its SLIP-44 coin type.
  397: { id: 397, name: "NEAR", nativeSymbol: "NEAR", nativeDecimals: 24, rpcs: ["https://archival-rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"], explorer: "https://nearblocks.io" },
  // Step Network (Avalanche subnet, FITFI). rpc.step.network refused TLS on 7 Oct 2026; thirdweb's answered eth_chainId 0x4d2.
  1234: { id: 1234, name: "Step Network", nativeSymbol: "FITFI", rpcs: ["https://1234.rpc.thirdweb.com", "https://rpc.step.network"], explorer: "https://stepscan.io" },
  // Movement uses the Aptos node API (src/aptos.ts). Its node reports chain_id 126.
  126: { id: 126, name: "Movement", nativeSymbol: "MOVE", nativeDecimals: 8, rpcs: ["https://mainnet.movementnetwork.xyz/v1"], explorer: "https://explorer.movementnetwork.xyz" },
  // MultiversX is not EVM; src/multiversx.ts reads it. 508 is EGLD's SLIP-44 coin type.
  508: { id: 508, name: "MultiversX", nativeSymbol: "EGLD", nativeDecimals: 18, rpcs: ["https://api.multiversx.com"], explorer: "https://explorer.multiversx.com" },
  // Hyperliquid's own exchange (HyperCore). Users sign EIP-712 actions (src/hyperliquid.ts); there is no hash to look up.
  1337: { id: 1337, name: "Hyperliquid", nativeSymbol: "USDC", nativeDecimals: 6, rpcs: [], explorer: "https://app.hyperliquid.xyz/explorer" },
  // Algorand is not EVM; src/algorand.ts reads it. 283 is ALGO's SLIP-44 coin type.
  283: { id: 283, name: "Algorand", nativeSymbol: "ALGO", nativeDecimals: 6, rpcs: ["https://mainnet-idx.algonode.cloud/v2"], explorer: "https://allo.info" },
  // Stacks is not EVM; src/stacks.ts reads it. 5757 is STX's SLIP-44 coin type.
  5757: { id: 5757, name: "Stacks", nativeSymbol: "STX", nativeDecimals: 6, rpcs: ["https://api.hiro.so"], explorer: "https://explorer.hiro.so" },
  // Starknet is not EVM; src/starknet.ts reads it. 9004 is STRK's SLIP-44 coin type.
  // Cardano is not EVM; src/cardano.ts reads it (UTxO, CBOR via CIP-30). 1815 is ADA's SLIP-44 coin type.
  // Internet Computer is not EVM; src/icp.ts reads ICRC-1/ICRC-2 canister calls. 223 is ICP's SLIP-44 coin type.
  223: { id: 223, name: "Internet Computer", nativeSymbol: "ICP", nativeDecimals: 8, rpcs: ["https://icp-api.io"], explorer: "https://dashboard.internetcomputer.org" },
  1815: { id: 1815, name: "Cardano", nativeSymbol: "ADA", nativeDecimals: 6, rpcs: ["https://api.koios.rest/api/v1"], explorer: "https://cardanoscan.io" },
  9004: { id: 9004, name: "Starknet", nativeSymbol: "STRK", nativeDecimals: 18, rpcs: ["https://starknet-rpc.publicnode.com"], explorer: "https://voyager.online" },
  144: { id: 144, name: "XRP Ledger", nativeSymbol: "XRP", nativeDecimals: 6, rpcs: ["https://xrplcluster.com"], explorer: "https://livenet.xrpl.org" },
};

export function chainName(id?: number): string {
  if (id === undefined) return 'an unknown network';
  return CHAINS[id]?.name ?? `chain ${id}`;
}

export function rpcUrls(id: number): string[] {
  const env = process.env[`RPC_${id}`];
  return [...(env ? [env] : []), ...(CHAINS[id]?.rpcs ?? [])];
}
export function rpcUrl(id: number): string | undefined {
  return rpcUrls(id)[0];
}
export function nativeSymbol(id?: number): string {
  return (id !== undefined && CHAINS[id]?.nativeSymbol) || 'ETH';
}
