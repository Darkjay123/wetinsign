import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Known drainer addresses.
 *
 * Two sources are merged:
 *  - data/drainers.json: our own hand-reviewed additions (ships empty; see data/README.md).
 *  - The Scam Sniffer open scam database (https://github.com/scamsniffer/scam-database),
 *    fetched at runtime and refreshed every 12 hours. It is GPL-3.0 licensed, so we read it
 *    live instead of copying it into this MIT repo, and we credit it in the README and UI.
 *
 * If the fetch fails we keep whatever we last loaded. An empty or stale list never makes
 * anything look safe: the other risk checks run regardless.
 */
export const SCAMSNIFFER_URL = 'https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/address.json';
const REFRESH_MS = 12 * 60 * 60 * 1000;
const ADDRESS = /^0x[0-9a-f]{40}$/;

export interface DrainerStats {
  count: number;
  local: number;
  remote: number;
  source: string | null;
  loadedAt: string | null;
  lastError: string | null;
}

/** Keeps only well-formed EVM addresses, lowercased. Anything else in the feed is ignored. */
export function parseAddressList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const a = v.trim().toLowerCase();
    if (ADDRESS.test(a)) out.add(a);
  }
  return [...out];
}

function readLocal(): string[] {
  try {
    const file = fileURLToPath(new URL('../data/drainers.json', import.meta.url));
    return parseAddressList(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return [];
  }
}

const local = readLocal();
let remote: string[] = [];
let set = new Set<string>(local);
let loadedAt: string | null = null;
let lastError: string | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

export function drainerSet(): Set<string> {
  return set;
}

export function drainerStats(): DrainerStats {
  return {
    count: set.size,
    local: local.length,
    remote: remote.length,
    source: remote.length ? 'Scam Sniffer scam-database (GPL-3.0)' : null,
    loadedAt,
    lastError,
  };
}

export async function refreshDrainers(fetcher: typeof fetch = fetch, url = process.env.DRAINER_LIST_URL ?? SCAMSNIFFER_URL): Promise<DrainerStats> {
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = parseAddressList(await res.json());
    if (list.length === 0) throw new Error('empty list');
    remote = list;
    set = new Set([...local, ...remote]);
    loadedAt = new Date().toISOString();
    lastError = null;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  }
  return drainerStats();
}

/** Loads once now and then every 12 hours. Safe to call more than once. */
export function startDrainerRefresh(): Promise<DrainerStats> {
  if (!timer) {
    timer = setInterval(() => void refreshDrainers(), REFRESH_MS);
    timer.unref?.();
  }
  return refreshDrainers();
}
