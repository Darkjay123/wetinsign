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

export interface Deps {
  llm?: Llm;
  store: Store;
  resolveToken?: TokenResolver;
  codeInfo?: (chainId: number | undefined, address: string) => Promise<{ size: number; hash: string; code?: string } | undefined>;
  fetchTx?: (chainId: number, hash: string) => Promise<{ chainId?: number; to: string; data?: string; value?: string | bigint; authorizations?: { address: string; chainId?: number }[] }>;
  isContract?: (chainId: number | undefined, address?: string) => Promise<boolean | undefined>;
}

/** Nigerian Pidgin is ISO 639-3 "pcm"; also accept the plain word so a stray "pidgin" does not silently fall back to English. */
export const lang = (v: unknown): Lang => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'pcm' || s === 'pidgin' || s === 'naija' ? 'pcm' : 'en';
};
// Bump when decoding or wording changes, so answers cached by older code are never served again.
const CACHE_VERSION = 'v16';
const key = (parts: unknown) => createHash('sha256').update(CACHE_VERSION).update(JSON.stringify(parts, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).digest('hex');

export function createApp(deps: Deps) {
  const app = new Hono();
  const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');

  async function respond(facts: Facts, l: Lang, cacheKey: string) {
    const spenderIsContract = deps.isContract ? await deps.isContract(facts.chainId, facts.spender) : undefined;
    const delegateCode = facts.kind === 'delegation' && deps.codeInfo && facts.spender ? await deps.codeInfo(facts.chainId, facts.spender) : undefined;
    const flags = assessRisk(facts, { spenderIsContract, delegateCode });
    const explanation = await explain(facts, flags, l, deps.llm);
    const result = { facts, flags, explanation };
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
  app.get('/api/chains', (c) => c.json(Object.values(CHAINS).map(({ id, name }) => ({ id, name }))));

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
    const chainId = Number(body?.chainId);
    if (!CHAINS[chainId]) return c.json({ error: 'Pick a supported network.' }, 400);
    if (!/^0x[0-9a-fA-F]{64}$/.test(body?.hash ?? '')) return c.json({ error: 'A transaction hash is 0x followed by 64 characters.' }, 400);
    if (!deps.fetchTx) return c.json({ error: 'Transaction lookup is not configured.' }, 503);
    const l = lang(body.lang);
    const k = key(['tx', chainId, body.hash.toLowerCase(), l]);
    const hit = await deps.store.get(k).catch(() => undefined);
    if (hit) return c.json({ ...(hit as object), cached: true });
    try {
      const input = await deps.fetchTx(chainId, body.hash);
      // A type-4 transaction can upgrade accounts as well as make a call. An unrecognised upgrade outranks whatever the call does.
      for (const a of input.authorizations ?? []) {
        const df = decodeDelegation({ chainId, address: a.address });
        const delegateCode = deps.codeInfo ? await deps.codeInfo(chainId, a.address) : undefined;
        const fl = assessRisk(df, { drainers: drainerSet(), delegateCode });
        if (fl.some((x) => x.severity === 'danger')) return c.json(await respond(df, l, k));
      }
      const facts = await decodeCall(input, deps.resolveToken);
      return c.json(await respond(facts, l, k));
    } catch (e) {
      return c.json({ error: e instanceof Error && e.message.includes('created a contract') ? e.message : 'We could not find that transaction on this network.' }, 404);
    }
  });

  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { onchainResolver, fetchTransaction, isContract, codeInfo } = await import('./rpc.js');
  const app = createApp({
    llm: rumptyLlm(),
    store: createStore(),
    resolveToken: onchainResolver,
    fetchTx: fetchTransaction,
    isContract,
    codeInfo,
  });
  void startDrainerRefresh().then((s) => console.log(`Drainer list: ${s.count} addresses${s.lastError ? ` (feed error: ${s.lastError})` : ''}`));
  const port = Number(process.env.PORT ?? 8080);
  serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });
  console.log(`WetinSign listening on :${port} (AI: ${process.env.RUMPTY_API_KEY ? 'Rumpty Cloud' : 'templates only'})`);
}
