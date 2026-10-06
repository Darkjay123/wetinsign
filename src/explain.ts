import type { Facts } from './facts.js';
import { shortAddr } from './format.js';
import { verdict, type Flag, type Severity } from './risk.js';

export type Lang = 'en' | 'pcm';

export type ChatMessage = { role: 'system' | 'user'; content: string };
export type Llm = (messages: ChatMessage[]) => Promise<string>;

export interface Explanation {
  verdict: Severity;
  text: string;
  source: 'ai' | 'template';
  /** Numbers the model wrote that are not in the decoded facts. Non-empty means the AI text was thrown away. */
  rejected: string[];
}

function tokenName(f: Facts): string {
  return f.token?.symbol ?? 'tokens';
}

/** Deterministic wording. Always correct, and the fallback whenever the model misbehaves or is offline. */
export function templateText(f: Facts, flags: Flag[], lang: Lang): string {
  const pcm = lang === 'pcm';
  const who = shortAddr(f.spender ?? f.recipient);
  const tok = tokenName(f);
  const amt = f.amount?.display ?? 'an unknown amount';
  const until = f.deadline?.display ?? 'an unknown date';
  const has = (c: Flag['code']) => flags.some((x) => x.code === c);
  const lines: string[] = [];

  if (has('KNOWN_DRAINER')) {
    lines.push(pcm
      ? 'STOP: dem don report this address as wallet drainer. No sign am.'
      : 'STOP: this address has been reported as a wallet drainer. Do not sign.');
  }

  if (f.via === 'multicall') {
    lines.push(pcm
      ? 'Shine your eye: dem hide this permission inside one bundle of actions (multicall). Na trick wey wallet drainers dey use make your wallet no warn you.'
      : 'Careful: this permission is hidden inside a bundle of actions (multicall). Drainers use this trick so your wallet does not warn you.');
  }

  switch (f.kind) {
    case 'erc20_approve':
    case 'permit':
    case 'permit2': {
      const sig = f.kind !== 'erc20_approve';
      if (has('REVOKE')) {
        lines.push(pcm
          ? `Correct: this one dey cancel the permission wey ${who} get to spend your ${tok}.`
          : `Good: this removes ${who}'s permission to spend your ${tok}.`);
        break;
      }
      if (sig) {
        lines.push(pcm
          ? 'Shine your eye: na signature be this, no be transaction. E no go collect gas, and nothing go show for blockchain until dem use am. Scammers like this kind one.'
          : 'Careful: this is a signature, not a transaction. It costs no gas and nothing shows on-chain until it is used, which is why scammers love it.');
      }
      if (f.amount?.unlimited) {
        lines.push(pcm
          ? `Wahala dey: you dey give ${who} permission to carry ALL your ${tok}, no limit at all. If na thief get that address, dem fit clear this token comot from your wallet anytime, dem no go ask you again.`
          : `Danger: you are giving ${who} permission to move ALL of your ${tok}, with no limit. If that address is a scammer, they can empty this token from your wallet at any time without asking you again.`);
      } else {
        lines.push(pcm
          ? `You dey allow ${who} make e spend reach ${amt} of your ${tok}. Na the maximum be that, but only approve am if you trust this app.`
          : `You are allowing ${who} to spend up to ${amt} of your ${tok}. That is the most they can take, but only approve it if you trust this app.`);
      }
      if (sig) {
        lines.push(f.deadline?.never
          ? (pcm ? 'This permission no get expiry date.' : 'This permission never expires.')
          : (pcm ? `E go last till ${until}.` : `It lasts until ${until}.`));
      }
      if (has('SPENDER_NOT_CONTRACT')) {
        lines.push(pcm
          ? 'The address wey you dey give permission na ordinary wallet, no be app contract. Real apps no dey do am like that.'
          : 'The address getting this permission is a plain wallet, not an app contract. Real apps do not work that way.');
      }
      break;
    }
    case 'nft_approve_all':
      lines.push(f.approved
        ? (pcm
          ? `Wahala dey: you dey hand over ALL your NFT for this collection give ${who}. Na so most NFT thief dey take steal.`
          : `Danger: you are handing ${who} control of EVERY NFT you own in this collection. This is the most common way NFT drainers steal.`)
        : (pcm
          ? `Correct: this one dey cancel the control wey ${who} get over your NFT for this collection.`
          : `Good: this removes ${who}'s control over your NFTs in this collection.`));
      break;
    case 'seaport_order':
      lines.push(has('FREE_LISTING')
        ? (pcm
          ? 'Wahala dey: this signature go put your item for market, and you no go collect anything back. If you sign am, person fit carry am free.'
          : 'Danger: this signature lists your items for sale and you receive nothing back. Signing it lets someone take them for free.')
        : (pcm
          ? 'This signature dey create marketplace listing for your item. Check say the price na wetin you want.'
          : 'This signature creates a marketplace listing for your item. Check the price is what you expect.'));
      break;
    case 'transfer':
    case 'transfer_from':
    case 'native_send':
      lines.push(pcm
        ? `You dey send ${amt} ${tok} go ${who}. Crypto transfer no dey reverse, so check the address well well.`
        : `You are sending ${amt} ${tok} to ${who}. Crypto transfers cannot be reversed, so check the address.`);
      break;
    case 'unknown_call':
    case 'unknown_signature':
      lines.push(pcm
        ? 'We no fit read wetin this one dey do. No sign anything wey you no understand, especially link wey person send you.'
        : 'We could not read what this does. Do not sign anything you cannot understand, especially from a link someone sent you.');
      break;
  }
  return lines.join(' ');
}

const ADDRESS_RE = /0x[0-9a-fA-F]{4,}(?:…[0-9a-fA-F]{4})?/g;
const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

function numbersIn(s: string): string[] {
  return (s.replace(ADDRESS_RE, ' ').match(NUMBER_RE) ?? []).map((n) => n.replace(/,/g, ''));
}

/** Every number the explanation is allowed to say: only what was decoded. */
export function allowedNumbers(f: Facts): Set<string> {
  const pool = [f.amount?.display, f.deadline?.display, f.nativeValue?.display, f.chain, f.token?.symbol,
    ...(f.offer ?? []).map((i) => i.amount.display), ...(f.consideration ?? []).map((i) => i.amount.display)];
  const out = new Set<string>();
  for (const s of pool) if (s) for (const n of numbersIn(s)) out.add(n);
  return out;
}

/** Returns the numbers in `text` that do not appear in the facts. Empty means the text is safe to show. */
export function inventedNumbers(text: string, f: Facts): string[] {
  const ok = allowedNumbers(f);
  return numbersIn(text).filter((n) => !ok.has(n));
}

export function buildMessages(f: Facts, flags: Flag[], lang: Lang): ChatMessage[] {
  const language = lang === 'pcm' ? 'Nigerian Pidgin English' : 'plain, simple English';
  return [
    {
      role: 'system',
      content:
        `You explain crypto wallet actions to everyday Nigerians who are not technical. Write in ${language}. ` +
        'Use ONLY the facts and flags in the JSON you are given. Never write any number, amount, date or address that is not in the facts. ' +
        'Do not write wallet addresses at all; say "this address" instead. ' +
        'Lead with the verdict (danger, careful, or fine), then say plainly what the person is giving away and what could happen. ' +
        'At most three short sentences. No jargon like "ERC-20", "allowance" or "calldata".',
    },
    { role: 'user', content: JSON.stringify({ verdict: verdict(flags), flags: flags.map((x) => x.code), facts: f }, null, 0) },
  ];
}

export async function explain(f: Facts, flags: Flag[], lang: Lang, llm?: Llm): Promise<Explanation> {
  const v = verdict(flags);
  const fallback: Explanation = { verdict: v, text: templateText(f, flags, lang), source: 'template', rejected: [] };
  if (!llm) return fallback;
  // The only model on Rumpty (llama3.2:3b) ignores the Pidgin instruction and answers in English,
  // and Rumpty has no larger model for now. Pidgin readers get our reviewed Pidgin wording instead.
  if (lang === 'pcm') return fallback;
  // When we could not decode the action there are no facts for the model to restate, and the small model
  // invents scary but false stories (seen live on a real drainer multicall). Say plainly that we could not read it.
  if (f.kind === 'unknown_call' || f.kind === 'unknown_signature') return fallback;
  try {
    const text = (await llm(buildMessages(f, flags, lang))).trim();
    if (!text) return fallback;
    const rejected = inventedNumbers(text, f);
    if (rejected.length) return { ...fallback, rejected };
    // Danger must never be softened: if our rules say danger, the template's warning leads.
    if (v === 'danger' && !/danger|wahala|stop|careful|shine your eye/i.test(text)) {
      return { ...fallback, text: `${fallback.text} ${text}` };
    }
    return { verdict: v, text, source: 'ai', rejected: [] };
  } catch {
    return fallback;
  }
}
