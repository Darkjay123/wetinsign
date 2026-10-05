import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Facts } from './facts.js';

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
    | 'IRREVERSIBLE';
  severity: Severity;
}

let drainers: Set<string> | undefined;

/** Addresses reported as drainers. Seeded from data/drainers.json; see data/README.md for sourcing. */
export function drainerList(): Set<string> {
  if (!drainers) {
    try {
      const file = fileURLToPath(new URL('../data/drainers.json', import.meta.url));
      const list: string[] = JSON.parse(readFileSync(file, 'utf8'));
      drainers = new Set(list.map((a) => a.toLowerCase()));
    } catch {
      drainers = new Set();
    }
  }
  return drainers;
}

export interface RiskContext {
  /** From an on-chain code check. An approval to a wallet that is not a contract is a classic scam pattern. */
  spenderIsContract?: boolean;
  drainers?: Set<string>;
}

export function assessRisk(f: Facts, ctx: RiskContext = {}): Flag[] {
  const flags: Flag[] = [];
  const bad = ctx.drainers ?? drainerList();
  const parties = [f.spender, f.recipient, f.contract].filter(Boolean).map((a) => a!.toLowerCase());
  if (parties.some((a) => bad.has(a))) flags.push({ code: 'KNOWN_DRAINER', severity: 'danger' });

  switch (f.kind) {
    case 'erc20_approve':
    case 'permit':
    case 'permit2':
      if (f.amount?.raw === '0') flags.push({ code: 'REVOKE', severity: 'safe' });
      else if (f.amount?.unlimited) flags.push({ code: 'UNLIMITED_APPROVAL', severity: 'danger' });
      if (f.kind !== 'erc20_approve') flags.push({ code: 'OFFCHAIN_SIGNATURE', severity: 'warning' });
      if (f.deadline?.never && f.amount?.raw !== '0') flags.push({ code: 'NEVER_EXPIRES', severity: 'warning' });
      if (ctx.spenderIsContract === false && f.amount?.raw !== '0') flags.push({ code: 'SPENDER_NOT_CONTRACT', severity: 'danger' });
      break;
    case 'nft_approve_all':
      if (f.approved) flags.push({ code: 'NFT_APPROVE_ALL', severity: 'danger' });
      else flags.push({ code: 'REVOKE', severity: 'safe' });
      if (f.approved && ctx.spenderIsContract === false) flags.push({ code: 'SPENDER_NOT_CONTRACT', severity: 'danger' });
      break;
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
