import type { Facts } from './facts.js';
import type { Amount } from './format.js';
import type { TokenRef } from './tokens.js';

/**
 * Hyperliquid (HyperCore). Money-moving and permission actions are EIP-712 "user signed actions" with
 * domain name "HyperliquidSignTransaction" and primaryType "HyperliquidTransaction:<Action>".
 * Field lists from hyperliquid-dex/hyperliquid-python-sdk utils/signing.py (read 7 Oct 2026).
 * 1337 is the chain id Hyperliquid uses for its own L1 actions; we use it as the network id.
 */
export const HL_ID = 1337;
const USDC: TokenRef = { address: 'USDC', symbol: 'USDC', decimals: 6 };
const group = (s: string) => { const [i, f] = s.split('.'); return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : ''); };
const amt = (s: unknown): Amount | undefined => (typeof s === 'string' && /^\d+(\.\d+)?$/.test(s) ? { raw: s, display: group(s), unlimited: false } : undefined);
const addr = (s: unknown) => (typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : undefined);
/** Spot tokens are named "PURR:0xc1fb593aeffbeb02f85e0308e9956a90"; the part before ":" is the ticker. */
const tok = (t: unknown): TokenRef => (typeof t === 'string' && t ? { address: t, symbol: t.split(':')[0] || t } : USDC);

export const isHyperliquid = (td: any) => td?.domain?.name === 'HyperliquidSignTransaction' && /^HyperliquidTransaction:/.test(td?.primaryType ?? '');

export function hyperliquidFacts(td: any, signer?: string): Facts {
  const type = String(td.primaryType).split(':')[1];
  const m = td.message ?? {};
  const base: Facts = { kind: 'unknown_signature', chainId: HL_ID, chain: 'Hyperliquid', primaryType: td.primaryType, appName: 'Hyperliquid', ...(signer ? { from: signer.toLowerCase(), owner: signer.toLowerCase() } : {}) };
  if (m.hyperliquidChain && m.hyperliquidChain !== 'Mainnet') base.chain = `Hyperliquid ${String(m.hyperliquidChain).slice(0, 20)}`;
  switch (type) {
    case 'Withdraw':
      return { ...base, kind: 'transfer', token: USDC, amount: amt(m.amount), recipient: addr(m.destination), protocol: 'withdraw' };
    case 'UsdSend':
      return { ...base, kind: 'transfer', token: USDC, amount: amt(m.amount), recipient: addr(m.destination) };
    case 'SpotSend':
    case 'SendAsset':
      return { ...base, kind: 'transfer', token: tok(m.token), amount: amt(m.amount), recipient: addr(m.destination) };
    case 'ApproveAgent':
      // An "API wallet": it can place and cancel trades for your whole account (it cannot withdraw).
      return { ...base, kind: 'account_control', control: 'trading_agent', spender: addr(m.agentAddress), ...(m.agentName ? { memo: String(m.agentName).slice(0, 60) } : {}) };
    case 'ApproveBuilderFee':
      return { ...base, kind: 'ledger_action', ledgerAction: 'builder_fee', spender: addr(m.builder), feeRate: typeof m.maxFeeRate === 'string' ? m.maxFeeRate.slice(0, 12) : undefined };
    case 'UsdClassTransfer':
      return { ...base, kind: 'ledger_action', ledgerAction: 'internal_move', token: USDC, amount: amt(String(m.amount ?? '').split(' ')[0]) };
    case 'TokenDelegate':
      return { ...base, kind: 'ledger_action', ledgerAction: m.isUndelegate ? 'cancel' : 'stake', spender: addr(m.validator) };
    case 'UserDexAbstraction':
    case 'UserSetAbstraction':
      return { ...base, kind: 'ledger_action', ledgerAction: 'settings' };
    case 'ConvertToMultiSigUser': {
      // After this, the listed users (not your key) control the account, by threshold.
      let s: any; try { s = JSON.parse(m.signers); } catch { s = undefined; }
      const users: string[] = Array.isArray(s?.authorizedUsers) ? s.authorizedUsers.map((u: unknown) => String(u).toLowerCase()) : [];
      const threshold = Number(s?.threshold ?? 0);
      const me = signer?.toLowerCase();
      const others = users.filter((u) => u !== me);
      return { ...base, kind: 'account_control', control: 'signer_list', permission: [{ scope: 'owner', threshold, yourWeight: me && users.includes(me) ? 1 : 0, others, othersCanActAlone: others.length > 0 && others.length >= threshold }] };
    }
    default:
      return base;
  }
}
