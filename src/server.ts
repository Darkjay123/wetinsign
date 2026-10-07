import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { serve } from '@hono/node-server';
import { CHAINS } from './chains.js';
import { decodeCall, decodeDelegation, decodeTypedData, type TokenResolver } from './decode.js';
import { explain, type Lang, type Llm } from './explain.js';
import type { Facts } from './facts.js';
import { aiStatus, rumptyLlm } from './inference.js';
import { drainerSet, drainerStats, startDrainerRefresh } from './drainers.js';
import { assessRisk } from './risk.js';
import { createStore, type Store } from './store.js';
import { parseTronTx, TRON_ID, tronDisplay, tronToHex } from './tron.js';
import { badTonAddress, fetchTonTx, isTonRequest, TON_ID, tonFacts, type TonLookup } from './ton.js';
import { aptosFacts, asAptosPayload, APTOS_ID, APTOS_NET, MOVEMENT_ID, MOVEMENT_NET, fetchAptosTx, type AptosLookup } from './aptos.js';
import { asMvxTxs, fetchMvxTx, MVX_ID, mvxFacts, type MvxLookup } from './multiversx.js';
import { HL_ID } from './hyperliquid.js';
import { fetchStxTx, looksLikeStxHex, parseStx, STX_ID, stxFacts, type StxLookup } from './stacks.js';
import { callsFromRequest, fetchStarknetTx, STARKNET_HASH_RE, STARKNET_ID, starknetFacts, type SnLookup } from './starknet.js';
import { algoFacts, ALGO_ID, ALGO_TXID_RE, fetchAlgoTx, parseAlgo, type AlgoLookup } from './algorand.js';
import { explainSuiText, fetchSuiTx, isSuiDigest, looksLikeSuiTx, SUI_ID, type SuiLookup } from './sui.js';
import { fetchNearTx, isNearRequest, NEAR_ID, nearFacts, nearFromJson, parseNearText, type NearLookup } from './near.js';
import { fetchXrplTx, isXrplTx, parseXrplText, XRPL_ID, xrplFacts, type XrplLookup } from './xrpl.js';
import { explainSolanaText, fetchSolanaTx, isSolSignature, looksLikeSolanaTx, SOLANA_ID, type Rpc } from './solana.js';

export interface Deps {
  llm?: Llm;
  store: Store;
  resolveToken?: TokenResolver;
  codeInfo?: (chainId: number | undefined, address: string) => Promise<{ size: number; hash: string; code?: string } | undefined>;
  fetchTx?: (chainId: number, hash: string) => Promise<{ chainId?: number; to: string; data?: string; value?: string | bigint; authorizations?: { address: string; chainId?: number }[]; facts?: Facts }>;
  isContract?: (chainId: number | undefined, address?: string) => Promise<boolean | undefined>;
  /** Solana JSON-RPC. Without it, pasted Solana transactions are read offline and signatures cannot be looked up. */
  solanaRpc?: Rpc;
  /** TON lookups (jetton names, Tonkeeper scam labels, transactions). Without it TON requests are read offline. */
  tonLookup?: TonLookup;
  /** Sui node (dry-runs and lookups), Aptos REST and XRP Ledger JSON-RPC. Without them those networks are read offline where possible. */
  suiLookup?: SuiLookup;
  aptosLookup?: AptosLookup;
  movementLookup?: AptosLookup;
  mvxLookup?: MvxLookup;
  algoLookup?: AlgoLookup;
  stxLookup?: StxLookup;
  snLookup?: SnLookup;
  xrplLookup?: XrplLookup;
  nearLookup?: NearLookup;
}

/** Nigerian Pidgin is ISO 639-3 "pcm"; also accept the plain word so a stray "pidgin" does not silently fall back to English. */
export const lang = (v: unknown): Lang => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'pcm' || s === 'pidgin' || s === 'naija' ? 'pcm' : 'en';
};
// Bump when decoding or wording changes, so answers cached by older code are never served again.
const CACHE_VERSION = 'v31';
const key = (parts: unknown) => createHash('sha256').update(CACHE_VERSION).update(JSON.stringify(parts, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).digest('hex');

/** Requests per minute per client on the explain endpoints. One hash lookup can fan out to 50 networks. */
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN ?? 60);
/** Largest request we read. A real signature request or transaction is a few KB; this stops memory abuse. */
export const MAX_BODY = 256 * 1024;

/** Every address in an answer that a drainer report could match. */
function partiesOf(f: Facts | undefined): string[] {
  if (!f) return [];
  return [f.spender, f.recipient, f.contract, ...(f.bundle ?? []).map((b) => b.spender)].filter((a): a is string => typeof a === 'string').map((a) => a.toLowerCase());
}

export function createApp(deps: Deps) {
  const app = new Hono();
  app.use('*', secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"] },
    xFrameOptions: 'DENY',
    referrerPolicy: 'no-referrer',
  }));
  app.use('/api/*', bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: 'That is too big to be a real wallet request.' }, 413) }));
  // A small per-client limit so nobody can turn us into a free 50-network RPC hammer.
  const hits = new Map<string, { n: number; reset: number }>();
  app.use('/api/explain/*', async (c, next) => {
    const ip = (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim() || c.req.header('x-real-ip') || 'local';
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || h.reset < now) {
      if (hits.size > 10_000) hits.clear();
      hits.set(ip, { n: 1, reset: now + 60_000 });
    } else if (++h.n > RATE_PER_MIN) {
      return c.json({ error: 'Too many checks in one minute. Wait a little and try again.' }, 429);
    }
    await next();
  });

  /**
   * A cached answer stays valid only while the drainer list agrees with it. The Scam Sniffer feed refreshes every
   * 12 hours: an address reported AFTER we cached an answer must not keep its old "careful" verdict.
   */
  const stillGood = (hit: unknown): boolean => {
    const r = hit as { facts?: Facts; flags?: { code: string }[] } | undefined;
    if (!r?.facts) return false;
    if (r.flags?.some((x) => x.code === 'KNOWN_DRAINER')) return true;
    const bad = drainerSet();
    return !partiesOf(r.facts).some((a) => bad.has(a));
  };
  const fromCache = async (k: string): Promise<unknown> => {
    const stored: unknown = await deps.store.get(k).catch(() => undefined);
    return stored && stillGood(stored) ? stored : undefined;
  };
  const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');

  async function respond(facts: Facts, l: Lang, cacheKey: string) {
    // Optional on-chain checks. A flaky RPC must never turn into an error page: we answer without them.
    const spenderIsContract = deps.isContract ? await deps.isContract(facts.chainId, facts.spender).catch(() => undefined) : undefined;
    const delegateCode = facts.kind === 'delegation' && deps.codeInfo && facts.spender ? await deps.codeInfo(facts.chainId, facts.spender).catch(() => undefined) : undefined;
    const flags = assessRisk(facts, { spenderIsContract, delegateCode });
    // Risk is judged on 0x addresses; Tron users then see the T… addresses their wallet shows.
    const shown = tronDisplay(facts);
    const explanation = await explain(shown, flags, l, deps.llm);
    const result = { facts: shown, flags, explanation };
    // Do not keep an answer that a temporary lookup failure left half-read (token name or decimals missing):
    // the next person should get a fresh try, not the degraded answer forever.
    const degraded = /raw units/.test(shown.amount?.display ?? '') || (!!shown.token && !shown.token.symbol && shown.token.address !== 'native');
    if (!degraded) await deps.store.put(cacheKey, result).catch(() => undefined);
    return result;
  }

  app.get('/', (c) => c.html(html));
  app.get('/healthz', async (c) =>
    c.json({
      ok: true,
      ai: !!deps.llm,
      aiLast: aiStatus.last,
      aiLastAt: aiStatus.at,
      cached: await deps.store.count().catch(() => null),
      drainers: drainerStats().count,
      drainersLoadedAt: drainerStats().loadedAt,
    }),
  );
  app.get('/api/drainers', (c) => c.json(drainerStats()));
  app.get('/api/chains', (c) => c.json(Object.values(CHAINS).map(({ id, name, nativeSymbol }) => ({ id, name, nativeSymbol }))));

  app.post('/api/explain/signature', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.typedData) return c.json({ error: 'Paste the signature request (the JSON your wallet shows).' }, 400);
    const l = lang(body.lang);
    const signer = typeof body.from === 'string' && /^0x[0-9a-fA-F]{40}$/.test(body.from) ? body.from : undefined;
    const k = key(['sig', body.typedData, l, signer ?? '']);
    const hit = await fromCache(k);
    if (hit) return c.json({ ...(hit as object), cached: true });
    try {
      const facts = await decodeTypedData(body.typedData, deps.resolveToken, undefined, signer);
      return c.json(await respond(facts, l, k));
    } catch {
      return c.json({ error: 'That does not look like a signature request we can read.' }, 422);
    }
  });

  app.post('/api/explain/call', async (c) => {
    const body = await c.req.json().catch(() => null);
    const pastedText = typeof body?.transaction === 'string' ? body.transaction : typeof body?.data === 'string' ? body.data : undefined;
    const pastedJson = (() => { if (typeof body?.transaction === 'object' && body.transaction) return body.transaction; if (pastedText?.trim().startsWith('{')) { try { return JSON.parse(pastedText); } catch { return undefined; } } return undefined; })();
    const cached = async (k: string, make: () => Promise<Facts>, l: Lang, err: string) => {
      const hit = await fromCache(k);
      if (hit) return c.json({ ...(hit as object), cached: true });
      try { return c.json(await respond(await make(), l, k)); } catch { return c.json({ error: err }, 422); }
    };
    // XRP Ledger: the transaction JSON (or signed hex blob) Xaman, Crossmark or a Ledger is asked to sign.
    const xrplTx = [pastedJson, body].find(isXrplTx) ?? (pastedText ? parseXrplText(pastedText) : undefined);
    if (xrplTx) {
      const l = lang(body.lang);
      return cached(key(['xrpl', xrplTx, l]), () => xrplFacts(xrplTx, deps.xrplLookup), l, 'We could not read that XRP Ledger transaction.');
    }
    // Aptos: the entry-function payload Petra or another wallet is asked to sign.
    const aptosP = asAptosPayload(pastedJson) ?? asAptosPayload(body);
    if (aptosP) {
      const l = lang(body.lang);
      const sender = [body?.from, pastedJson?.sender].find((v) => typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v)) as string | undefined;
      const mv = Number(body?.chainId) === MOVEMENT_ID;
      return cached(key([mv ? 'movement' : 'aptos', aptosP, sender ?? '', l]), () => aptosFacts(aptosP, mv ? deps.movementLookup : deps.aptosLookup, sender, mv ? MOVEMENT_NET : APTOS_NET), l, `We could not read that ${mv ? 'Movement' : 'Aptos'} transaction.`);
    }
    // Starknet: the calls Argent/Braavos are asked to execute ([{ contractAddress, entrypoint, calldata }]).
    const snCalls = pastedJson ? callsFromRequest(pastedJson) : body?.calls ? callsFromRequest(body) : undefined;
    if (snCalls?.length) {
      const l = lang(body.lang);
      const sender = typeof body?.from === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(body.from) ? body.from : undefined;
      return cached(key(['starknet', snCalls, sender ?? '', l]), () => starknetFacts(snCalls, deps.snLookup, sender), l, 'We could not read that Starknet transaction.');
    }
    // Stacks: serialized transaction hex from Leather/Xverse, or the { contract, functionName, functionArgs } request.
    const stxTx = (pastedText && looksLikeStxHex(pastedText)) || Number(body?.chainId) === STX_ID || (pastedJson && (pastedJson.functionName || pastedJson.tx_type)) ? parseStx(pastedJson ?? pastedText) : undefined;
    if (stxTx) {
      const l = lang(body.lang);
      return cached(key(['stx', stxTx, l]), () => stxFacts(stxTx, deps.stxLookup), l, 'We could not read that Stacks transaction.');
    }
    // Algorand: base64 msgpack (Pera/Defly WalletConnect [{ txn }] groups) or indexer JSON.
    const algoTxs = Number(body?.chainId) === ALGO_ID || (pastedText && !pastedText.trim().startsWith('{')) || (pastedJson && (Array.isArray(pastedJson) || pastedJson.txns || pastedJson.txn || pastedJson['tx-type'])) ? parseAlgo(pastedJson ?? pastedText) : undefined;
    if (algoTxs?.length) {
      const l = lang(body.lang);
      return cached(key(['algo', algoTxs, l]), () => algoFacts(algoTxs, deps.algoLookup), l, 'We could not read that Algorand transaction.');
    }
    // MultiversX: the { receiver, sender, value, data } transaction xPortal or the web wallet is asked to sign.
    const mvxTxs = asMvxTxs(pastedJson) ?? (body?.receiver ? asMvxTxs(body) : undefined);
    if (mvxTxs) {
      const l = lang(body.lang);
      return cached(key(['mvx', mvxTxs, l]), () => mvxFacts(mvxTxs, deps.mvxLookup), l, 'We could not read that MultiversX transaction.');
    }
    // NEAR: wallet-selector or near-api-js JSON, base64 borsh bytes, or a wallet link with ?transactions=.
    const nearTxs = pastedJson && isNearRequest(pastedJson) ? nearFromJson(pastedJson) : isNearRequest(body?.transaction ?? body) ? nearFromJson(body?.transaction ?? body) : pastedText ? parseNearText(pastedText) : undefined;
    if (nearTxs?.length) {
      const l = lang(body.lang);
      return cached(key(['near', nearTxs, l]), () => nearFacts(nearTxs, deps.nearLookup), l, 'We could not read that NEAR transaction.');
    }
    // Sui: base64 transaction bytes (or the SDK's JSON) a site asks Slush/Suiet to sign. A Sui node dry-runs it.
    if (pastedText && (Number(body?.chainId) === SUI_ID || (looksLikeSuiTx(pastedText) && !looksLikeSolanaTx(pastedText)))) {
      const l = lang(body.lang);
      if (!deps.suiLookup) return c.json({ error: 'Sui checks are not configured.' }, 503);
      return cached(key(['sui', pastedText.trim(), l]), () => explainSuiText(pastedText, deps.suiLookup), l, 'We could not read that Sui transaction. Paste the base64 text the site asks your wallet to sign.');
    }
    // TON: the TON Connect sendTransaction request ({ messages: [...] }), pasted whole.
    const tonReq = [body?.transaction, body, typeof body?.data === 'string' && body.data.trim().startsWith('{') ? (() => { try { return JSON.parse(body.data); } catch { return undefined; } })() : undefined].find(isTonRequest);
    if (tonReq) {
      const l = lang(body.lang);
      const bad = badTonAddress(tonReq);
      if (bad) return c.json({ error: `This TON request has an address that is not a valid TON address: ${bad}` }, 422);
      const k = key(['tonreq', tonReq, l]);
      const hit = await fromCache(k);
      if (hit) return c.json({ ...(hit as object), cached: true });
      try {
        return c.json(await respond(await tonFacts(tonReq, deps.tonLookup), l, k));
      } catch {
        return c.json({ error: 'We could not read that TON request.' }, 422);
      }
    }
    // Solana: the base64 (or base58) transaction a site asks Phantom/Solflare to sign, pasted whole.
    const solText = typeof body?.transaction === 'string' ? body.transaction : typeof body?.data === 'string' ? body.data : undefined;
    if (solText && (Number(body?.chainId) === SOLANA_ID || looksLikeSolanaTx(solText))) {
      const l = lang(body.lang);
      const k = key(['soltext', solText.trim(), l]);
      const hit = await fromCache(k);
      if (hit) return c.json({ ...(hit as object), cached: true });
      try {
        return c.json(await respond(await explainSolanaText(solText, deps.solanaRpc), l, k));
      } catch {
        return c.json({ error: 'We could not read that Solana transaction. Paste the base64 text the site asks your wallet to sign.' }, 422);
      }
    }
    // Tron: the transaction JSON a dApp asks TronLink to sign, pasted whole.
    const tronJson = (typeof body?.transaction === 'object' && !isTonRequest(body.transaction) ? body.transaction : undefined) ?? (typeof body?.data === 'string' && body.data.trim().startsWith('{') ? (() => { try { return JSON.parse(body.data); } catch { return undefined; } })() : undefined);
    if (tronJson) {
      const l = lang(body.lang);
      const k = key(['trontx', tronJson, l]);
      const hit = await fromCache(k);
      if (hit) return c.json({ ...(hit as object), cached: true });
      try {
        const t = await parseTronTx(tronJson);
        const facts = t.facts ?? (await decodeCall(t.call!, deps.resolveToken));
        return c.json(await respond(facts, l, k));
      } catch {
        return c.json({ error: 'We could not read that Tron transaction.' }, 422);
      }
    }
    if (body && Number(body.chainId) === TRON_ID && body.to) body.to = tronToHex(body.to) ?? body.to;
    if (!body?.to || !/^0x[0-9a-fA-F]{40}$/.test(body.to)) return c.json({ error: 'A valid "to" address is required.' }, 400);
    if (body.data !== undefined && body.data !== '' && (typeof body.data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(body.data.trim()))) return c.json({ error: 'The transaction data must be hex starting with 0x.' }, 400);
    if (body.value !== undefined && body.value !== '' && !/^(0x[0-9a-fA-F]+|\d+)$/.test(String(body.value))) return c.json({ error: 'The value must be a whole number (in the smallest unit) or hex.' }, 400);
    const l = lang(body.lang);
    const input = { chainId: body.chainId ? Number(body.chainId) : undefined, to: body.to, data: typeof body.data === 'string' && body.data.trim() ? body.data.trim() : undefined, value: body.value === '' ? undefined : body.value };
    const k = key(['call', input, l]);
    const hit = await fromCache(k);
    if (hit) return c.json({ ...(hit as object), cached: true });
    try {
      const facts = await decodeCall(input, deps.resolveToken);
      return c.json(await respond(facts, l, k));
    } catch {
      return c.json({ error: 'We could not read that transaction data.' }, 422);
    }
  });

  // EIP-7702: the contract address your wallet says it will "upgrade" your account to.
  app.post('/api/explain/delegation', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!/^0x[0-9a-fA-F]{40}$/.test(body?.address ?? '')) return c.json({ error: 'Paste the contract address your wallet wants to upgrade your account to.' }, 400);
    const chainId = body.chainId ? Number(body.chainId) : 1;
    const l = lang(body.lang);
    const k = key(['delegation', chainId, body.address.toLowerCase(), l]);
    const hit = await fromCache(k);
    if (hit) return c.json({ ...(hit as object), cached: true });
    if (!CHAINS[chainId]) return c.json({ error: 'Pick a supported network.' }, 400);
    try {
      return c.json(await respond(decodeDelegation({ chainId, address: body.address }), l, k));
    } catch {
      return c.json({ error: 'We could not check that address right now. Try again in a minute.' }, 503);
    }
  });

  app.post('/api/explain/tx', async (c) => {
    const body = await c.req.json().catch(() => null);
    const auto = body?.chainId === undefined || body?.chainId === null || body?.chainId === '' || body?.chainId === 'auto' || body?.chainId === 0;
    let chainId = auto ? undefined : Number(body?.chainId);
    if (!auto && !CHAINS[chainId!]) return c.json({ error: 'Pick a supported network.' }, 400);
    // Tron explorers show the hash without 0x; accept both.
    const rawHash = String(body?.hash ?? '').trim();
    // Solana signatures are base58, 87 or 88 characters.
    if (isSolSignature(rawHash) || chainId === SOLANA_ID) {
      if (!isSolSignature(rawHash)) return c.json({ error: 'A Solana transaction signature is 87 or 88 letters and numbers (copy it from Solscan or your wallet).' }, 400);
      if (!deps.solanaRpc) return c.json({ error: 'Transaction lookup is not configured.' }, 503);
      const l = lang(body.lang);
      const k = key(['soltx', rawHash, l]);
      const hit = await fromCache(k);
      if (hit) return c.json({ ...(hit as object), cached: true });
      let facts: Facts;
      try { facts = await fetchSolanaTx(rawHash, deps.solanaRpc); } catch { return c.json({ error: 'We could not find that transaction on Solana.' }, 404); }
      return c.json(await respond(facts, l, k));
    }
    // NEAR hashes look exactly like Sui digests (32 bytes, base58). Pick NEAR, or let us ask both.
    if (chainId === NEAR_ID || (auto && isSuiDigest(rawHash) && deps.nearLookup)) {
      if (!isSuiDigest(rawHash)) return c.json({ error: 'A NEAR transaction hash is 43 or 44 letters and numbers (copy it from NearBlocks or your wallet).' }, 400);
      if (!deps.nearLookup) return c.json({ error: 'Transaction lookup is not configured.' }, 503);
      const l = lang(body.lang);
      const kn = key(['neartx', rawHash, l]);
      const hitN = await fromCache(kn);
      if (hitN) return c.json({ ...(hitN as object), cached: true });
      let facts: Facts;
      try {
        facts = chainId === NEAR_ID || !deps.suiLookup ? await fetchNearTx(rawHash, deps.nearLookup) : await Promise.any([fetchNearTx(rawHash, deps.nearLookup), fetchSuiTx(rawHash, deps.suiLookup)]);
      } catch { return c.json({ error: chainId === NEAR_ID ? 'We could not find that transaction on NEAR.' : 'We could not find that transaction on NEAR or Sui.' }, 404); }
      return c.json(await respond(facts, l, kn));
    }
    // Sui: a 32-byte base58 digest (43 or 44 characters), from Suiscan or your wallet.
    if (isSuiDigest(rawHash) || chainId === SUI_ID) {
      if (!isSuiDigest(rawHash)) return c.json({ error: 'A Sui transaction digest is 43 or 44 letters and numbers (copy it from Suiscan or your wallet).' }, 400);
      if (!deps.suiLookup) return c.json({ error: 'Transaction lookup is not configured.' }, 503);
      const l = lang(body.lang);
      const k = key(['suitx', rawHash, l]);
      const hit = await fromCache(k);
      if (hit) return c.json({ ...(hit as object), cached: true });
      let facts: Facts;
      try { facts = await fetchSuiTx(rawHash, deps.suiLookup); } catch { return c.json({ error: 'We could not find that transaction on Sui.' }, 404); }
      return c.json(await respond(facts, l, k));
    }
    if ((ALGO_TXID_RE.test(rawHash) || chainId === ALGO_ID) && deps.algoLookup) {
      if (!ALGO_TXID_RE.test(rawHash)) return c.json({ error: 'An Algorand transaction ID is 52 capital letters and numbers (copy it from Pera or allo.info).' }, 400);
      const l = lang(body.lang);
      const k = key(['algotx', rawHash, l]);
      const hit = await fromCache(k);
      if (hit) return c.json({ ...(hit as object), cached: true });
      let facts: Facts;
      try { facts = await fetchAlgoTx(rawHash, deps.algoLookup); } catch { return c.json({ error: 'We could not find that transaction on Algorand.' }, 404); }
      return c.json(await respond(facts, l, k));
    }
    if (chainId === HL_ID) return c.json({ error: 'Hyperliquid trades and transfers are signed messages, not transactions with a hash. Paste the signature request your wallet shows instead.' }, 400);
    if ((chainId === STARKNET_ID || (chainId === undefined && STARKNET_HASH_RE.test(rawHash) && rawHash.length < 66)) && deps.snLookup) {
      if (!STARKNET_HASH_RE.test(rawHash)) return c.json({ error: 'A Starknet transaction hash starts with 0x (copy it from Voyager, Starkscan or your wallet).' }, 400);
      const l = lang(body.lang);
      const k = key(['sntx', rawHash.toLowerCase(), l]);
      const hit = await fromCache(k);
      if (hit) return c.json({ ...(hit as object), cached: true });
      let facts: Facts;
      try { facts = await fetchStarknetTx(rawHash, deps.snLookup); } catch { return c.json({ error: 'We could not find that transaction on Starknet.' }, 404); }
      return c.json(await respond(facts, l, k));
    }
    if (chainId === STX_ID && deps.stxLookup) {
      if (!/^(0x)?[0-9a-fA-F]{64}$/.test(rawHash)) return c.json({ error: 'A transaction hash is 64 characters (0x in front is optional).' }, 400);
      const l = lang(body.lang);
      const k = key(['stxtx', rawHash.toLowerCase(), l]);
      const hit = await fromCache(k);
      if (hit) return c.json({ ...(hit as object), cached: true });
      let facts: Facts;
      try { facts = await fetchStxTx(rawHash, deps.stxLookup); } catch { return c.json({ error: 'We could not find that transaction on Stacks.' }, 404); }
      return c.json(await respond(facts, l, k));
    }
    if ((chainId === APTOS_ID && deps.aptosLookup) || (chainId === XRPL_ID && deps.xrplLookup) || (chainId === MOVEMENT_ID && deps.movementLookup) || (chainId === MVX_ID && deps.mvxLookup)) {
      if (!/^(0x)?[0-9a-fA-F]{64}$/.test(rawHash)) return c.json({ error: 'A transaction hash is 64 characters (0x in front is optional).' }, 400);
      const l = lang(body.lang);
      const k = key(['nonevm', chainId, rawHash.toLowerCase(), l]);
      const hit = await fromCache(k);
      if (hit) return c.json({ ...(hit as object), cached: true });
      let facts: Facts;
      try { facts = chainId === APTOS_ID ? await fetchAptosTx(rawHash, deps.aptosLookup) : chainId === MOVEMENT_ID ? await fetchAptosTx(rawHash, deps.movementLookup, MOVEMENT_NET) : chainId === MVX_ID ? await fetchMvxTx(rawHash, deps.mvxLookup) : await fetchXrplTx(rawHash, deps.xrplLookup); } catch { return c.json({ error: `We could not find that transaction on ${CHAINS[chainId!].name}.` }, 404); }
      return c.json(await respond(facts, l, k));
    }
    // TON: tonviewer shows a 64-character hash, toncenter a 44-character base64 one. Either works.
    const tonB64 = /^[A-Za-z0-9+/_-]{43}=$/.test(rawHash);
    if ((tonB64 || chainId === TON_ID) && deps.tonLookup) {
      const l = lang(body.lang);
      const k = key(['tontx', rawHash, l]);
      const hit = await fromCache(k);
      if (hit) return c.json({ ...(hit as object), cached: true });
      let facts: Facts;
      try { facts = await fetchTonTx(rawHash, deps.tonLookup); } catch { return c.json({ error: 'We could not find that transaction on TON.' }, 404); }
      return c.json(await respond(facts, l, k));
    }
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(rawHash)) return c.json({ error: 'A transaction hash is 64 characters (0x in front is optional).' }, 400);
    if (!deps.fetchTx) return c.json({ error: 'Transaction lookup is not configured.' }, 503);
    const l = lang(body.lang);
    const hash = (rawHash.startsWith('0x') ? rawHash : '0x' + rawHash).toLowerCase();
    if (auto) {
      const hitAuto = await deps.store.get(key(['txauto', hash])).catch(() => undefined) as { chainId?: number } | undefined;
      if (hitAuto?.chainId && CHAINS[hitAuto.chainId]) chainId = hitAuto.chainId;
    }
    let input: Awaited<ReturnType<NonNullable<Deps['fetchTx']>>>;
    try {
      if (chainId === undefined) {
        // Paste a hash, we find the network: ask every network at once and take the one that has it.
        const ids = Object.keys(CHAINS).map(Number).filter((id) => ![SOLANA_ID, TON_ID, SUI_ID, APTOS_ID, XRPL_ID, NEAR_ID, MOVEMENT_ID, MVX_ID, HL_ID, ALGO_ID, STX_ID, STARKNET_ID].includes(id));
        type In = Awaited<ReturnType<NonNullable<Deps['fetchTx']>>>;
        const wrap = (id: number, p: Promise<Facts>) => p.then((f) => ({ id, r: { to: '', facts: f } as In }));
        const others = [
          ...(deps.tonLookup ? [wrap(TON_ID, fetchTonTx(hash, deps.tonLookup))] : []),
          ...(deps.aptosLookup ? [wrap(APTOS_ID, fetchAptosTx(hash, deps.aptosLookup))] : []),
          ...(deps.xrplLookup ? [wrap(XRPL_ID, fetchXrplTx(hash, deps.xrplLookup))] : []),
          ...(deps.movementLookup ? [wrap(MOVEMENT_ID, fetchAptosTx(hash, deps.movementLookup, MOVEMENT_NET))] : []),
          ...(deps.mvxLookup ? [wrap(MVX_ID, fetchMvxTx(hash, deps.mvxLookup))] : []),
          ...(deps.stxLookup ? [wrap(STX_ID, fetchStxTx(hash, deps.stxLookup))] : []),
          ...(deps.snLookup ? [wrap(STARKNET_ID, fetchStarknetTx(hash, deps.snLookup))] : []),
        ];
        const found = await Promise.any([...ids.map((id) => deps.fetchTx!(id, hash).then((r) => ({ id, r }))), ...others]);
        chainId = found.id;
        input = found.r;
        await deps.store.put(key(['txauto', hash]), { chainId }).catch(() => undefined);
      } else {
        input = await deps.fetchTx(chainId, hash);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('created a contract')) return c.json({ error: msg }, 404);
      return c.json({ error: auto ? `We could not find that transaction on any of the ${Object.keys(CHAINS).length} networks we check.` : 'We could not find that transaction on this network.' }, 404);
    }
    const k = key(['tx', chainId, hash, l]);
    const hit = await fromCache(k);
    if (hit) return c.json({ ...(hit as object), cached: true });
    try {
      // A type-4 transaction can upgrade accounts as well as make a call. An unrecognised upgrade outranks whatever the call does.
      for (const a of input.authorizations ?? []) {
        const df = decodeDelegation({ chainId, address: a.address });
        const delegateCode = deps.codeInfo ? await deps.codeInfo(chainId, a.address).catch(() => undefined) : undefined;
        const fl = assessRisk(df, { drainers: drainerSet(), delegateCode });
        if (fl.some((x) => x.severity === 'danger')) return c.json(await respond(df, l, k));
      }
      const facts = input.facts ?? (await decodeCall({ ...input, chainId }, deps.resolveToken));
      return c.json(await respond(facts, l, k));
    } catch {
      return c.json({ error: 'We found the transaction but could not read it.' }, 422);
    }
  });

  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { onchainResolver, fetchTransaction, isContract, codeInfo } = await import('./rpc.js');
  const { solanaRpc } = await import('./solana.js');
  const { tonLookup } = await import('./ton.js');
  const { suiLookup } = await import('./sui.js');
  const { aptosLookup, movementLookup } = await import('./aptos.js');
  const { mvxLookup } = await import('./multiversx.js');
  const { algoLookup } = await import('./algorand.js');
  const { stxLookup } = await import('./stacks.js');
  const { snLookup } = await import('./starknet.js');
  const { xrplLookup } = await import('./xrpl.js');
  const { nearLookup } = await import('./near.js');
  const app = createApp({
    llm: rumptyLlm(),
    store: createStore(),
    resolveToken: onchainResolver,
    fetchTx: fetchTransaction,
    isContract,
    codeInfo,
    solanaRpc,
    tonLookup,
    suiLookup,
    aptosLookup,
    movementLookup,
    mvxLookup,
    algoLookup,
    stxLookup,
    snLookup,
    xrplLookup,
    nearLookup,
  });
  void startDrainerRefresh().then((s) => console.log(`Drainer list: ${s.count} addresses${s.lastError ? ` (feed error: ${s.lastError})` : ''}`));
  const port = Number(process.env.PORT ?? 8080);
  serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });
  console.log(`WetinSign listening on :${port} (AI: ${process.env.RUMPTY_API_KEY ? 'Rumpty Cloud' : 'templates only'})`);
}
