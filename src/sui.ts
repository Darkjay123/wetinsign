import { Transaction } from '@mysten/sui/transactions';
import type { Facts } from './facts.js';
import { formatAmount } from './format.js';
import { b58decode } from './solana.js';
import type { TokenRef } from './tokens.js';

/**
 * Sui. Not EVM: a transaction is a block of commands over objects. Reading the commands alone does not tell you
 * what leaves your wallet, so we ask a Sui node to dry-run it (simulateTransaction) and read the balance and
 * object changes. 784 is Sui's SLIP-44 coin type.
 */
export const SUI_ID = 784;
const SUI_GRAPHQL = process.env.SUI_GRAPHQL ?? 'https://graphql.mainnet.sui.io/graphql';
const CHAIN = 'Sui';
const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

export interface SuiChanges {
  sender?: string;
  status?: string;
  balances: Array<{ address: string; coinType: string; amount: string }>;
  /** Objects that changed owner: from → to, with their Move type. */
  moved: Array<{ from: string; to: string; type: string }>;
}
export interface SuiLookup {
  simulate?: (bcsB64: string) => Promise<SuiChanges>;
  tx?: (digest: string) => Promise<SuiChanges | undefined>;
  coin?: (coinType: string) => Promise<{ symbol?: string; decimals?: number } | undefined>;
}

export const isSuiDigest = (s: unknown): boolean => {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(s)) return false;
  try { return b58decode(s).length === 32; } catch { return false; }
};
/** Pasted base64 transaction bytes, or the SDK's JSON form. */
export function suiTxFromText(text: string): Transaction | undefined {
  const t = text.trim();
  try {
    if (t.startsWith('{')) { const j = JSON.parse(t); if (!(j && (j.version === 2 || j.version === 1) && (j.commands || j.transactions))) return undefined; return Transaction.from(t); }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t) || t.length < 40) return undefined;
    const tx = Transaction.from(t);
    const d = tx.getData();
    return d.sender && Array.isArray(d.commands) && d.commands.length ? tx : undefined;
  } catch { return undefined; }
}
export const looksLikeSuiTx = (s: unknown) => typeof s === 'string' && !!suiTxFromText(s);

const norm = (a: string) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const normType = (t: string) => t.replace(/^0x([0-9a-fA-F]+)::/, (_m, h) => `${norm(h)}::`);
function niceType(t: string): string {
  const name = t.split('<')[0].split('::').slice(1).join('::');
  if (/kiosk::KioskOwnerCap$/.test(name)) return 'your NFT kiosk (every NFT inside it)';
  if (/package::UpgradeCap$/.test(name)) return 'the upgrade key of your Sui app';
  if (/Cap$/.test(name)) return `a control key object (${name})`;
  if (/^coin::Coin$/.test(name)) return 'coins';
  return name || 'an object';
}

export async function suiFacts(ch: SuiChanges, lookup: SuiLookup = {}): Promise<Facts> {
  const me = ch.sender ? norm(ch.sender) : undefined;
  const f: Facts = { kind: 'unknown_call', chainId: SUI_ID, chain: CHAIN, ...(me ? { from: me } : {}) };
  const token = async (ct: string): Promise<TokenRef> => {
    const t = normType(ct);
    if (t === SUI_TYPE) return { address: t, symbol: 'SUI', decimals: 9 };
    const m = await lookup.coin?.(t).catch(() => undefined);
    return { address: t, symbol: m?.symbol ?? t.split('::').pop(), decimals: m?.decimals };
  };
  const bal = ch.balances.map((b) => ({ address: norm(b.address), coinType: normType(b.coinType), amount: BigInt(b.amount) }));
  const mine = bal.filter((b) => b.address === me);
  const theirs = bal.filter((b) => b.address !== me && b.amount > 0n);
  const lost = new Set(mine.filter((b) => b.amount < 0n).map((b) => b.coinType));
  const gained = mine.filter((b) => b.amount > 0n);
  const movedOut = ch.moved.filter((m) => norm(m.from) === me && norm(m.to) !== me);

  // Who receives what from you: coins you lost that land in someone's address, plus objects handed over.
  const recv = new Map<string, Array<{ label: string; coinType?: string; amount?: bigint; type?: string }>>();
  // With Sui address balances the sender's own line can net out (gas coins folding into the balance), so a gain
  // elsewhere counts as coming from you when you lost that coin, or when no other address paid it.
  const fromYou = (ct: string) => lost.has(ct) || !bal.some((b) => b.coinType === ct && b.amount < 0n && b.address !== me);
  const swapGain = gained.filter((g) => !theirs.some((t) => t.coinType === g.coinType) && !(g.coinType === SUI_TYPE && g.amount < 50_000_000n));
  // A swap that pays a small protocol fee to a fee address is still a swap, not a send.
  const feeOnly = swapGain.length > 0 && theirs.every((t) => { const o = mine.find((m) => m.coinType === t.coinType && m.amount < 0n); return o && t.amount * 10n < -o.amount; });
  for (const t of theirs) if (!feeOnly && fromYou(t.coinType)) recv.set(t.address, [...(recv.get(t.address) ?? []), { label: t.coinType, coinType: t.coinType, amount: t.amount }]);
  for (const m of movedOut) { const to = norm(m.to); recv.set(to, [...(recv.get(to) ?? []), { label: m.type, type: m.type }]); }

  const names = async (items: Array<{ coinType?: string; type?: string }>) => Promise.all(items.map(async (i) => (i.coinType ? (await token(i.coinType)).symbol ?? 'coins' : niceType(i.type!))));
  for (const [to, items] of recv) {
    const distinct = [...new Set(await names(items))];
    if (distinct.length >= 2) f.sweep = { recipient: to, assets: distinct };
  }

  const recipients = [...recv.keys()];
  if (recipients.length) {
    const sends = await Promise.all([...recv].flatMap(([to, items]) => items.map(async (i) => {
      if (i.coinType) { const tk = await token(i.coinType); return { kind: 'transfer', token: tk, spender: to, amount: formatAmount(i.amount!, tk) }; }
      return { kind: 'transfer', token: { address: i.type!, symbol: niceType(i.type!) }, spender: to, amount: { raw: '1', display: '1', unlimited: false } };
    })));
    const lead = sends.find((s) => s.token.symbol !== 'SUI') ?? sends[0];
    Object.assign(f, { kind: lead.token.symbol === 'SUI' ? 'native_send' : 'transfer', token: lead.token, recipient: lead.spender, amount: lead.amount, contract: lead.token.address });
    if (sends.length > 1) Object.assign(f, { via: 'batch', bundle: sends });
    // A key object (kiosk, upgrade key, admin cap) going to someone else is a takeover of what it controls.
    const cap = movedOut.find((m) => /Cap(<|$)/.test(m.type.split('::').pop() ?? ''));
    if (cap && !f.sweep) Object.assign(f, { kind: 'transfer', token: { address: cap.type, symbol: niceType(cap.type) }, recipient: norm(cap.to), amount: { raw: '1', display: '1', unlimited: false } });
    return f;
  }
  // Nothing landed in anyone's address: coins went into an app's shared pool.
  const out = mine.filter((b) => b.amount < 0n && !(b.coinType === SUI_TYPE && -b.amount < 50_000_000n)); // ignore gas-sized SUI
  if (out.length && gained.length) {
    const o = out[0], g = gained.sort((a, b) => (b.amount > a.amount ? 1 : -1))[0];
    const ot = await token(o.coinType), gt = await token(g.coinType);
    return Object.assign(f, { kind: 'ledger_action', ledgerAction: 'swap', token: ot, amount: formatAmount(-o.amount, ot), buyToken: gt, buyAmount: formatAmount(g.amount, gt) });
  }
  if (out.length) {
    const o = out[0], ot = await token(o.coinType);
    return Object.assign(f, { kind: 'ledger_action', ledgerAction: 'app_deposit', token: ot, amount: formatAmount(-o.amount, ot) });
  }
  if (ch.status && ch.status !== 'SUCCESS') return f;
  return Object.assign(f, { kind: 'ledger_action', ledgerAction: 'setup' });
}

async function gql(query: string, variables: object): Promise<any> {
  const r = await fetch(SUI_GRAPHQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
}
const EFFECTS = `status balanceChangesJson objectChanges(first: 50) { nodes { inputState { owner { __typename ... on AddressOwner { address { address } } } asMoveObject { contents { type { repr } } } } outputState { owner { __typename ... on AddressOwner { address { address } } } } } }`;
function readEffects(e: any, sender?: string): SuiChanges {
  const moved: SuiChanges['moved'] = [];
  for (const n of e?.objectChanges?.nodes ?? []) {
    const from = n.inputState?.owner?.address?.address, to = n.outputState?.owner?.address?.address;
    if (from && to && from !== to) moved.push({ from, to, type: n.inputState?.asMoveObject?.contents?.type?.repr ?? 'object' });
  }
  return { sender, status: e?.status, balances: (e?.balanceChangesJson ?? []).map((b: any) => ({ address: b.address ?? b.owner, coinType: b.coinType, amount: String(b.amount) })), moved };
}
const coinCache = new Map<string, { symbol?: string; decimals?: number } | undefined>();
export const suiLookup: SuiLookup = {
  simulate: async (b64) => {
    const sender = Transaction.from(b64).getData().sender ?? undefined;
    const d = await gql(`query($t: JSON!) { simulateTransaction(transaction: $t) { effects { ${EFFECTS} } } }`, { t: { bcs: { value: b64 } } });
    return readEffects(d.simulateTransaction.effects, sender);
  },
  tx: async (digest) => {
    const d = await gql(`query($d: String!) { transaction(digest: $d) { sender { address } effects { ${EFFECTS} } } }`, { d: digest });
    return d.transaction ? readEffects(d.transaction.effects, d.transaction.sender?.address) : undefined;
  },
  coin: async (ct) => {
    if (coinCache.has(ct)) return coinCache.get(ct);
    const d = await gql(`query($c: String!) { coinMetadata(coinType: $c) { symbol decimals } }`, { c: ct }).catch(() => undefined);
    const v = d?.coinMetadata ? { symbol: d.coinMetadata.symbol, decimals: d.coinMetadata.decimals } : undefined;
    coinCache.set(ct, v);
    return v;
  },
};

/** Pasted transaction → dry-run on Sui → facts. JSON form is built into bytes first (needs the node). */
export async function explainSuiText(text: string, lookup: SuiLookup = suiLookup, build?: (tx: Transaction) => Promise<string>): Promise<Facts> {
  const tx = suiTxFromText(text);
  if (!tx) throw new Error('not a Sui transaction');
  const t = text.trim();
  const b64 = t.startsWith('{') ? (build ? await build(tx) : await buildWithNode(tx)) : t;
  if (!lookup.simulate) throw new Error('no simulator');
  return suiFacts(await lookup.simulate(b64), lookup);
}
async function buildWithNode(tx: Transaction): Promise<string> {
  const { SuiGraphQLClient } = await import('@mysten/sui/graphql');
  const client = new SuiGraphQLClient({ url: SUI_GRAPHQL, network: 'mainnet' } as any);
  return Buffer.from(await tx.build({ client: client as any })).toString('base64');
}

export async function fetchSuiTx(digest: string, lookup: SuiLookup = suiLookup): Promise<Facts> {
  const ch = await lookup.tx?.(digest);
  if (!ch) throw new Error('not found');
  return suiFacts(ch, lookup);
}
