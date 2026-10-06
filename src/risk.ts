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
    | 'TRON_ACTION';
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
  if (parties.some((a) => bad.has(a))) flags.push({ code: 'KNOWN_DRAINER', severity: 'danger' });

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
      if ((f.offer?.length ?? 0) > 0 && backToOwner.length === 0) flags.push({ code: 'FREE_LISTING', severity: 'danger' });
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
