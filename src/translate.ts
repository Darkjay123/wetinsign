/**
 * Machine translation of the finished English explanation into other languages.
 *
 * Accuracy rules (a wrong number in a wallet warning is worse than no translation):
 * - Every amount, address, hash, token symbol, network and app name is swapped for a [n] placeholder before the text
 *   leaves the server, so the translator never sees (and cannot change) a figure or an address.
 * - The translation is accepted only if every placeholder comes back exactly as many times as it went out.
 *   Otherwise we keep the English text and say so.
 * - The English original always travels with the answer so the page can show it.
 */
export const TRANSLATED_LANGS: Record<string, string> = {
  es: 'Español', fr: 'Français', pt: 'Português', de: 'Deutsch', it: 'Italiano', tr: 'Türkçe', ru: 'Русский',
  ar: 'العربية', hi: 'हिन्दी', 'zh-CN': '中文', ja: '日本語', ko: '한국어', id: 'Bahasa Indonesia', vi: 'Tiếng Việt',
  sw: 'Kiswahili', ha: 'Hausa', yo: 'Yorùbá', ig: 'Igbo',
};
export const isTranslated = (l: unknown): l is string => typeof l === 'string' && Object.prototype.hasOwnProperty.call(TRANSLATED_LANGS, l);

/** Raw translator: English text in, target-language text out (or null). Injected so tests never hit the network. */
export type Translator = (text: string, to: string) => Promise<string | null>;

const PROTECT_RE = new RegExp([
  String.raw`\[\d+\]`, // an existing placeholder: matched whole so its digits are never re-locked
  String.raw`0x[0-9a-fA-F]+(?:…[0-9a-fA-F]+)?`, // EVM addresses/hashes, shortened or not
  String.raw`[A-Za-z0-9]{3,}…[A-Za-z0-9]{3,}`, // any shortened address
  String.raw`[a-z0-9]{5}(?:-[a-z0-9]{3,5}){3,}`, // ICP principals
  String.raw`\b[A-Za-z0-9._:-]*\d[A-Za-z0-9._:-]*[A-Za-z][A-Za-z0-9._:-]*\b`, // tokens mixing digits and letters (addresses, ids)
  String.raw`\b[A-Za-z0-9]{25,}\b`, // long base58/base32 strings
  String.raw`\d[\d,]*(?:\.\d+)?%?`, // numbers
].join('|'), 'g');

/** Crypto words machine translators get wrong ("gas" became "gasolina"): kept in English, as wallets show them. */
const GLOSSARY = ['wallet drainers', 'wallet drainer', 'drainers', 'drainer', 'gas fees', 'gas fee', 'gas', 'seed phrase', 'smart account', 'NFTs', 'NFT', 'Permit2', 'multisig', 'airdrop'];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace protected spans with [1], [2]… Identical spans share one placeholder. */
export function protect(text: string, names: string[] = []): { masked: string; spans: string[] } {
  const spans: string[] = [];
  const slot = (s: string) => { let i = spans.indexOf(s); if (i < 0) { spans.push(s); i = spans.length - 1; } return `[${i + 1}]`; };
  const extra = [...new Set([...names, ...GLOSSARY].filter((n) => n && n.trim().length >= 2))].sort((a, b) => b.length - a.length);
  const nameRe = extra.length ? new RegExp(`(?<![\\w\\[])(?:${extra.map(escapeRe).join('|')})(?![\\w\\]])`, 'g') : null;
  // Names first (token symbols like USDt, chains like "Polkadot Asset Hub"), then the generic patterns on what is left.
  let rest = text;
  if (nameRe) rest = rest.replace(nameRe, (m) => slot(m));
  const out = rest.replace(PROTECT_RE, (m) => (/^\[\d+\]$/.test(m) ? m : slot(m)));
  return { masked: out, spans };
}

export function restore(text: string, spans: string[]): string | null {
  let bad = false;
  const out = text.replace(/\[\s*(\d+)\s*\]/g, (_m, n) => { const v = spans[Number(n) - 1]; if (v === undefined) bad = true; return v ?? ''; });
  return bad ? null : out;
}

const count = (s: string) => { const m = new Map<string, number>(); for (const x of s.matchAll(/\[\s*(\d+)\s*\]/g)) m.set(x[1], (m.get(x[1]) ?? 0) + 1); return m; };
const sameCounts = (a: string, b: string) => { const x = count(a), y = count(b); if (x.size !== y.size) return false; for (const [k, v] of x) if (y.get(k) !== v) return false; return true; };

/** Split into chunks of whole sentences, each under `max` characters (the free translator takes ~500 bytes). */
export function chunks(text: string, max = 420): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && (cur + ' ' + s).length > max) { out.push(cur); cur = s; } else cur = cur ? cur + ' ' + s : s;
  }
  if (cur) out.push(cur);
  return out.flatMap((c) => (c.length <= max ? [c] : c.match(new RegExp(`[\\s\\S]{1,${max}}(?=\\s|$)`, 'g')) ?? [c]));
}

const cache = new Map<string, string>();
const CACHE_MAX = 4000;

/** Translate English text, keeping every protected span byte-for-byte. Returns null when that cannot be guaranteed. */
export async function translateSafely(text: string, to: string, names: string[], tr: Translator): Promise<string | null> {
  if (!text.trim()) return text;
  const { masked, spans } = protect(text, names);
  const pieces = chunks(masked);
  const done: string[] = [];
  for (const p of pieces) {
    const k = `${to}\u0001${p}`;
    let t = cache.get(k);
    if (t === undefined) {
      const r = await tr(p, to).catch(() => null);
      if (!r || !sameCounts(p, r)) return null;
      t = r.replace(/\[\s*(\d+)\s*\]/g, '[$1]');
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(k, t);
    }
    done.push(t);
  }
  return restore(done.join(' '), spans);
}

/** Free MyMemory translator. A contact email raises the daily allowance. */
export function myMemory(email = process.env.MYMEMORY_EMAIL): Translator {
  return async (text, to) => {
    const u = new URL('https://api.mymemory.translated.net/get');
    u.searchParams.set('q', text);
    u.searchParams.set('langpair', `en|${to}`);
    if (email) u.searchParams.set('de', email);
    const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { responseStatus?: number | string; quotaFinished?: boolean; responseData?: { translatedText?: string } };
    if (Number(j.responseStatus) !== 200 || j.quotaFinished) return null;
    const t = j.responseData?.translatedText;
    // MyMemory answers some errors as "translated" text in capitals.
    if (!t || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE PAIR/i.test(t)) return null;
    return t.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  };
}
