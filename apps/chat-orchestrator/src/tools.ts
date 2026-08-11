/**
 * Tool scoping.
 *
 * The MCP registers 178 tools. Sending all of them to the model on every request would cost roughly
 * 20-40k tokens of schemas per call and degrade selection quality, so the visible surface is scoped
 * by product and by read/write before it ever reaches OpenAI.
 */
import type { Product } from './config.js';
import { connectedWriteAllowed } from './integrations.js';
import type { ChatMessage, ToolDef } from './types.js';

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
  /** Offers GTM deletes. Requires includeWrites; ignored without it. */
  includeDeletes?: boolean;
  /**
   * Other products the user has CONNECTED to this chat. Already sanitized. Each contributes its
   * reads plus only its allowlisted writes; see integrations.ts for why.
   */
  integrations?: readonly Product[];
  /** Hard ceiling on how many tools are advertised in one request. */
  maxTools?: number;
  /** Called when the ceiling actually dropped tools, so a silent cap cannot go unnoticed. */
  onTruncated?(dropped: string[]): void;
}

export function scopeTools(all: ToolDef[], opts: ScopeOptions): ToolDef[] {
  // Enabling writes roughly doubles the surface, so the ceiling has to move with it or the cap
  // silently swallows the write tools the model was just given permission to use.
  const {
    product,
    includeWrites,
    includeDeletes = false,
    integrations = [],
    onTruncated,
  } = opts;

  const connected = new Set(integrations.filter((p) => p !== product));

  /**
   * NO CEILING BY DEFAULT.
   *
   * There used to be one (120 with writes, 60 without) because the whole permitted set was sent to
   * the model on every step. Progressive disclosure now decides what is SENT, so this function's
   * job is only to decide what is PERMITTED, and truncating that is actively harmful: a tool cut
   * here is gone from the permitted set entirely, so enable_tool_group cannot reveal it either and
   * the capability is unreachable rather than merely hidden.
   *
   * Callers may still pass an explicit ceiling; onTruncated still fires when it bites.
   */
  const maxTools = opts.maxTools ?? Number.POSITIVE_INFINITY;

  const inScope = all.filter((t) => {
    // Destructive tools are withheld unconditionally. An approval card is a reasonable gate for
    // creating a tag and not for deleting one, and a GA4 archive is irreversible. These stay off at
    // the MCP guardrail level too, so this is the second of two independent refusals.
    // Publishing and GA4 archives are never offered, whatever the settings.
    if (t.isDestructive) return false;
    if (t.isDelete && !(includeWrites && includeDeletes)) return false;
    if (t.isWrite && !includeWrites) return false;
    if (ALWAYS_AVAILABLE.has(t.name)) return true;

    const owner = productOf(t.name);
    if (owner === product) return true;

    // A CONNECTED product contributes all of its reads, but only the writes its workflow needs.
    // Its deletes never arrive here at all: they were already refused above, and they are absent
    // from the allowlist as well, so this is two independent refusals rather than one.
    if (connected.has(owner)) {
      return t.isWrite ? connectedWriteAllowed(owner, t.name) : true;
    }
    return false;
  });

  // Reads first, so a truncation caused by maxTools never removes the ability to look something up
  // while leaving the ability to change it.
  // Reads first, then writes, then deletes. If the ceiling truncates, it removes the most
  // consequential tools before the least.
  const rank = (t: ToolDef): number => (t.isDelete ? 2 : t.isWrite ? 1 : 0);
  inScope.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

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

/** Enough of a result to keep reasoning with, once the full text has aged out. */
const DIGEST_CHARS = 400;

/**
 * Shrinks OLD tool results so a multi-step turn stops re-sending everything it has ever read.
 *
 * The message array is resent in full on every round trip, so a turn that calls seven tools pays
 * for the first tool's output seven times. Measured on a real tag-creation turn: seven calls,
 * 7.8s of actual tool time, 125s of wall clock, 98,123 prompt tokens. The per-round-trip gaps grew
 * 3s, 4s, 26s, 26s, 30s — the shape of a prompt getting longer, not of work getting harder.
 *
 * Newest results are kept whole, because those are what the model is reasoning about right now.
 * Older ones are cut to a digest once the budget is spent. Nothing is REMOVED: OpenAI rejects an
 * assistant message whose tool_call_id has no matching tool message, and more importantly a
 * silently vanished result would read as a tool that returned nothing.
 *
 * Returns a new array; the input is not mutated.
 */
export function compactToolHistory(messages: ChatMessage[], budgetChars: number): ChatMessage[] {
  let spent = 0;
  const out = [...messages];

  // Backwards: the most recent results are the ones worth their full size.
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== 'tool' || typeof m.content !== 'string') continue;
    const content: string = m.content;

    if (spent + content.length <= budgetChars) {
      spent += content.length;
      continue;
    }

    // Already short enough that a digest would not save anything worth the loss.
    if (content.length <= DIGEST_CHARS) {
      spent += content.length;
      continue;
    }

    const dropped = content.length - DIGEST_CHARS;
    out[i] = {
      ...m,
      content:
        `${m.content.slice(0, DIGEST_CHARS)}\n\n[EARLIER RESULT, SHORTENED: ${dropped.toLocaleString()} ` +
        `characters from this tool result are no longer in context. It is not empty and it did not ` +
        `fail — only the tail was dropped to keep this turn fast. Call the tool again if you need ` +
        `the part that is missing.]`,
    };
    spent += DIGEST_CHARS;
  }

  return out;
}
