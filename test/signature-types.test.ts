import { describe, expect, it } from 'vitest';
import { decodeTypedData } from '../src/decode.js';
import { templateText } from '../src/explain.js';
import { assessRisk, verdict } from '../src/risk.js';

// Built from the published type definitions (Uniswap permit2 SignatureTransfer, Blur Exchange Order).
// These are made-up messages, not real victims: we have not yet found a real drain of these two types on Ethereum.
const none = { drainers: new Set<string>() };
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const FRESH = '0x1234567890abcdef1234567890abcdef12345678';
const domain = { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 };
const TokenPermissions = [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }];

const transfer = (spender: string, amount: string) => ({
  types: {
    PermitTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
    TokenPermissions,
  },
  primaryType: 'PermitTransferFrom',
  domain,
  message: { permitted: { token: USDT, amount }, spender, nonce: '1', deadline: '1893456000' },
});

describe('Permit2 one-time transfer signatures', () => {
  it('drainer style: exact amount to a fresh address with no code is danger', async () => {
    const f = await decodeTypedData(transfer(FRESH, '2500000000'));
    expect(f.kind).toBe('permit2_transfer');
    expect(f.amount?.display).toBe('2,500');
    const flags = assessRisk(f, { ...none, spenderIsContract: false });
    expect(flags.map((x) => x.code)).toEqual(expect.arrayContaining(['TAKES_NOW', 'SPENDER_NOT_CONTRACT']));
    expect(verdict(flags)).toBe('danger');
    expect(templateText(f, flags, 'en')).toContain('take 2,500 USDT out of your wallet right away');
  });

  it('even without the code check it is never called fine', async () => {
    const f = await decodeTypedData(transfer(FRESH, '2500000000'));
    expect(verdict(assessRisk(f, none))).toBe('warning');
  });

  it('a UniswapX swap is careful, not danger', async () => {
    const td = {
      types: {
        PermitWitnessTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'ExclusiveDutchOrder' }],
        TokenPermissions,
        ExclusiveDutchOrder: [{ name: 'decayStartTime', type: 'uint256' }],
      },
      primaryType: 'PermitWitnessTransferFrom',
      domain,
      message: { permitted: { token: USDT, amount: '100000000' }, spender: '0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4', nonce: '9', deadline: '1893456000', witness: { decayStartTime: '1' } },
    };
    const f = await decodeTypedData(td);
    const flags = assessRisk(f, { ...none, spenderIsContract: true });
    expect(flags.map((x) => x.code)).toContain('TRUSTED_SPENDER');
    expect(verdict(flags)).toBe('warning');
    expect(templateText(f, flags, 'pcm')).toContain('UniswapX');
  });

  it('reads every token in a batch', async () => {
    const td = {
      types: { PermitBatchTransferFrom: [{ name: 'permitted', type: 'TokenPermissions[]' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }], TokenPermissions },
      primaryType: 'PermitBatchTransferFrom',
      domain,
      message: { permitted: [{ token: USDT, amount: '5000000' }, { token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', amount: '7000000' }], spender: FRESH, nonce: '2', deadline: '1893456000' },
    };
    const f = await decodeTypedData(td);
    expect(f.batch?.length).toBe(2);
    expect(templateText(f, assessRisk(f, none), 'en')).toContain('5 USDT, 7 USDC');
  });
});

describe('Blur signatures', () => {
  const blurDomain = { name: 'Blur Exchange', version: '1.0', chainId: 1, verifyingContract: '0x000000000000Ad05Ccc4F10045630fb830B95127' };
  const order = (price: string, side = 1) => ({
    types: { Order: [{ name: 'trader', type: 'address' }] },
    primaryType: 'Order',
    domain: blurDomain,
    message: { trader: FRESH, side, matchingPolicy: FRESH, collection: FRESH, tokenId: '42', amount: '1', paymentToken: '0x0000000000000000000000000000000000000000', price, listingTime: '1', expirationTime: '1893456000', fees: [], salt: '1', extraParams: '0x', nonce: '0' },
  });

  it('a listing for nothing is danger', async () => {
    const f = await decodeTypedData(order('0'));
    const flags = assessRisk(f, none);
    expect(f.kind).toBe('blur_order');
    expect(verdict(flags)).toBe('danger');
    expect(templateText(f, flags, 'en')).toContain('NFT #42');
  });

  it('a listing for dust is danger', async () => {
    expect(verdict(assessRisk(await decodeTypedData(order('1000')), none))).toBe('danger');
  });

  it('a priced listing shows the price and is only careful', async () => {
    const f = await decodeTypedData(order('250000000000000000'));
    const flags = assessRisk(f, none);
    expect(verdict(flags)).toBe('warning');
    expect(templateText(f, flags, 'en')).toContain('0.25 ETH');
  });

  it('a bulk Root says plainly that it cannot show the listings', async () => {
    const f = await decodeTypedData({ types: { Root: [{ name: 'root', type: 'bytes32' }] }, primaryType: 'Root', domain: blurDomain, message: { root: '0x' + '11'.repeat(32) } } as any);
    const flags = assessRisk(f, none);
    expect(f.kind).toBe('blur_bulk');
    expect(verdict(flags)).toBe('warning');
    expect(templateText(f, flags, 'en')).toContain('does not show which NFTs');
  });
});

describe('EIP-7702 wallet batches', () => {
  it('a batch with one approval is careful and says it is a batch', async () => {
    const { encodeAbiParameters, encodeFunctionData, parseAbi, maxUint256 } = await import('viem');
    const approve = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), args: [PERMIT2, 5_000_000n] });
    const exec = encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }], [[{ target: USDT, value: 0n, callData: approve }]]);
    const data = encodeFunctionData({ abi: parseAbi(['function execute(bytes32,bytes)']), args: [('0x01' + '00'.repeat(31)) as `0x${string}`, exec] });
    const { decodeCall } = await import('../src/decode.js');
    const f = await decodeCall({ chainId: 1, to: FRESH, data });
    expect(f.via).toBe('batch');
    const flags = assessRisk(f, none);
    expect(flags.map((x) => x.code)).not.toContain('BATCH_APPROVALS');
    expect(templateText(f, flags, 'en')).toContain('wallet batch');
    void maxUint256;
  });
});
