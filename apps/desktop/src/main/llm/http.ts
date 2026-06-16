// Minimal JSON POST helper with provider-aware error messages. Uses global fetch
// (Node 20 / Electron). Keeps the LLM clients dependency-free.
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  providerLabel: string
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const j = json as { error?: { message?: string } | string } | null;
    const msg =
      (typeof j?.error === 'object' ? j?.error?.message : j?.error) ?? text.slice(0, 300);
    throw new Error(`${providerLabel} API error ${res.status}: ${msg}`);
  }
  return json;
}
