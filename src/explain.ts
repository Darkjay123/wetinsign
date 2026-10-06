import type { Facts } from './facts.js';
import { shortAddr } from './format.js';
import { verdict, type Flag, type Severity } from './risk.js';
import { trustedSpender } from './trusted.js';

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

  if (f.via === 'batch' && f.bundle?.length) {
    const approvals = f.bundle.filter((b) => /approve|permit2/.test(b.kind));
    const names = [...new Set(approvals.map((b) => b.token?.symbol).filter(Boolean))] as string[];
    const list = names.length ? ` (${names.slice(0, 6).join(', ')}${names.length > 6 ? ' and more' : ''})` : '';
    if (approvals.length >= 2) {
      lines.push(pcm
        ? `Wahala: this one transaction dey do ${f.bundle.length} things at once inside your wallet, and e dey give permission for ${approvals.length} different tokens${list} at the same time. Normal swap no dey need am like that. Na exactly so Inferno Drainer take thief people money with one click.`
        : `Danger: this single transaction does ${f.bundle.length} things at once inside your wallet and gives permission over ${approvals.length} different tokens${list} in one go. A normal swap never needs that. This is exactly how Inferno Drainer emptied wallets with one click.`);
    } else {
      lines.push(pcm
        ? `Shine your eye: this transaction dey run ${f.bundle.length} actions at once (wallet batch). The main one na below.`
        : `Careful: this transaction runs ${f.bundle.length} actions at once (a wallet batch). The important one is below.`);
    }
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
      const trusted = has('TRUSTED_SPENDER') ? trustedSpender(f.chainId, f.spender) : undefined;
      if (trusted) {
        lines.push(pcm
          ? `${trusted} na official Uniswap contract. To approve am na normal step if you wan swap for Uniswap, but e go fit move ${f.amount?.unlimited ? 'ALL' : amt} your ${tok}. The real wahala na after: if any site come ask you to sign "Permit" for address wey you no know, stop.`
          : `${trusted} is an official Uniswap contract. Approving it is a normal step for swapping on Uniswap, but it lets it move ${f.amount?.unlimited ? 'ALL of' : amt + ' of'} your ${tok}. The real risk comes after: if any site then asks you to sign a "Permit" for an address you do not know, stop.`);
      } else if (f.amount?.unlimited) {
        lines.push(pcm
          ? `Wahala dey: you dey give ${who} permission to carry ALL your ${tok}, no limit at all. If na thief get that address, dem fit clear this token comot from your wallet anytime, dem no go ask you again.`
          : `Danger: you are giving ${who} permission to move ALL of your ${tok}, with no limit. If that address is a scammer, they can empty this token from your wallet at any time without asking you again.`);
      } else {
        lines.push(pcm
          ? `You dey allow ${who} make e fit carry reach ${amt} of your ${tok}, anytime, no be only now. Shine your eye: thieves dey ask for exact amount so wallet no go show "unlimited". Only approve am if you trust this site well well.`
          : `Careful: you are allowing ${who} to take up to ${amt} of your ${tok}, at any time, not just now. Scammers often ask for an exact amount so your wallet does not warn "unlimited". Only approve it if you trust this site.`);
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
    case 'permit2_transfer': {
      const what = f.batch && f.batch.length > 1
        ? f.batch.map((b) => `${b.amount.display} ${b.token.symbol ?? 'tokens'}`).join(', ')
        : `${amt} ${tok}`;
      const trusted = has('TRUSTED_SPENDER') ? trustedSpender(f.chainId, f.spender) : undefined;
      if (trusted) {
        lines.push(pcm
          ? `Na ${trusted} swap be this, official Uniswap. If you sign, ${trusted} go collect ${what} from your wallet once to do the swap. Na normal if na you start the swap for Uniswap.`
          : `This is a ${trusted} swap, an official Uniswap contract. Signing lets it collect ${what} from your wallet once to fill the swap. That is normal if you started this swap on Uniswap.`);
      } else {
        lines.push(pcm
          ? `Shine your eye: if you sign this one, ${who} fit carry ${what} comot from your wallet immediately, one time, and you no go need do any transaction again. Na exactly so drainers dey use am.`
          : `Careful: signing this lets ${who} take ${what} out of your wallet right away, one time, with no further transaction from you. This is exactly how many drainers work.`);
      }
      if (has('SPENDER_NOT_CONTRACT')) {
        lines.push(pcm
          ? 'Wahala: the address wey go collect am no be app contract at all (e never even dey for blockchain). Drainers dey use new empty address like this.'
          : 'Danger: the address that would collect it is not an app contract (nothing is deployed there yet). Drainers use fresh empty addresses exactly like this.');
      }
      break;
    }
    case 'blur_order': {
      const nft = `NFT #${f.tokenId ?? '?'}`;
      const price = `${f.price?.display ?? 'an unknown amount'} ${tok}`;
      if (has('FREE_LISTING')) {
        lines.push(pcm
          ? `Wahala dey: this one go list your ${nft} for Blur for ${price}, wey be like free. If you sign am, person fit buy am for nothing.`
          : `Danger: this lists your ${nft} on Blur for ${price}, which is basically free. If you sign it, anyone can buy it for nothing.`);
      } else if (f.side === 'sell') {
        lines.push(pcm
          ? `This one go list your ${nft} for Blur for ${price}. Check say na the price wey you want, because anybody fit buy am for that price.`
          : `This lists your ${nft} for sale on Blur for ${price}. Make sure that is the price you want, because anyone can buy it at that price.`);
      } else {
        lines.push(pcm ? `This one na offer to buy ${nft} for Blur for ${price}.` : `This is an offer to buy ${nft} on Blur for ${price}.`);
      }
      break;
    }
    case 'blur_bulk':
      lines.push(pcm
        ? 'Shine your eye: this signature dey approve plenty Blur listing at once, and the signature no show which NFT or which price. Only sign am inside blur.io itself, after you don check the listings there.'
        : 'Careful: this signature approves a whole batch of Blur listings at once, and the signature does not show which NFTs or prices. Only sign it on blur.io itself, after checking the listings there.');
      break;
    case 'ownership_transfer':
      lines.push(pcm
        ? `Wahala dey: this one go hand over full control of this contract give ${who}. If na this contract hold your money (like DSProxy vault), the new owner fit carry everything. No sign am unless na you dey deliberately give am to person wey you know.`
        : `Danger: this hands full control of this contract to ${who}. If the contract holds your money (like a DSProxy vault), the new owner can take everything. Only sign if you are deliberately handing it to an address you know.`);
      break;
    case 'nft_approve': {
      const id = f.tokenId ? `#${f.tokenId}` : '';
      const col = f.token?.symbol ?? 'this collection';
      lines.push(has('REVOKE')
        ? (pcm ? `Correct: this one dey cancel the permission wey person get over your ${col} NFT ${id}.` : `Good: this cancels the permission someone had over your ${col} NFT ${id}.`)
        : (pcm
          ? `Shine your eye: this one go allow ${who} carry your ${col} NFT ${id} anytime. Only approve am if you dey sell am or use am for site wey you trust.`
          : `Careful: this lets ${who} take your ${col} NFT ${id} at any time. Only approve it if you are selling or using it on a site you trust.`));
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
      if (has('SPENDER_NOT_CONTRACT')) {
        lines.push(pcm
          ? 'The address wey you dey give control na ordinary wallet, no be marketplace contract. Real marketplaces no dey do am like that.'
          : 'The address getting control is a plain wallet, not a marketplace contract. Real marketplaces do not work that way.');
      }
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
  const pool = [f.amount?.display, String(f.bundle?.length ?? ''), String((f.bundle ?? []).filter((b) => /approve|permit2/.test(b.kind)).length), f.tokenId, f.price?.display, ...(f.batch ?? []).map((b) => b.amount.display), f.deadline?.display, f.nativeValue?.display, f.chain, f.token?.symbol,
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

/**
 * Reasons to throw the model's wording away. Each one is a failure we saw live from the small model:
 * calling a Uniswap approval "Danger!" when our verdict was only careful, talking as if the person had already signed,
 * describing "this person" instead of speaking to the reader, and dropping the one fact that matters.
 */
export function aiProblems(text: string, f: Facts, flags: Flag[], v: Severity): string[] {
  const out: string[] = [];
  const has = (c: Flag['code']) => flags.some((x) => x.code === c);
  if (v === 'danger' && /\b(safe|fine|normal|nothing to worry)\b/i.test(text)) out.push('softens danger');
  if (v === 'danger' && !/danger|stop|do not sign|don't sign/i.test(text)) out.push('danger not stated');
  if (v !== 'danger' && /\bdanger(ous)?\b/i.test(text)) out.push('says danger when verdict is ' + v);
  if (/\byou (have )?(already )?(gave|given|approved|signed)\b/i.test(text)) out.push('talks as if already signed');
  if (/\b(this person|the user|this user)\b/i.test(text)) out.push('not speaking to the reader');
  if (/0x[0-9a-f]{4,}/i.test(text)) out.push('contains an address');
  if (f.token?.symbol && !text.includes(f.token.symbol)) out.push('leaves out the token');
  if (has('TRUSTED_SPENDER') && !/uniswap/i.test(text)) out.push('leaves out who the spender is');
  if (f.via === 'multicall' && !/bundle|hidden|multicall/i.test(text)) out.push('leaves out the hidden approval');
  if (f.via === 'batch' && !/batch|at once|in one go|bundle/i.test(text)) out.push('leaves out the batch');
  if (text.length > 420) out.push('too long');
  return out;
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
    const problems = aiProblems(text, f, flags, v);
    if (problems.length) return { ...fallback, rejected: problems };
    return { verdict: v, text, source: 'ai', rejected: [] };
  } catch {
    return fallback;
  }
}
