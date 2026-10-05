import OpenAI from 'openai';
import type { Llm } from './explain.js';

/** Outcome of the most recent AI call, so /healthz reports whether AI is answering, not just whether a key is set. */
export const aiStatus: { last: 'ok' | 'error' | null; at: string | null; error: string | null } = { last: null, at: null, error: null };

/**
 * Rumpty Cloud AI inference is OpenAI-compatible and runs open models on GPUs in Lagos.
 * Returns undefined when no key is configured, in which case explanations use the templates.
 */
export function rumptyLlm(env: NodeJS.ProcessEnv = process.env): Llm | undefined {
  const apiKey = env.RUMPTY_API_KEY;
  if (!apiKey) return undefined;
  const client = new OpenAI({
    apiKey,
    baseURL: env.RUMPTY_BASE_URL ?? 'https://chat.rumptycloud.com/v1',
    timeout: Number(env.LLM_TIMEOUT_MS ?? 15000),
    maxRetries: 1,
  });
  const model = env.RUMPTY_MODEL ?? 'llama3.2:3b';
  return async (messages) => {
    try {
      const res = await client.chat.completions.create({ model, messages, temperature: 0.2, max_tokens: 220 });
      Object.assign(aiStatus, { last: 'ok', at: new Date().toISOString(), error: null });
      return res.choices[0]?.message?.content ?? '';
    } catch (e) {
      Object.assign(aiStatus, { last: 'error', at: new Date().toISOString(), error: e instanceof Error ? e.message.slice(0, 120) : 'unknown' });
      throw e;
    }
  };
}
