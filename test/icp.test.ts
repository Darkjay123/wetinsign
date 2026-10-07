import { describe, expect, it } from 'vitest';
import { IDL } from '@dfinity/candid';
import { Principal } from '@dfinity/principal';
import fx from './fixtures/icp-real.json';
import { ApproveArgs, fetchIcpTx, icpFacts, isCanister, parseIcp, TransferArg, type IcpLookup } from '../src/icp.js';
import { assessRisk, verdict } from '../src/risk.js';

const F = fx as any;
const lk = (row: any): IcpLookup => ({ tx: async () => row, ledger: async () => undefined });
const judge = (f: any) => { const flags = assessRisk(f, { spenderIsContract: isCanister(f.spender) }); return { codes: flags.map((x) => x.code), v: verdict(flags) }; };
const CKBTC = 'mxzaz-hqaaa-aaaar-qaada-cai';
const approveReq = (row: any, amount: bigint, spender = row.spender_owner) => ({
  method: 'icrc49_call_canister',
  params: { canisterId: CKBTC, sender: row.from_owner, method: 'icrc2_approve', arg: Buffer.from(IDL.encode([ApproveArgs], [{ from_subaccount: [], spender: { owner: Principal.fromText(spender), subaccount: [] }, amount, expected_allowance: [], expires_at: [], fee: [], memo: [], created_at_time: [] }])).toString('base64') },
});

describe('Internet Computer', () => {
  it('reads a real ICP ledger send by hash', async () => {
    const r = F.icp.send;
    const f = await fetchIcpTx(r.transaction_hash, lk(r));
    expect(f.kind).toBe('native_send');
    expect(f.recipient).toBe(r.to_account_identifier);
    expect(judge(f).v).not.toBe('danger');
  });
  it('reads a real ICP ledger approve by hash', async () => {
    const r = F.icp.approve;
    const f = await fetchIcpTx(r.transaction_hash, lk(r));
    expect(f.kind).toBe('erc20_approve');
    expect(f.spender).toBe(r.spender_account_identifier);
  });
  it('the real ckBTC approve (to the ckBTC minter canister, fields from the ledger) is not danger', async () => {
    const r = F.ckbtc.approve;
    const f = await icpFacts(parseIcp(approveReq(r, BigInt(r.amount)))!, {});
    expect(f.token?.symbol).toBe('ckBTC');
    expect(f.amount?.display).toBe(`${Number(r.amount) / 1e8}`.replace(/^0\./, '0.'));
    expect(isCanister(f.spender)).toBe(true);
    expect(judge(f).v).not.toBe('danger');
  });
  it('an approval to an ordinary wallet principal is danger', async () => {
    const r = F.ckbtc.approve;
    const wallet = F.ckbtc.transfer.to_owner ?? 'dgjbk-47vw4-mbhjr-fqqfv-ukhs2-tww5i-jc2hy-ildjq-wgdui-knhwe-aae';
    const f = await icpFacts(parseIcp(approveReq(r, 10n ** 40n, wallet))!, {});
    expect(isCanister(wallet)).toBe(false);
    const j = judge(f);
    expect(j.codes).toContain('SPENDER_NOT_CONTRACT');
    expect(j.codes).toContain('UNLIMITED_APPROVAL');
    expect(j.v).toBe('danger');
  });
  it('reads icrc1_transfer from a bare { canisterId, method, arg }', async () => {
    const r = F.ckbtc.transfer;
    const arg = IDL.encode([TransferArg], [{ from_subaccount: [], to: { owner: Principal.fromText(r.to_owner), subaccount: [] }, amount: BigInt(r.amount), fee: [], memo: [], created_at_time: [] }]);
    const f = await icpFacts(parseIcp({ canisterId: CKBTC, method: 'icrc1_transfer', arg: Buffer.from(arg).toString('hex') })!, {});
    expect(f.kind).toBe('transfer');
    expect(f.recipient).toBe(r.to_owner);
  });
  it('rejects requests without Candid', () => {
    expect(parseIcp({ canisterId: CKBTC, method: 'icrc1_transfer', arg: 'hello' })).toBeUndefined();
  });
});
