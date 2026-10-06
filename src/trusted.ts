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
];

const MAP = new Map(ROWS.map(([chainId, address, name]) => [`${chainId}:${address.toLowerCase()}`, name]));

export function trustedSpender(chainId: number | undefined, address: string | undefined): string | undefined {
  if (chainId === undefined || !address) return undefined;
  return MAP.get(`${chainId}:${address.toLowerCase()}`);
}
