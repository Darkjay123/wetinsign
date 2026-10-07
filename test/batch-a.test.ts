import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeTypedData } from '../src/decode.js';
import { assessRisk, verdict } from '../src/risk.js';
import { explain } from '../src/explain.js';
import { mvxFacts, toErd, fromErd, mvxData, type MvxLookup } from '../src/multiversx.js';
import { aptosFacts, MOVEMENT_NET } from '../src/aptos.js';
import { CHAINS } from '../src/chains.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/mvx-real.json', import.meta.url), 'utf8'));
const lookup: MvxLookup = { token: async (id) => ({ 'FOXSY-5d5f3e': { ticker: 'FOXSY', decimals: 18 }, 'TMLA-08844c': { ticker: 'TMLA' }, 'XPORTALS3-020487': { ticker: 'XPORTALS3' } } as any)[id] };
const run = async (f: any, l: 'en' | 'pcm' = 'en') => { const flags = assessRisk(f); return { f, flags, v: verdict(flags), x: await explain(f, flags, l) }; };
const HL = (type: string, message: Record<string, unknown>) => ({ domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 421614, verifyingContract: '0x0000000000000000000000000000000000000000' }, primaryType: `HyperliquidTransaction:${type}`, types: {}, message: { hyperliquidChain: 'Mainnet', signatureChainId: '0x66eee', ...message } });
const ME = '0x1111111111111111111111111111111111111111', BAD = '0x2222222222222222222222222222222222222222';

describe('networks added 7 Oct', () => {
  it('lists Step Network, Movement, MultiversX and Hyperliquid', () => {
    for (const id of [1234, 126, 508, 1337]) expect(CHAINS[id]).toBeTruthy();
  });
});

describe('MultiversX (real mainnet transactions)', () => {
  it('bech32 round-trips', () => {
    const a = fx.native.sender;
    expect(toErd(fromErd(a)!)).toBe(a);
    expect(fromErd(a.slice(0, -1) + (a.endsWith('q') ? 'p' : 'q'))).toBeUndefined();
  });
  it('reads base64 data', () => expect(mvxData(fx.ESDTTransfer.data)).toMatch(/^ESDTTransfer@/));
  it('ESDTTransfer reads token and amount', async () => {
    const r = await run(await mvxFacts([fx.ESDTTransfer], lookup));
    expect(r.f.kind).toBe('transfer');
    expect(r.f.token?.symbol).toBe('FOXSY');
    expect(r.f.amount?.display).toMatch(/^[\d,]+(\.\d+)?$/);
    expect(r.v).not.toBe('danger');
  });
  it('SetGuardian is a warning naming the guardian', async () => {
    const r = await run(await mvxFacts([fx.SetGuardian], lookup));
    expect(r.f.control).toBe('guardian');
    expect(r.f.spender).toMatch(/^erd1/);
    expect(r.v).toBe('warning');
    expect(r.x.text).toMatch(/guardian/);
  });
  it('ChangeOwnerAddress on a contract is a danger', async () => {
    const r = await run(await mvxFacts([fx.ChangeOwnerAddress], lookup));
    expect(r.f.kind).toBe('ownership_transfer');
    expect(r.v).toBe('danger');
  });
  it('NFT transfer goes to the destination in the data, not the receiver field', async () => {
    const r = await run(await mvxFacts([fx.ESDTNFTTransfer], lookup));
    expect(r.f.kind).toBe('transfer');
    expect(r.f.recipient).toMatch(/^erd1/);
    expect(r.f.recipient).not.toBe(fx.ESDTNFTTransfer.receiver);
  });
  it('three NFTs of one collection to one wallet is not a sweep', async () => {
    const r = await run(await mvxFacts([fx.multi], lookup));
    expect(r.f.sweep).toBeUndefined();
    expect(r.v).not.toBe('danger');
  });
  it('several different tokens to one wallet is a sweep (danger)', async () => {
    const to = fromErd(fx.native.sender)!;
    const h = (s: string) => Buffer.from(s).toString('hex');
    const data = `MultiESDTNFTTransfer@${to}@03@${h('WEGLD-bd4d79')}@00@0de0b6b3a7640000@${h('USDC-c76f1f')}@00@05f5e100@${h('MEX-455c57')}@00@01`;
    const r = await run(await mvxFacts([{ receiver: fx.native.receiver, sender: fx.native.receiver, value: '0', data }], lookup), 'pcm');
    expect(r.f.sweep?.assets.length).toBe(3);
    expect(r.v).toBe('danger');
  });
  it('plain EGLD send with a note keeps the note verbatim', async () => {
    const r = await run(await mvxFacts([fx.native], lookup));
    expect(r.f.kind).toBe('native_send');
    expect(r.f.amount?.display).toBe('0.0001');
    expect(r.f.memo).toBeTruthy();
  });
});

describe('Hyperliquid signed actions (official SDK field layout)', () => {
  it('withdraw names amount and destination', async () => {
    const r = await run(await decodeTypedData(HL('Withdraw', { destination: BAD, amount: '2500.5', time: 1 }) as any, undefined, undefined, ME));
    expect(r.f.chain).toBe('Hyperliquid');
    expect(r.f.kind).toBe('transfer');
    expect(r.f.amount?.display).toBe('2,500.5');
    expect(r.f.recipient).toBe(BAD);
  });
  it('spot send reads the ticker', async () => {
    const f = await decodeTypedData(HL('SpotSend', { destination: BAD, token: 'PURR:0xc1fb593aeffbeb02f85e0308e9956a90', amount: '10', time: 1 }) as any);
    expect(f.token?.symbol).toBe('PURR');
  });
  it('approve agent is a warning, not danger', async () => {
    const r = await run(await decodeTypedData(HL('ApproveAgent', { agentAddress: BAD, agentName: 'bot', nonce: 1 }) as any), 'pcm');
    expect(r.f.control).toBe('trading_agent');
    expect(r.v).toBe('warning');
    expect(r.x.text).toMatch(/trade/);
  });
  it('builder fee above 0.1% is a warning, 0.05% is info', async () => {
    expect((await run(await decodeTypedData(HL('ApproveBuilderFee', { maxFeeRate: '1%', builder: BAD, nonce: 1 }) as any))).v).toBe('warning');
    expect((await run(await decodeTypedData(HL('ApproveBuilderFee', { maxFeeRate: '0.05%', builder: BAD, nonce: 1 }) as any))).v).toBe('info');
  });
  it('converting to a multisig run by others is a takeover', async () => {
    const signers = JSON.stringify({ authorizedUsers: [BAD, '0x3333333333333333333333333333333333333333'], threshold: 1 });
    const r = await run(await decodeTypedData(HL('ConvertToMultiSigUser', { signers, nonce: 1 }) as any, undefined, undefined, ME));
    expect(r.v).toBe('danger');
  });
  it('moving between your own spot and perps is info', async () => {
    const r = await run(await decodeTypedData(HL('UsdClassTransfer', { amount: '100', toPerp: true, nonce: 1 }) as any));
    expect(r.v).toBe('info');
  });
});

describe('Movement (Aptos framework)', () => {
  it('names MOVE and Movement', async () => {
    const f = await aptosFacts({ function: '0x1::aptos_account::transfer', typeArguments: [], functionArguments: ['0xabc', '150000000'] }, {}, undefined, MOVEMENT_NET);
    expect(f.chain).toBe('Movement');
    expect(f.token?.symbol).toBe('MOVE');
    expect(f.amount?.display).toBe('1.5');
  });
  it('signer capability offer is danger on Movement too', async () => {
    const f = await aptosFacts({ function: '0x1::account::offer_signer_capability', typeArguments: [], functionArguments: ['0x00', 0, '0x00', '0xbad'] }, {}, undefined, MOVEMENT_NET);
    expect(verdict(assessRisk(f))).toBe('danger');
  });
});
