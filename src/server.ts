import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
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
}

/** Nigerian Pidgin is ISO 639-3 "pcm"; also accept the plain word so a stray "pidgin" does not silently fall back to English. */
export const lang = (v: unknown): Lang => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'pcm' || s === 'pidgin' || s === 'naija' ? 'pcm' : 'en';
};
// Bump when decoding or wording changes, so answers cached by older code are never served again.
const CACHE_VERSION = 'v20';
const key = (parts: unknown) => createHash('sha256').update(CACHE_VERSION).update(JSON.stringify(parts, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).digest('hex');

export function createApp(deps: Deps) {
  const app = new Hono();
  const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');

  async function respond(facts: Facts, l: Lang, cacheKey: string) {
    const spenderIsContract = deps.isContract ? await deps.isContract(facts.chainId, facts.spender) : undefined;
    const delegateCode = facts.kind === 'delegation' && deps.codeInfo && facts.spender ? await deps.codeInfo(facts.chainId, facts.spender) : undefined;
    const flags = assessRisk(facts, { spenderIsContract, delegateCode });
    // Risk is judged on 0x addresses; Tron users then see the T… addresses their wallet shows.
    const shown = tronDisplay(facts);
    const explanation = await explain(shown, flags, l, deps.llm);
    const result = { facts: shown, flags, explanation };
    await deps.store.put(cacheKey, result).catch(() => undefined);
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
    const hit = await deps.store.get(k).catch(() => undefined);
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
    // Solana: the base64 (or base58) transaction a site asks Phantom/Solflare to sign, pasted whole.
    const solText = typeof body?.transaction === 'string' ? body.transaction : typeof body?.data === 'string' ? body.data : undefined;
    if (solText && (Number(body?.chainId) === SOLANA_ID || looksLikeSolanaTx(solText))) {
      const l = lang(body.lang);
      const k = key(['soltext', solText.trim(), l]);
      const hit = await deps.store.get(k).catch(() => undefined);
      if (hit) return c.json({ ...(hit as object), cached: true });
      try {
        return c.json(await respond(await explainSolanaText(solText, deps.solanaRpc), l, k));
      } catch {
        return c.json({ error: 'We could not read that Solana transaction. Paste the base64 text the site asks your wallet to sign.' }, 422);
      }
    }
    // Tron: the transaction JSON a dApp asks TronLink to sign, pasted whole.
    const tronJson = (typeof body?.transaction === 'object' ? body.transaction : undefined) ?? (typeof body?.data === 'string' && body.data.trim().startsWith('{') ? (() => { try { return JSON.parse(body.data); } catch { return undefined; } })() : undefined);
    if (tronJson) {
      const l = lang(body.lang);
      const k = key(['trontx', tronJson, l]);
      const hit = await deps.store.get(k).catch(() => undefined);
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
    const l = lang(body.lang);
    const input = { chainId: body.chainId ? Number(body.chainId) : undefined, to: body.to, data: body.data, value: body.value };
    const k = key(['call', input, l]);
    const hit = await deps.store.get(k).catch(() => undefined);
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
    const hit = await deps.store.get(k).catch(() => undefined);
    if (hit) return c.json({ ...(hit as object), cached: true });
    return c.json(await respond(decodeDelegation({ chainId, address: body.address }), l, k));
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
      const hit = await deps.store.get(k).catch(() => undefined);
      if (hit) return c.json({ ...(hit as object), cached: true });
      let facts: Facts;
      try { facts = await fetchSolanaTx(rawHash, deps.solanaRpc); } catch { return c.json({ error: 'We could not find that transaction on Solana.' }, 404); }
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
        const ids = Object.keys(CHAINS).map(Number).filter((id) => id !== SOLANA_ID);
        const found = await Promise.any(ids.map((id) => deps.fetchTx!(id, hash).then((r) => ({ id, r }))));
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
    const hit = await deps.store.get(k).catch(() => undefined);
    if (hit) return c.json({ ...(hit as object), cached: true });
    try {
      // A type-4 transaction can upgrade accounts as well as make a call. An unrecognised upgrade outranks whatever the call does.
      for (const a of input.authorizations ?? []) {
        const df = decodeDelegation({ chainId, address: a.address });
        const delegateCode = deps.codeInfo ? await deps.codeInfo(chainId, a.address) : undefined;
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
  const app = createApp({
    llm: rumptyLlm(),
    store: createStore(),
    resolveToken: onchainResolver,
    fetchTx: fetchTransaction,
    isContract,
    codeInfo,
    solanaRpc,
  });
  void startDrainerRefresh().then((s) => console.log(`Drainer list: ${s.count} addresses${s.lastError ? ` (feed error: ${s.lastError})` : ''}`));
  const port = Number(process.env.PORT ?? 8080);
  serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });
  console.log(`WetinSign listening on :${port} (AI: ${process.env.RUMPTY_API_KEY ? 'Rumpty Cloud' : 'templates only'})`);
}
