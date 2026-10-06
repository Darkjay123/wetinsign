import { describe, expect, it } from 'vitest';
import { decodeDelegation } from '../src/decode.js';
import { assessRisk, verdict } from '../src/risk.js';
import { templateText } from '../src/explain.js';

const none = { drainers: new Set<string>() };
// Code read on-chain 6 Oct 2026: every CrimeEnjoyor deployment is the same 1,042 bytes.
const CRIME = { size: 1042, hash: '0xcff0edcc2dfd8d66bfbdb21739029900977274dfd6e73332e0272aa9bb40e7f1' };

// Real EIP-7702 sweeper contracts: verified on Etherscan/Blockscout under the name "CrimeEnjoyor", the copy-paste
// drainer Wintermute reported behind most 2025 delegations. Read from eth.blockscout.com search on 6 Oct 2026.
const SWEEPERS = [
  '0x9EA61f15CdbaF5D2039771381FA2AdCFb1b76321', '0xf3DF663c15710B98F83E48C010B9CD731aE345cA', '0x6AE436A71612c5875c4D322ee112BF34e64cD6E1',
  '0x349C41a8e164a243203605dBD07889d201174D77', '0xe38e81a06AdA5c4515a1FC8266AE470Da63c00b4', '0x58d3d5C02D2Ae360eae79823Cc87B81E673F1793',
  '0x68Ae6C736Ae31bBAb8D8b712cDc1f552e7De7351', '0x3220BF967f84160905E4d4326f7dBcd0a2f5a5Bf', '0x3549c7f6A9D712FD3007efC1B85E0C4acCA5c211',
  '0xb847F107513522Af770ee0AaD8dA0319e6da32b3', '0xfdEe40030641B66A6aF7a53eEedD4740fEdB761c',
];

describe('EIP-7702 account upgrades', () => {
  for (const a of SWEEPERS) {
    it(`real CrimeEnjoyor sweeper ${a.slice(0, 10)} is danger`, () => {
      const f = decodeDelegation({ chainId: 1, address: a });
      const fl = assessRisk(f, { ...none, delegateCode: CRIME });
      expect(fl.map((x) => x.code)).toContain('DELEGATION_SWEEPER');
      expect(verdict(fl)).toBe('danger');
    });
  }

  it('MetaMask smart account (official deployment) is a warning, not danger', () => {
    const f = decodeDelegation({ chainId: 1, address: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B' });
    const fl = assessRisk(f, none);
    expect(verdict(fl)).toBe('warning');
    expect(templateText(f, fl, 'en')).toContain('MetaMask');
  });

  it('Uniswap Calibur on Base is a warning, not danger', () => {
    const fl = assessRisk(decodeDelegation({ chainId: 8453, address: '0x000000005c84F8Fd50b21CAC312528A64437030e' }), none);
    expect(verdict(fl)).toBe('warning');
    expect(fl.map((x) => x.code)).toContain('TRUSTED_SPENDER');
  });

  // Real account code seen in live Ethereum delegations on 6 Oct 2026, none on our official list.
  for (const [name, addr, size] of [
    ['WalletCore', '0x69e6bd1C4082403Fc7917a61F6216552fC1a541D', 9768],
    ['Simple7702Account', '0xe6Cae83BdE06E4c305530e199D7217f42808555B', 3639],
    ['CaliburEntry (newer)', '0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00', 24504],
    ['Railgun RelayAdapt7702', '0x05ae73c5925d843864ae6F261f3175De2ebCd963', 17451],
  ] as const) {
    it(`real unrecognised wallet code ${name} is a warning, not danger`, () => {
      const f = decodeDelegation({ chainId: 1, address: addr });
      const fl = assessRisk(f, { ...none, delegateCode: { size, hash: '0x' + '11'.repeat(32) } });
      expect(fl.map((x) => x.code)).toContain('DELEGATION_UNKNOWN');
      expect(verdict(fl)).toBe('warning');
    });
  }

  it('Coinbase Smart Wallet proxy (official) is a trusted warning', () => {
    const fl = assessRisk(decodeDelegation({ chainId: 8453, address: '0x7702cb554e6bFb442cb743A7dF23154544a7176C' }), none);
    expect(fl.map((x) => x.code)).toEqual(['DELEGATION', 'TRUSTED_SPENDER']);
  });

  it('code we could not read is danger', () => {
    const fl = assessRisk(decodeDelegation({ chainId: 1, address: '0x490Aac77c960B0569C8E446aC7E12490bD44Ca1D' }), none);
    expect(fl.map((x) => x.code)).toContain('DELEGATION_UNCHECKED');
    expect(verdict(fl)).toBe('danger');
  });

  it('an address with no code at all is danger', () => {
    const fl = assessRisk(decodeDelegation({ chainId: 1, address: '0x1111111111111111111111111111111111111111' }), { ...none, delegateCode: { size: 0, hash: '0x' } });
    expect(verdict(fl)).toBe('danger');
  });

  it('pointing the account at zero undoes the upgrade', () => {
    const f = decodeDelegation({ chainId: 1, address: '0x0000000000000000000000000000000000000000' });
    const fl = assessRisk(f, none);
    expect(verdict(fl)).toBe('safe');
    expect(templateText(f, fl, 'pcm')).toContain('normal wallet');
  });

  it('a sweeper on the drainer list says STOP', () => {
    const f = decodeDelegation({ chainId: 1, address: SWEEPERS[0] });
    const fl = assessRisk(f, { drainers: new Set([SWEEPERS[0].toLowerCase()]) });
    expect(templateText(f, fl, 'en')).toMatch(/^STOP/);
  });
});
