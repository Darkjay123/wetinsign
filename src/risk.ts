import { looksLikeSweeper } from './bytecode.js';
import { knownDelegate, SCAM_DELEGATES, SWEEPER_CODE_HASHES } from './delegates.js';
import { drainerSet } from './drainers.js';
import type { Facts } from './facts.js';
import { trustedSpender } from './trusted.js';

export type Severity = 'danger' | 'warning' | 'safe' | 'info';

export interface Flag {
  code:
    | 'KNOWN_DRAINER'
    | 'UNLIMITED_APPROVAL'
    | 'NFT_APPROVE_ALL'
    | 'FREE_LISTING'
    | 'OFFCHAIN_SIGNATURE'
    | 'NEVER_EXPIRES'
    | 'SPENDER_NOT_CONTRACT'
    | 'UNREADABLE'
    | 'REVOKE'
    | 'IRREVERSIBLE'
    | 'OWNERSHIP_TRANSFER'
    | 'TRUSTED_SPENDER'
    | 'SPENDER_UNKNOWN'
    | 'NFT_APPROVE_ONE'
    | 'TAKES_NOW'
    | 'UNREADABLE_BATCH'
    | 'BATCH_APPROVALS'
    | 'FREE_SWAP'
    | 'RECEIVER_NOT_YOU'
    | 'RECEIVER_CHECK'
    | 'UNKNOWN_CONTRACT'
    | 'DELEGATION_UNKNOWN'
    | 'DELEGATION_SWEEPER'
    | 'DELEGATION_UNCHECKED'
    | 'DELEGATION_KNOWN'
    | 'DELEGATION'
    | 'ACCOUNT_TAKEOVER'
    | 'PERMISSION_SHARED'
    | 'PERMISSION_CHANGE'
    | 'TRON_ACTION'
    | 'SOL_OWNER_CHANGE'
    | 'TOKEN_OWNER_CHANGE'
    | 'CLOSE_AUTHORITY'
    | 'ASSET_SWEEP'
    | 'MULTI_SEND'
    | 'ACCOUNT_DELETE'
    | 'MASTER_DISABLED'
    | 'PULL_PERMISSION'
    | 'PRICE_UNKNOWN'
    | 'LEDGER_ACTION'
    | 'GUARDIAN_SET'
    | 'TRADING_AGENT'
    | 'HIGH_FEE'
    | 'SENDS_ALL';
  severity: Severity;
}

/** Addresses reported as drainers: our own list plus the Scam Sniffer feed. See src/drainers.ts. */
export function drainerList(): Set<string> {
  return drainerSet();
}

export interface RiskContext {
  /** From an on-chain code check. An approval to a wallet that is not a contract is a classic scam pattern. */
  spenderIsContract?: boolean;
  drainers?: Set<string>;
  /** EIP-7702: size and keccak256 of the code an account would be pointed at, read on-chain. */
  delegateCode?: { size: number; hash: string; code?: string };
}



export function assessRisk(f: Facts, ctx: RiskContext = {}): Flag[] {
  const flags: Flag[] = [];
  const bad = ctx.drainers ?? drainerList();
  const parties = [f.spender, f.recipient, f.contract].filter(Boolean).map((a) => a!.toLowerCase());
  if (parties.some((a) => bad.has(a)) || f.reportedScam) flags.push({ code: 'KNOWN_DRAINER', severity: 'danger' });
  // TON: several different assets to one address in one request is how TON drainer kits empty a wallet in one signature.
  if (f.sweep) flags.push({ code: 'ASSET_SWEEP', severity: 'danger' });
  else if ([607, 784, 637, 144, 397, 126, 508, 283].includes(f.chainId ?? 0) && f.via === 'batch' && (f.bundle ?? []).some((b) => b.spender && b.spender !== f.bundle![0].spender)) flags.push({ code: 'MULTI_SEND', severity: 'warning' });
  // Only from STON.fi's own router list (src/ton-trusted.ts).
  if (f.chainId === 607 && f.protocol === 'STON.fi' && !f.reportedScam) flags.push({ code: 'TRUSTED_SPENDER', severity: 'info' });

  // Several approvals in one wallet batch: a normal app swap needs at most one.
  const batchApprovals = f.via === 'batch' ? (f.bundle ?? []).filter((b) => /approve|permit2/.test(b.kind)).length : 0;
  if (batchApprovals >= 3) flags.push({ code: 'BATCH_APPROVALS', severity: 'danger' });
  else if (batchApprovals === 2) flags.push({ code: 'BATCH_APPROVALS', severity: 'warning' });

  switch (f.kind) {
    case 'erc20_approve':
    case 'permit':
    case 'permit2':
    {
      const trusted = !flags.some((x) => x.code === 'KNOWN_DRAINER') && trustedSpender(f.chainId, f.spender);
      if (f.amount?.raw === '0') flags.push({ code: 'REVOKE', severity: 'safe' });
      else if (f.amount?.unlimited) flags.push({ code: 'UNLIMITED_APPROVAL', severity: trusted ? 'warning' : 'danger' });
      if (trusted && f.amount?.raw !== '0') flags.push({ code: 'TRUSTED_SPENDER', severity: 'info' });
      // Drainers often ask for an exact amount (your whole balance) so wallets do not show an "unlimited" warning.
      // 10 of 34 real victim approvals we pulled from chain were like that, so a limited approval is never just "info".
      if (!trusted && f.amount?.raw !== '0' && !f.amount?.unlimited) flags.push({ code: 'SPENDER_UNKNOWN', severity: 'warning' });
      // Only signatures are off-chain. Permit2.approve() sent as a transaction is an ordinary on-chain call.
      if (f.primaryType) flags.push({ code: 'OFFCHAIN_SIGNATURE', severity: 'warning' });
      if (f.deadline?.never && f.amount?.raw !== '0') flags.push({ code: 'NEVER_EXPIRES', severity: 'warning' });
      if (ctx.spenderIsContract === false && f.amount?.raw !== '0') flags.push({ code: 'SPENDER_NOT_CONTRACT', severity: 'danger' });
      break;
    }
    case 'nft_approve': {
      const cleared = /^0x0{40}$/i.test(f.spender ?? '');
      if (cleared) flags.push({ code: 'REVOKE', severity: 'safe' });
      else flags.push({ code: 'NFT_APPROVE_ONE', severity: 'warning' });
      if (!cleared && ctx.spenderIsContract === false) flags.push({ code: 'SPENDER_NOT_CONTRACT', severity: 'danger' });
      break;
    }
    case 'permit2_transfer': {
      const trusted = !flags.some((x) => x.code === 'KNOWN_DRAINER') && trustedSpender(f.chainId, f.spender);
      const items = f.batch ?? (f.amount ? [{ amount: f.amount }] : []);
      if (items.some((i) => i.amount.unlimited)) flags.push({ code: 'UNLIMITED_APPROVAL', severity: trusted ? 'warning' : 'danger' });
      if (trusted) flags.push({ code: 'TRUSTED_SPENDER', severity: 'info' });
      else flags.push({ code: 'TAKES_NOW', severity: 'warning' });
      flags.push({ code: 'OFFCHAIN_SIGNATURE', severity: 'warning' });
      if (ctx.spenderIsContract === false) flags.push({ code: 'SPENDER_NOT_CONTRACT', severity: 'danger' });
      break;
    }
    case 'blur_order': {
      // Under 0.001 ETH for an NFT is a giveaway, not a sale. We cannot know a collection's real value, so above that we show the price.
      if (f.side === 'sell' && f.price && !f.price.unlimited && BigInt(f.price.raw) < 1_000_000_000_000_000n) flags.push({ code: 'FREE_LISTING', severity: 'danger' });
      flags.push({ code: 'OFFCHAIN_SIGNATURE', severity: 'warning' });
      break;
    }
    case 'blur_bulk':
      flags.push({ code: 'UNREADABLE_BATCH', severity: 'warning' }, { code: 'OFFCHAIN_SIGNATURE', severity: 'warning' });
      break;
    case 'swap_order': {
      const trusted = !flags.some((x) => x.code === 'KNOWN_DRAINER') && trustedSpender(f.chainId, f.spender);
      if (f.buyAmount?.raw === '0' && f.amount?.raw !== '0') flags.push({ code: 'FREE_SWAP', severity: 'danger' });
      const rec = f.recipient?.toLowerCase();
      // A warning, not danger: 1 of the first 6 real CoW Swap orders we pulled (USDT -> ETH, 6 Oct 2026, made in the
      // CoW Swap app) legitimately sent the proceeds to a different wallet. Fake swap sites do the same thing, so we say it loudly.
      if (rec && f.owner && rec !== f.owner.toLowerCase()) flags.push({ code: 'RECEIVER_NOT_YOU', severity: 'warning' });
      else if (rec && !f.owner) flags.push({ code: 'RECEIVER_CHECK', severity: 'warning' });
      if (trusted) flags.push({ code: 'TRUSTED_SPENDER', severity: 'info' });
      else flags.push({ code: 'UNKNOWN_CONTRACT', severity: 'warning' }, { code: 'OFFCHAIN_SIGNATURE', severity: 'warning' });
      if (f.deadline?.never) flags.push({ code: 'NEVER_EXPIRES', severity: 'warning' });
      break;
    }
    case 'delegation': {
      if (/^0x0{40}$/i.test(f.spender ?? '')) { flags.push({ code: 'REVOKE', severity: 'safe' }); break; }
      const code = ctx.delegateCode;
      const scam = flags.some((x) => x.code === 'KNOWN_DRAINER') || SCAM_DELEGATES.has((f.spender ?? '').toLowerCase()) || (code && SWEEPER_CODE_HASHES.has(code.hash.toLowerCase()));
      if (scam) { flags.push({ code: 'DELEGATION_SWEEPER', severity: 'danger' }); break; }
      if (trustedSpender(f.chainId, f.spender)) { flags.push({ code: 'DELEGATION', severity: 'warning' }, { code: 'TRUSTED_SPENDER', severity: 'info' }); break; }
      if (knownDelegate(f.chainId, f.spender)) { flags.push({ code: 'DELEGATION_KNOWN', severity: 'warning' }); break; }
      // Without reading the code we cannot tell a wallet from a sweeper, and the downside is the whole wallet.
      if (!code) flags.push({ code: 'DELEGATION_UNCHECKED', severity: 'danger' });
      else if (code.size === 0 || looksLikeSweeper(code.code ?? '0x', code.size)) flags.push({ code: 'DELEGATION_SWEEPER', severity: 'danger' });
      else flags.push({ code: 'DELEGATION_UNKNOWN', severity: 'warning' });
      break;
    }
    case 'ownership_transfer':
      flags.push({ code: 'OWNERSHIP_TRANSFER', severity: 'danger' });
      break;
    case 'nft_approve_all': {
      // Approving OpenSea's conduit once per collection is how every OpenSea listing starts, so it is a warning, not a scream.
      const trusted = !flags.some((x) => x.code === 'KNOWN_DRAINER') && trustedSpender(f.chainId, f.spender);
      if (f.approved) flags.push({ code: 'NFT_APPROVE_ALL', severity: trusted ? 'warning' : 'danger' });
      else flags.push({ code: 'REVOKE', severity: 'safe' });
      if (f.approved && trusted) flags.push({ code: 'TRUSTED_SPENDER', severity: 'info' });
      if (f.approved && ctx.spenderIsContract === false) flags.push({ code: 'SPENDER_NOT_CONTRACT', severity: 'danger' });
      break;
    }
    case 'seaport_order': {
      const owner = f.owner?.toLowerCase();
      const backToOwner = (f.consideration ?? []).filter((c) => c.recipient?.toLowerCase() === owner && c.amount.raw !== '0');
      // Paid back only dust in the network coin (under 0.001, same line as Blur) is a giveaway too: drainers add 1 wei
      // so the listing does not read as "free". Token payments keep their price, since we cannot judge their decimals here.
      const dustOnly = backToOwner.length > 0 && backToOwner.every((c) => c.itemType === 0) && backToOwner.reduce((s, c) => s + BigInt(c.amount.raw), 0n) < 1_000_000_000_000_000n;
      if ((f.offer?.length ?? 0) > 0 && (backToOwner.length === 0 || dustOnly)) flags.push({ code: 'FREE_LISTING', severity: 'danger' });
      flags.push({ code: 'OFFCHAIN_SIGNATURE', severity: 'warning' });
      break;
    }
    case 'transfer':
    case 'transfer_from':
    case 'native_send':
      flags.push({ code: 'IRREVERSIBLE', severity: 'info' });
      break;
    case 'tron_permission': {
      // The Tron multi-signature scam: a fake wallet, "airdrop" or "help desk" gets you to sign an AccountPermissionUpdate
      // that adds their key. If their key alone meets the threshold, the account is theirs and you can no longer move it.
      const ps = f.permission ?? [];
      // Danger only when their keys can act WITHOUT you. A 2-of-2 where neither side acts alone is how real shared wallets work.
      if (ps.some((p) => p.others.length && p.othersCanActAlone)) flags.push({ code: 'ACCOUNT_TAKEOVER', severity: 'danger' });
      else if (ps.some((p) => p.others.length)) flags.push({ code: 'PERMISSION_SHARED', severity: 'warning' });
      else flags.push({ code: 'PERMISSION_CHANGE', severity: 'info' });
      flags.push({ code: 'IRREVERSIBLE', severity: 'info' });
      break;
    }
    case 'tron_action':
      flags.push({ code: 'TRON_ACTION', severity: 'info' });
      break;
    case 'sol_authority':
      // SlowMist, Dec 2025: a victim signed a System Assign that moved their wallet's Owner to the attacker,
      // lost over $3 million and could no longer move or revoke anything. Token account owner changes are the same trick one level down.
      if (f.authority === 'wallet_owner') flags.push({ code: 'SOL_OWNER_CHANGE', severity: 'danger' }, { code: 'IRREVERSIBLE', severity: 'info' });
      else if (f.authority === 'token_owner') flags.push({ code: 'TOKEN_OWNER_CHANGE', severity: 'danger' }, { code: 'IRREVERSIBLE', severity: 'info' });
      else if (f.authority === 'close') flags.push({ code: 'CLOSE_AUTHORITY', severity: 'warning' });
      else flags.push({ code: 'PERMISSION_CHANGE', severity: 'info' });
      break;
    case 'account_control': {
      // XRPL SetRegularKey / SignerListSet, Aptos offer_signer_capability / offer_rotation_capability / key rotation:
      // each lets someone else sign for the whole account. The classic fake "support" and "wallet validation" scams.
      const c = f.control;
      if (c === 'signer_list') {
        const ps = f.permission ?? [];
        if (ps.some((p) => p.others.length && p.othersCanActAlone)) flags.push({ code: 'ACCOUNT_TAKEOVER', severity: 'danger' });
        else if (ps.some((p) => p.others.length)) flags.push({ code: 'PERMISSION_SHARED', severity: 'warning' });
        else flags.push({ code: 'PERMISSION_CHANGE', severity: 'info' });
      } else if (c === 'guardian') flags.push({ code: 'GUARDIAN_SET', severity: 'warning' });
      // Hyperliquid API wallet: trades for your whole account but cannot withdraw. Legit bots and front-ends use it,
      // phishing sites use it to trade your margin away. A warning, not a danger.
      else if (c === 'trading_agent') flags.push({ code: 'TRADING_AGENT', severity: 'warning' });
      else if (c === 'remove_key') flags.push({ code: 'PERMISSION_CHANGE', severity: 'info' });
      else if (c === 'account_delete') flags.push({ code: 'ACCOUNT_DELETE', severity: 'danger' }, { code: 'IRREVERSIBLE', severity: 'info' });
      else if (c === 'disable_master') flags.push({ code: 'MASTER_DISABLED', severity: 'warning' });
      else flags.push({ code: 'ACCOUNT_TAKEOVER', severity: 'danger' }, { code: 'IRREVERSIBLE', severity: 'info' });
      break;
    }
    case 'ledger_action': {
      const a = f.ledgerAction;
      if (a === 'nft_sell_free') flags.push({ code: 'FREE_LISTING', severity: 'danger' });
      else if (a === 'check') flags.push({ code: 'PULL_PERMISSION', severity: 'warning' });
      // Algorand asset close-to: sends every unit of that token and removes it from the account. Normal when
      // opting out of an empty token, so a warning that names where it all goes, not a danger.
      else if (a === 'close_out') flags.push({ code: 'SENDS_ALL', severity: 'warning' });
      else if (a === 'builder_fee') {
        // Hyperliquid caps builder fees at 0.1% on perps and 1% on spot. Anything above 0.1% is worth a second look.
        const pct = Number(String(f.feeRate ?? '').replace('%', ''));
        flags.push(Number.isFinite(pct) && pct > 0.1 ? { code: 'HIGH_FEE', severity: 'warning' } : { code: 'LEDGER_ACTION', severity: 'info' });
      }
      else if (a === 'app_deposit') flags.push({ code: 'UNKNOWN_CONTRACT', severity: 'warning' });
      else if (a === 'nft_accept' && !f.price) flags.push({ code: 'PRICE_UNKNOWN', severity: 'warning' });
      else if (a === 'nft_accept' || a === 'escrow') flags.push({ code: 'IRREVERSIBLE', severity: 'info' });
      else flags.push({ code: 'LEDGER_ACTION', severity: 'info' });
      break;
    }
    case 'unknown_call':
    case 'unknown_signature':
      flags.push({ code: 'UNREADABLE', severity: 'warning' });
      break;
  }
  return flags;
}

const ORDER: Severity[] = ['danger', 'warning', 'info', 'safe'];

export function verdict(flags: Flag[]): Severity {
  for (const s of ORDER) if (flags.some((f) => f.severity === s)) return s;
  return 'info';
}
