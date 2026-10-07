import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import algosdk from 'algosdk';
import { algoFacts, fromIndexer, parseAlgo, type AlgoLookup } from '../src/algorand.js';
import { assessRisk, verdict } from '../src/risk.js';
import { explain } from '../src/explain.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/algo-real.json', import.meta.url), 'utf8'));
const lookup: AlgoLookup = { asset: async (id) => ({ symbol: `T${id.slice(0, 3)}`, decimals: 6 }) };
const run = async (txs: any, l: 'en' | 'pcm' = 'en') => { const f = await algoFacts(txs, lookup); const flags = assessRisk(f); return { f, flags, v: verdict(flags), x: await explain(f, flags, l) }; };
const me = algosdk.generateAccount().addr, thief = algosdk.generateAccount().addr;
const sp = { fee: 1000n, firstValid: 1n, lastValid: 1000n, genesisHash: new Uint8Array(32), genesisID: 'mainnet-v1.0', minFee: 1000n, flatFee: true } as any;
const b64 = (t: algosdk.Transaction) => Buffer.from(algosdk.encodeUnsignedTransaction(t)).toString('base64');

describe('Algorand (real mainnet transactions)', () => {
  it('plain payment is info with the amount in ALGO', async () => {
    const r = await run([fromIndexer(fx.pay)!]);
    expect(r.f.kind).toBe('native_send');
    expect(r.f.token?.symbol).toBe('ALGO');
    expect(r.v).not.toBe('danger');
  });
  it('close-remainder-to is a danger: everything goes out', async () => {
    const r = await run([fromIndexer(fx.close)!]);
    expect(r.f.control).toBe('account_delete');
    expect(r.f.recipient).toBe(fx.close['payment-transaction']['close-remainder-to']);
    expect(r.v).toBe('danger');
  });
  it('a real rekeyed app call is a takeover', async () => {
    const r = await run([fromIndexer(fx.rekey)!], 'pcm');
    expect(r.f.control).toBe('rekey');
    expect(r.v).toBe('danger');
    expect(r.x.text).toMatch(/rekey/);
  });
  it('asset transfer reads the token', async () => {
    const r = await run([fromIndexer(fx.axfer)!]);
    expect(r.f.kind).toBe('transfer');
    expect(r.f.amount?.display).toMatch(/\d/);
  });
});

describe('Algorand wallet requests (algosdk-encoded)', () => {
  it('decodes WalletConnect [{ txn }] and catches a rekey hidden in a group', async () => {
    const pay = algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: me, receiver: thief, amount: 1000n, suggestedParams: sp });
    const rk = algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: me, receiver: me, amount: 0n, rekeyTo: thief, suggestedParams: sp });
    const txs = parseAlgo([[{ txn: b64(pay) }, { txn: b64(rk) }]])!;
    expect(txs.length).toBe(2);
    const r = await run(txs);
    expect(r.f.control).toBe('rekey');
    expect(r.f.spender).toBe(thief.toString());
    expect(r.v).toBe('danger');
  });
  it('rekeying back to yourself is not a takeover', async () => {
    const rk = algosdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: me, receiver: me, amount: 0n, rekeyTo: me, suggestedParams: sp });
    expect((await run(parseAlgo(b64(rk))!)).v).not.toBe('danger');
  });
  it('USDC + ALGO + another token to one address is a sweep', async () => {
    const t1 = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: me, receiver: thief, amount: 5_000_000n, assetIndex: 31566704, suggestedParams: sp });
    const t2 = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: me, receiver: thief, amount: 1n, assetIndex: 312769, suggestedParams: sp });
    const r = await run(parseAlgo(JSON.stringify([b64(t1), b64(t2)]))!);
    expect(r.f.sweep?.assets).toEqual(['USDC', 'USDt']);
    expect(r.v).toBe('danger');
  });
  it('asset opt-in is a setup step', async () => {
    const t = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: me, receiver: me, amount: 0n, assetIndex: 31566704, suggestedParams: sp });
    const r = await run(parseAlgo(b64(t))!);
    expect(r.f.ledgerAction).toBe('setup');
    expect(r.v).toBe('info');
  });
  it('asset close-to is a warning naming where it all goes', async () => {
    const t = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: me, receiver: thief, amount: 0n, assetIndex: 31566704, closeRemainderTo: thief, suggestedParams: sp });
    const r = await run(parseAlgo(b64(t))!);
    expect(r.f.ledgerAction).toBe('close_out');
    expect(r.v).toBe('warning');
    expect(r.x.text).toMatch(/ALL your USDC/);
  });
});
