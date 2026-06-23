// Shared Server-Sent-Events plumbing for streaming LLM responses. Reads a fetch
// Response body and yields the payload of each `data:` line. Uses global fetch /
// web streams (Node 20 / Electron undici) — no dependencies.

export async function startStream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  providerLabel: string,
  signal?: AbortSignal
): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let j: { error?: { message?: string } | string } | null = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      j = null;
    }
    const msg = (typeof j?.error === 'object' ? j?.error?.message : j?.error) ?? text.slice(0, 300);
    throw new Error(`${providerLabel} API error ${res.status}: ${msg}`);
  }
  return res;
}

export async function* sseEvents(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) {
        yield line.slice(5).trimStart();
      }
    }
  }
}
