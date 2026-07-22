// Turning text into vectors, via whichever provider the account already uses.
//
// This is the only place in the app that sends corpus or note text to an embeddings endpoint, which
// is why the feature is opt-in: everything else about the memory/corpus stack is local. Nothing here
// runs unless the user has switched semantic search on.
//
// Anthropic publishes no embeddings API. Rather than silently substituting another vendor (which
// would send the user's text somewhere they never chose), that case reports itself and the caller
// falls back to keyword search.
import { withRequestTimeout } from './sse';
import { EMBEDDING_MODELS, normalizeVector } from '../../shared/embeddings';

/** Per request, so one oversized batch cannot stall a scan. */
const EMBED_TIMEOUT_MS = 30_000;
/** Providers accept far more, but small batches keep a failure cheap to retry and to attribute. */
export const EMBED_BATCH = 64;

export interface EmbedResult {
  /** Unit vectors, in the same order as the input texts. */
  vectors: number[][];
  model: string;
}

/** The model this provider embeds with, or null when it cannot embed at all. */
export function embeddingModelFor(provider: string): string | null {
  return EMBEDDING_MODELS[String(provider ?? '')] ?? null;
}

/**
 * Embed a batch of texts.
 *
 * Vectors come back NORMALIZED, so every later comparison is a plain dot product and no caller has to
 * remember to do it. Throws with a readable message on any provider failure; callers treat that as
 * "no semantic search this time", never as a fatal error.
 */
export async function embedTexts(
  provider: string,
  apiKey: string,
  texts: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<EmbedResult> {
  const model = embeddingModelFor(provider);
  if (!model) throw new Error(`${provider} does not offer an embeddings API.`);
  const input = (texts ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (!input.length) return { vectors: [], model };

  const vectors: number[][] = [];
  for (let i = 0; i < input.length; i += EMBED_BATCH) {
    const batch = input.slice(i, i + EMBED_BATCH);
    const got = provider === 'gemini'
      ? await geminiEmbed(apiKey, model, batch, fetchImpl)
      : await openaiEmbed(apiKey, model, batch, fetchImpl);
    if (got.length !== batch.length) {
      throw new Error(`${provider} returned ${got.length} embeddings for ${batch.length} inputs.`);
    }
    for (const v of got) vectors.push(normalizeVector(v));
  }
  return { vectors, model };
}

async function openaiEmbed(apiKey: string, model: string, input: string[], doFetch: typeof fetch): Promise<number[][]> {
  const res = await withRequestTimeout('OpenAI', undefined, ({ signal }) => doFetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input }),
    signal,
  }), EMBED_TIMEOUT_MS);
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${await errorText(res)}`);
  const json = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
  const rows = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return rows.map((r) => (Array.isArray(r.embedding) ? r.embedding : []));
}

async function geminiEmbed(apiKey: string, model: string, input: string[], doFetch: typeof fetch): Promise<number[][]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;
  const res = await withRequestTimeout('Gemini', undefined, ({ signal }) => doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests: input.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] } })) }),
    signal,
  }), EMBED_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Gemini embeddings ${res.status}: ${await errorText(res)}`);
  const json = (await res.json()) as { embeddings?: Array<{ values?: number[] }> };
  return (json.embeddings ?? []).map((e) => (Array.isArray(e.values) ? e.values : []));
}

/** The provider's own message, trimmed, and never the request body (which carries the API key). */
async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string };
    const msg = typeof j.error === 'object' ? j.error?.message : j.error;
    if (msg) return String(msg).slice(0, 200);
  } catch { /* not JSON: fall through to the raw text */ }
  return text.slice(0, 200);
}
