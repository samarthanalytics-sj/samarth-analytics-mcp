/**
 * Shared response helpers for MCP tool handlers.
 *
 * Every tool returns the MCP content envelope `{ content: [{ type: 'text',
 * text }] }`, and on failure `{ isError: true, content: [...] }`. These helpers
 * centralize that envelope so each handler describes only its payload, not the
 * wrapping. Output is byte-for-byte identical to the previous inline form:
 * JSON is stringified with `(value, null, 2)` and errors keep the
 * `"<tool> failed: <message>"` shape via formatGoogleError.
 */

import { formatGoogleError } from './guardrails.js';

/**
 * MCP tool handler return shape (text content envelope). The index signature
 * keeps this assignable to the MCP SDK's `CallToolResult`, which carries an
 * open `{ [x: string]: unknown }` member alongside `content`.
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

/** Wrap a plain string as a text result (dry-run notices, delete confirmations). */
export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * Format a caught error into the standard tool error envelope:
 * `{ isError: true, content: [{ type: 'text', text: "<tool> failed: <msg>" }] }`.
 */
export function errorResult(toolName: string, err: unknown): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `${toolName} failed: ${formatGoogleError(err)}` }],
  };
}

/** Wrap a string as an error result without the Google error formatting. */
export function errorText(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}
