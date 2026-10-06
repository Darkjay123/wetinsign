import { formatUnits } from 'viem';
import type { TokenRef } from './tokens.js';

export const UINT160_MAX = (1n << 160n) - 1n;
export const UINT48_MAX = (1n << 48n) - 1n;

export interface Amount {
  raw: string;
  display: string;
  unlimited: boolean;
  /** Set when the amount is finite but more than the token's whole supply. */
  moreThanSupply?: boolean;
}

export interface Deadline {
  unix: string;
  display: string;
  never: boolean;
}

function groupThousands(s: string): string {
  const [int, frac] = s.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/** Turn a raw on-chain integer into something a person can read. Never rounds silently. */
export function formatAmount(raw: bigint, token?: Pick<TokenRef, 'decimals' | 'totalSupply'>): Amount {
  // uint160 max (Permit2) and anything near uint256 max
  if (raw >= UINT160_MAX) return { raw: raw.toString(), display: 'unlimited', unlimited: true };
  // Drainers also ask for silly round numbers (1e29 USDC) that are more than the token's whole supply.
  // Shown as a 40-digit amount it looks like a limit; in practice it is unlimited.
  const supply = token?.totalSupply ? BigInt(token.totalSupply) : 0n;
  if (supply > 0n && raw >= supply) return { raw: raw.toString(), display: 'unlimited', unlimited: true, moreThanSupply: true };
  const unlimited = false;
  if (token?.decimals !== undefined) {
    return { raw: raw.toString(), display: groupThousands(formatUnits(raw, token.decimals)), unlimited };
  }
  return { raw: raw.toString(), display: `${groupThousands(raw.toString())} raw units`, unlimited };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDeadline(unix: bigint, nowSec: number = Math.floor(Date.now() / 1000)): Deadline {
  const tenYears = BigInt(nowSec + 10 * 365 * 24 * 3600);
  if (unix >= UINT48_MAX || unix > tenYears) return { unix: unix.toString(), display: 'never expires', never: true };
  const d = new Date(Number(unix) * 1000);
  return { unix: unix.toString(), display: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`, never: false };
}

export function shortAddr(a?: string): string {
  if (!a) return 'an unknown address';
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
