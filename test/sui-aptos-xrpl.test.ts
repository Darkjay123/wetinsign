import { readFileSync } from 'node:fs';
import { encode } from 'ripple-binary-codec';
import { describe, expect, it } from 'vitest';
import { aptosFacts, type AptosLookup } from '../src/aptos.js';
import { explain } from '../src/explain.js';
import { assessRisk, verdict } from '../src/risk.js';
import { createApp } from '../src/server.js';
import { suiFacts, type SuiChanges } from '../src/sui.js';
import { parseXrplText, xrplFacts, type XrplTx } from '../src/xrpl.js';

const memStore = () => { const m = new Map<string, unknown>(); return { get: async (k: string) => m.get(k), put: async (k: string, v: unknown) => void m.set(k, v), count: async () => m.size }; };
const post = async (app: ReturnType<typeof createApp>, path: string, body: object) => (await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const v = (f: Parameters<typeof assessRisk>[0]) => verdict(assessRisk(f));
const en = async (f: Parameters<typeof assessRisk>[0]) => (await explain(f, assessRisk(f), 'en')).text;

// Real XRPL transactions read from xrplcluster.com on 6 Oct 2026.
const xr = JSON.parse(readFileSync(new URL('./fixtures/xrpl-real.json', import.meta.url), 'utf8')) as Record<string, { hash: string; tx: XrplTx }>;
const ME = 'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY';
const THIEF = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

describe('XRP Ledger', () => {
  it('reads real payments, trades, trust lines and cheques without crying wolf', async () => {
    const xrp = await xrplFacts(xr.Payment_XRP.tx);
    expect(xrp.kind).toBe('native_send');
    expect(xrp.destinationTag).toBe('379588');
    expect(await en(xrp)).toMatch(/Destination tag: 379588/);
    const rlusd = await xrplFacts(xr.Payment_IOU.tx);
    expect(rlusd.token?.symbol).toBe('RLUSD');
    for (const k of ['Payment_XRP', 'Payment_IOU', 'OfferCreate', 'TrustSet', 'AccountSet', 'TicketCreate', 'OfferCancel', 'NFTokenCreateOffer', 'NFTokenCancelOffer', 'CheckCash']) {
      expect(v(await xrplFacts(xr[k].tx)), k).not.toBe('danger');
    }
    const offer = await xrplFacts(xr.OfferCreate.tx);
    expect(await en(offer)).toMatch(/0\.1116 BTC for 9,592\.86813 RLUSD/);
    const check = await xrplFacts(xr.CheckCreate.tx);
    expect(v(check)).toBe('warning');
    expect(await en(check)).toMatch(/pull up to 1,681\.412642 XRP/);
  });

  it('reads the price of a real accepted NFT offer from the transaction record', async () => {
    const f = await xrplFacts(xr.NFTokenAcceptOffer.tx);
    expect(f.price).toBeDefined();
    expect(v(f)).not.toBe('danger');
  });

  it('stops the SetRegularKey "wallet validation" scam, but not removing a key', async () => {
    const f = await xrplFacts({ TransactionType: 'SetRegularKey', Account: ME, RegularKey: THIEF });
    expect(v(f)).toBe('danger');
    expect(await en(f)).toMatch(/can sign for your XRP Ledger account/);
    expect((await explain(f, assessRisk(f), 'pcm')).text).toMatch(/No sign am|Only sign am/);
    expect(v(await xrplFacts({ TransactionType: 'SetRegularKey', Account: ME }))).toBe('info');
  });

  it('signer lists: danger only when others can act without you', async () => {
    const alone = await xrplFacts({ TransactionType: 'SignerListSet', Account: ME, SignerQuorum: 1, SignerEntries: [{ SignerEntry: { Account: THIEF, SignerWeight: 1 } }] });
    expect(v(alone)).toBe('danger');
    const shared = await xrplFacts({ TransactionType: 'SignerListSet', Account: ME, SignerQuorum: 2, SignerEntries: [{ SignerEntry: { Account: THIEF, SignerWeight: 1 } }, { SignerEntry: { Account: 'rGWrZyQqhTp9Xu7G5Pkayo7bXjH4k4QYpf', SignerWeight: 0 } }] });
    expect(v(shared)).toBe('warning');
  });

  it('flags AccountDelete, a free NFT sell offer and a Batch that sweeps two assets to one address', async () => {
    expect(v(await xrplFacts({ TransactionType: 'AccountDelete', Account: ME, Destination: THIEF }))).toBe('danger');
    const free = await xrplFacts({ TransactionType: 'NFTokenCreateOffer', Account: ME, NFTokenID: '00'.repeat(32), Amount: '0', Flags: 1 });
    expect(v(free)).toBe('danger');
    expect(await en(free)).toMatch(/free-listing/);
    const batch = await xrplFacts({ TransactionType: 'Batch', Account: ME, RawTransactions: [
      { RawTransaction: { TransactionType: 'Payment', Account: ME, Destination: THIEF, Amount: '5000000000' } },
      { RawTransaction: { TransactionType: 'Payment', Account: ME, Destination: THIEF, Amount: { currency: '524C555344000000000000000000000000000000', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', value: '900' } } },
    ] });
    expect(batch.sweep?.assets.sort()).toEqual(['RLUSD', 'XRP']);
    expect(await en(batch)).toMatch(/XRP Ledger drainers/);
  });

  it('accepts the signed hex blob and the JSON through the API', async () => {
    const t: any = { ...xr.Payment_XRP.tx, Amount: xr.Payment_XRP.tx.DeliverMax ?? xr.Payment_XRP.tx.Amount };
    for (const k of ['DeliverMax', '__meta', 'hash', 'ctid', 'date', 'ledger_index', 'inLedger']) delete t[k];
    const blob = encode(t);
    expect(parseXrplText(blob)?.TransactionType).toBe('Payment');
    const app = createApp({ store: memStore() });
    const r = await post(app, '/api/explain/call', { data: blob });
    expect(r.facts.chain).toBe('XRP Ledger');
    const scam = await post(app, '/api/explain/call', { transaction: { TransactionType: 'SetRegularKey', Account: ME, RegularKey: THIEF }, lang: 'pcm' });
    expect(scam.explanation.verdict).toBe('danger');
  });
});

// Aptos payloads in the wallet-adapter shape, using 0x1 framework function signatures.
const SITE = '0x' + 'be'.repeat(32);
const alook: AptosLookup = { fa: async (m) => (m === '0x' + '357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b' ? { symbol: 'USDt', decimals: 6 } : undefined) };
describe('Aptos', () => {
  it('reads APT and fungible-asset sends', async () => {
    const apt = await aptosFacts({ function: '0x1::aptos_account::transfer', typeArguments: [], functionArguments: [SITE, '150000000'] });
    expect(apt.kind).toBe('native_send');
    expect(apt.amount?.display).toBe('1.5');
    expect(v(apt)).toBe('info');
    const usdt = await aptosFacts({ function: '0x1::primary_fungible_store::transfer', typeArguments: ['0x1::fungible_asset::Metadata'], functionArguments: [{ inner: '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b' }, SITE, '25000000'] }, alook);
    expect(usdt.token?.symbol).toBe('USDt');
    expect(await en(usdt)).toMatch(/sending 25 USDt/);
  });

  it('stops offer_signer_capability and offer_rotation_capability', async () => {
    for (const fn of ['0x1::account::offer_signer_capability', '0x1::account::offer_rotation_capability']) {
      const f = await aptosFacts({ function: fn, typeArguments: [], functionArguments: ['0xabcd', 0, '0x1234', SITE] });
      expect(f.spender).toBe(SITE);
      expect(v(f)).toBe('danger');
      expect(await en(f)).toMatch(/lock you out/);
    }
    expect(v(await aptosFacts({ function: '0x1::account::revoke_any_signer_capability', typeArguments: [], functionArguments: [] }))).toBe('info');
  });

  it('warns on an app call it cannot read, naming the function, and works through the API', async () => {
    const f = await aptosFacts({ function: '0xdeadbeef::claim::airdrop', typeArguments: [], functionArguments: [] });
    expect(v(f)).toBe('warning');
    expect(await en(f)).toMatch(/It calls 0xdeadbeef::claim::airdrop/);
    const app = createApp({ store: memStore() });
    const r = await post(app, '/api/explain/call', { data: JSON.stringify({ data: { function: '0x1::account::offer_signer_capability', functionArguments: ['0x', 0, '0x', SITE] } }) });
    expect(r.explanation.verdict).toBe('danger');
  });
});

// Sui: a real node dry-run (simulateTransaction) of a 0.001 SUI send, and a real swap from mainnet, 6 Oct 2026.
const su = JSON.parse(readFileSync(new URL('./fixtures/sui-real.json', import.meta.url), 'utf8'));
const S = '0x34729f8dd6d4e9bf5243b327c6462552a2d092808c537b9bbae7ee1a0e080a39';
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const slook = { coin: async (t: string) => (t === USDC ? { symbol: 'USDC', decimals: 6 } : undefined) };
describe('Sui', () => {
  it('reads a dry-run send and a real swap', async () => {
    const send = await suiFacts(su.send_simulated.changes, slook);
    expect(send.kind).toBe('native_send');
    expect(send.amount?.display).toBe('0.001');
    expect(v(send)).toBe('info');
    const swap = await suiFacts(su.swap.changes, slook);
    expect(swap.ledgerAction).toBe('swap');
    expect(v(swap)).not.toBe('danger');
  });

  it('stops a sweep of coins and an NFT kiosk to one address', async () => {
    const T = '0x' + 'ee'.repeat(32);
    const ch: SuiChanges = { sender: S, status: 'SUCCESS', balances: [
      { address: S, coinType: '0x2::sui::SUI', amount: '-120000000000' }, { address: T, coinType: '0x2::sui::SUI', amount: '119990000000' },
      { address: S, coinType: USDC, amount: '-800000000' }, { address: T, coinType: USDC, amount: '800000000' },
    ], moved: [{ from: S, to: T, type: '0x2::kiosk::KioskOwnerCap' }] };
    const f = await suiFacts(ch, slook);
    expect(f.sweep?.assets).toEqual(expect.arrayContaining(['SUI', 'USDC', 'your NFT kiosk (every NFT inside it)']));
    expect(v(f)).toBe('danger');
    expect(await en(f)).toMatch(/Sui drainers/);
  });

  it('looks up a digest through the API', async () => {
    const app = createApp({ store: memStore(), suiLookup: { ...slook, tx: async (d) => (d === su.swap.digest ? su.swap.changes : undefined) } });
    const r = await post(app, '/api/explain/tx', { chainId: 'auto', hash: su.swap.digest });
    expect(r.facts.chain).toBe('Sui');
  });
});
