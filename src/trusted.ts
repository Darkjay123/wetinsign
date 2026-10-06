// Official contracts that everyday users approve as a normal step. Generated from Uniswap's deployments feed
// (developers.uniswap.org/deployments.json, Uniswap/contracts @ a677c0d, generated 2026-09-22).
// Being on this list never overrides a drainer match, and signatures that name some OTHER spender are judged normally.
const ROWS: Array<[number, string, string]> = [
  [1, '0x000000000022D473030F116dDEE9F6B43aC78BA3', 'Uniswap Permit2'],
  [42161, '0x000000000022D473030F116dDEE9F6B43aC78BA3', 'Uniswap Permit2'],
  [8453, '0x000000000022D473030F116dDEE9F6B43aC78BA3', 'Uniswap Permit2'],
  [56, '0x000000000022D473030F116dDEE9F6B43aC78BA3', 'Uniswap Permit2'],
  [137, '0x000000000022D473030F116dDEE9F6B43aC78BA3', 'Uniswap Permit2'],
  [1, '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af', 'Uniswap Universal Router'],
  [42161, '0x96b2FD2F80e9428Daa65d859653117D453981AB4', 'Uniswap Universal Router'],
  [8453, '0x6fF5693b99212Da76ad316178A184AB56D299b43', 'Uniswap Universal Router'],
  [56, '0x91BF3bfAEf8D771A74E1A8fE460b3EE646b2e588', 'Uniswap Universal Router'],
  [137, '0xE27610fD9dD05FC061366bc9dA414CA6F948f204', 'Uniswap Universal Router'],
  [1, '0xab863E752Bf67D8DCDD929EaAe9Be9dc83Fb3BbB', 'Uniswap Universal Router'],
  [1, '0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85', 'Uniswap Universal Router'],
  [42161, '0x2d01411773c8C24805306E89A41F7855C3c4Fe65', 'Uniswap Universal Router'],
  [8453, '0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40', 'Uniswap Universal Router'],
  [56, '0xDc264714F68d84CF29BC605589405E78bDBE7C9f', 'Uniswap Universal Router'],
  [137, '0xDc264714F68d84CF29BC605589405E78bDBE7C9f', 'Uniswap Universal Router'],
  [1, '0x4C82D1fBFe28C977cBB58D8C7FF8FCF9F70a2cCA', 'Uniswap Universal Router'],
  [42161, '0x8B844f885672f333Bc0042cB669255f93a4C1E6b', 'Uniswap Universal Router'],
  [8453, '0xFdf682F51FE81Aa4898F0AE2163d8A55c127fbC7', 'Uniswap Universal Router'],
  [56, '0x8B844f885672f333Bc0042cB669255f93a4C1E6b', 'Uniswap Universal Router'],
  [137, '0x8B844f885672f333Bc0042cB669255f93a4C1E6b', 'Uniswap Universal Router'],
  [8453, '0xF3A4F4094BD2c6C06cA2F61789d8727B8d1e7259', 'Uniswap Universal Router'],
  [8453, '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', 'Uniswap Universal Router'],
  // UniswapX order reactors: the spender in a normal UniswapX swap signature (same feed).
  [1, '0x00000011F84B9aa48e5f8aA8B9897600006289Be', 'UniswapX'],
  [42161, '0xB274d5F4b833b61B340b654d600A864fB604a87c', 'UniswapX'],
  [8453, '0x000000008a8330B5d1F43A62Bf4C673A49f27ba0', 'UniswapX'],
  [56, '0x00000000a55e50C71b70Db3C8B58749cd1E18eB2', 'UniswapX'],
  [8453, '0x000000001Ec5656dcdB24D90DFa42742738De729', 'UniswapX'],
  [1, '0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4', 'UniswapX'],
  // Aave V3 Pool: the spender when you deposit (supplyWithPermit) or repay (repayWithPermit) on Aave.
  // From Aave's official address book (github.com/bgd-labs/aave-address-book, POOL constants, read 2026-10-06).
  [1, '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', 'Aave V3 Pool'],
  [56, '0x6807dc923806fE8Fd134338EABCA509979a7e0cB', 'Aave V3 Pool'],
  [8453, '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', 'Aave V3 Pool'],
  [137, '0x794a61358D6845594F94dc1DB02A252b5b4814aD', 'Aave V3 Pool'],
  [42161, '0x794a61358D6845594F94dc1DB02A252b5b4814aD', 'Aave V3 Pool'],
  // CoW Protocol: GPv2VaultRelayer (what you approve to trade on CoW Swap) and GPv2Settlement.
  // From github.com/cowprotocol/contracts networks.json (read 2026-10-06).
  [1, '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110', 'CoW Protocol Vault Relayer'],
  [1, '0x9008D19f58AAbD9eD0D60971565AA8510560ab41', 'CoW Protocol Settlement'],
  [56, '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110', 'CoW Protocol Vault Relayer'],
  [56, '0x9008D19f58AAbD9eD0D60971565AA8510560ab41', 'CoW Protocol Settlement'],
  [8453, '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110', 'CoW Protocol Vault Relayer'],
  [8453, '0x9008D19f58AAbD9eD0D60971565AA8510560ab41', 'CoW Protocol Settlement'],
  [137, '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110', 'CoW Protocol Vault Relayer'],
  [137, '0x9008D19f58AAbD9eD0D60971565AA8510560ab41', 'CoW Protocol Settlement'],
  [42161, '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110', 'CoW Protocol Vault Relayer'],
  [42161, '0x9008D19f58AAbD9eD0D60971565AA8510560ab41', 'CoW Protocol Settlement'],
  // 1inch Aggregation Router v6 (also Limit Order Protocol v4). From github.com/1inch/limit-order-protocol README deployments table (read 2026-10-06).
  [1, '0x111111125421cA6dc452d289314280a0f8842A65', '1inch Router v6'],
  [56, '0x111111125421cA6dc452d289314280a0f8842A65', '1inch Router v6'],
  [8453, '0x111111125421cA6dc452d289314280a0f8842A65', '1inch Router v6'],
  [137, '0x111111125421cA6dc452d289314280a0f8842A65', '1inch Router v6'],
  [42161, '0x111111125421cA6dc452d289314280a0f8842A65', '1inch Router v6'],
  // OpenSea's Seaport conduit: what you approve once so OpenSea can transfer an NFT you list. From OPENSEA_CONDUIT_ADDRESS in
  // github.com/ProjectOpenSea/seaport-js src/constants.ts (read 2026-10-06). Same address on every chain.
  [1, '0x1E0049783F008A0085193E00003D00cd54003c71', 'OpenSea Conduit'],
  [56, '0x1E0049783F008A0085193E00003D00cd54003c71', 'OpenSea Conduit'],
  [8453, '0x1E0049783F008A0085193E00003D00cd54003c71', 'OpenSea Conduit'],
  [137, '0x1E0049783F008A0085193E00003D00cd54003c71', 'OpenSea Conduit'],
  [42161, '0x1E0049783F008A0085193E00003D00cd54003c71', 'OpenSea Conduit'],
  // EIP-7702 account code. MetaMask EIP7702StatelessDeleGatorImpl, deterministic deployment, from
  // github.com/MetaMask/delegation-framework documents/Deployments.md (read 2026-10-06).
  [1, '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B', 'MetaMask Smart Account'],
  [56, '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B', 'MetaMask Smart Account'],
  [8453, '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B', 'MetaMask Smart Account'],
  [137, '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B', 'MetaMask Smart Account'],
  [42161, '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B', 'MetaMask Smart Account'],
  // Uniswap Calibur v1.1.0, from the deployments table in github.com/Uniswap/calibur README (read 2026-10-06; Polygon not listed).
  [1, '0x000000005c84F8Fd50b21CAC312528A64437030e', 'Uniswap Wallet Calibur'],
  [56, '0x000000005c84F8Fd50b21CAC312528A64437030e', 'Uniswap Wallet Calibur'],
  [8453, '0x000000005c84F8Fd50b21CAC312528A64437030e', 'Uniswap Wallet Calibur'],
  [42161, '0x000000005c84F8Fd50b21CAC312528A64437030e', 'Uniswap Wallet Calibur'],
  // Coinbase Smart Wallet EIP7702Proxy, CREATE2 via the canonical factory so the same code on every chain; from the
  // deployments table in github.com/base/eip-7702-proxy README (read 2026-10-06).
  [1, '0x7702cb554e6bFb442cb743A7dF23154544a7176C', 'Coinbase Smart Wallet EIP-7702 proxy'],
  [56, '0x7702cb554e6bFb442cb743A7dF23154544a7176C', 'Coinbase Smart Wallet EIP-7702 proxy'],
  [8453, '0x7702cb554e6bFb442cb743A7dF23154544a7176C', 'Coinbase Smart Wallet EIP-7702 proxy'],
  [137, '0x7702cb554e6bFb442cb743A7dF23154544a7176C', 'Coinbase Smart Wallet EIP-7702 proxy'],
  [42161, '0x7702cb554e6bFb442cb743A7dF23154544a7176C', 'Coinbase Smart Wallet EIP-7702 proxy'],
];

const MAP = new Map(ROWS.map(([chainId, address, name]) => [`${chainId}:${address.toLowerCase()}`, name]));

export function trustedSpender(chainId: number | undefined, address: string | undefined): string | undefined {
  if (chainId === undefined || !address) return undefined;
  return MAP.get(`${chainId}:${address.toLowerCase()}`);
}

export interface TrustedInfo {
  name: string;
  protocol: string;
  /** What a normal user is doing when this contract asks for approval, in English and Pidgin. */
  use: string;
  usePcm: string;
}
export function trustedInfo(chainId: number | undefined, address: string | undefined): TrustedInfo | undefined {
  const name = trustedSpender(chainId, address);
  if (!name) return undefined;
  if (name.startsWith('Aave')) return { name, protocol: 'Aave', use: 'depositing or repaying a loan on Aave', usePcm: 'if you wan deposit or pay back loan for Aave' };
  if (name.startsWith('Coinbase')) return { name: 'Coinbase Smart Wallet', protocol: 'Coinbase Wallet', use: 'turning on Coinbase smart wallet features', usePcm: 'if you wan on Coinbase smart wallet' };
  if (name.startsWith('MetaMask')) return { name, protocol: 'MetaMask', use: 'turning on MetaMask smart account features', usePcm: 'if you wan on MetaMask smart account' };
  if (name.startsWith('Uniswap Wallet')) return { name, protocol: 'Uniswap Wallet', use: 'turning on Uniswap Wallet smart account features', usePcm: 'if you wan on Uniswap Wallet smart account' };
  if (name.startsWith('CoW')) return { name, protocol: 'CoW Swap', use: 'trading on CoW Swap', usePcm: 'if you wan trade for CoW Swap' };
  if (name.startsWith('1inch')) return { name, protocol: '1inch', use: 'swapping on 1inch', usePcm: 'if you wan swap for 1inch' };
  if (name.startsWith('OpenSea')) return { name, protocol: 'OpenSea', use: 'listing NFTs for sale on OpenSea', usePcm: 'if you wan list NFT for sale for OpenSea' };
  return { name, protocol: 'Uniswap', use: 'swapping on Uniswap', usePcm: 'if you wan swap for Uniswap' };
}
