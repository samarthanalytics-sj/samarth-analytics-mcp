/**
 * MCP tool response envelope helpers — mirrors src/utils/toolResponse.ts at the
 * repo root so the two servers feel identical to clients.
 */

export interface ToolResult {
  [x: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** Wrap a value as a pretty-printed JSON text result. */
export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Wrap a plain string as a text result. */
export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Format a caught error into the standard tool error envelope. */
export function errorResult(toolName: string, err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: `${toolName} failed: ${msg}` }],
  };
}

/** Wrap a string as an error result without any extra formatting. */
export function errorText(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}
