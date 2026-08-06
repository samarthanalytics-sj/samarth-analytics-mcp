/**
 * Tool scoping.
 *
 * The MCP registers 178 tools. Sending all of them to the model on every request would cost roughly
 * 20-40k tokens of schemas per call and degrade selection quality, so the visible surface is scoped
 * by product and by read/write before it ever reaches OpenAI.
 */
import type { Product } from './config.js';
import type { ToolDef } from './types.js';

/** GA4 tools are the ga4_-prefixed ones; everything else in this server is GTM. */
export function productOf(toolName: string): Product {
  return toolName.startsWith('ga4_') ? 'ga4' : 'gtm';
}

/**
 * Tools that are always useful regardless of the selected product, because a GA4 question often
 * needs the container context and vice versa.
 */
const ALWAYS_AVAILABLE = new Set(['accounts_list', 'containers_list', 'containers_lookup']);

export interface ScopeOptions {
  product: Product;
  includeWrites: boolean;
  /** Hard ceiling on how many tools are advertised in one request. */
  maxTools?: number;
  /** Called when the ceiling actually dropped tools, so a silent cap cannot go unnoticed. */
  onTruncated?(dropped: string[]): void;
}

export function scopeTools(all: ToolDef[], opts: ScopeOptions): ToolDef[] {
  // Enabling writes roughly doubles the surface, so the ceiling has to move with it or the cap
  // silently swallows the write tools the model was just given permission to use.
  const { product, includeWrites, maxTools = includeWrites ? 120 : 60, onTruncated } = opts;

  const inScope = all.filter((t) => {
    // Destructive tools are withheld unconditionally. An approval card is a reasonable gate for
    // creating a tag and not for deleting one, and a GA4 archive is irreversible. These stay off at
    // the MCP guardrail level too, so this is the second of two independent refusals.
    if (t.isDestructive) return false;
    if (t.isWrite && !includeWrites) return false;
    if (ALWAYS_AVAILABLE.has(t.name)) return true;
    return productOf(t.name) === product;
  });

  // Reads first, so a truncation caused by maxTools never removes the ability to look something up
  // while leaving the ability to change it.
  inScope.sort((a, b) => {
    if (a.isWrite !== b.isWrite) return a.isWrite ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  if (inScope.length > maxTools) {
    // A capped tool list is indistinguishable from a short one from the model's side: it simply
    // never sees the tool and reports it cannot do the thing. Say so in the log at least.
    onTruncated?.(inScope.slice(maxTools).map((t) => t.name));
  }
  return inScope.slice(0, maxTools);
}

/** OpenAI Chat Completions function-tool shape. */
export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export function toOpenAiTools(tools: ToolDef[]): OpenAiTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      // OpenAI truncates very long descriptions unpredictably; keep them bounded and intact.
      description: t.description.slice(0, 1024),
      parameters: normalizeSchema(t.inputSchema),
    },
  }));
}

/**
 * Ensures the schema is a well-formed JSON Schema object. MCP servers may omit `properties` for a
 * no-argument tool, which OpenAI rejects.
 */
function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };
  if (out.type !== 'object') out.type = 'object';
  if (!out.properties || typeof out.properties !== 'object') out.properties = {};
  // `$schema` is not part of the function-calling contract and only wastes tokens.
  delete out.$schema;
  return out;
}

/**
 * Truncates an oversized tool result while preserving the fact that it was truncated.
 *
 * Silent truncation is the dangerous case: the model would report a partial container as complete.
 */
export function capToolResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const dropped = text.length - maxChars;
  return (
    `${head}\n\n[TRUNCATED: ${dropped.toLocaleString()} more characters were omitted from this tool ` +
    `result. This list is INCOMPLETE. Say so explicitly, and narrow the query or paginate rather ` +
    `than presenting it as the full set.]`
  );
}
