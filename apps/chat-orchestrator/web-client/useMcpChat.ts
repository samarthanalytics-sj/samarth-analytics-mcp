/**
 * useMcpChat - streaming chat hook for the AI Tag Manager web app.
 *
 * Copy to: src/hooks/useMcpChat.ts in the gtm-ai-automator repo.
 *
 * Talks to the chat orchestrator over SSE. The orchestrator is the only tier the browser may reach:
 * the MCP server itself sets no CORS headers and holds sessions in process memory, so it can never
 * be called directly from here.
 */
import { useCallback, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

const ORCHESTRATOR_URL =
  (import.meta.env.VITE_ORCHESTRATOR_URL as string | undefined) ?? 'http://127.0.0.1:8787';

export type ChatProduct = 'gtm' | 'ga4';

export interface ToolTrace {
  id: string;
  name: string;
  args: unknown;
  status: 'running' | 'ok' | 'failed';
  summary?: string;
}

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tools: ToolTrace[];
  /** Set when the turn ended for a reason the user should know about. */
  note?: string;
  error?: string;
}

export interface ChatContextSelection {
  accountId?: string;
  containerId?: string;
  workspaceId?: string;
  propertyId?: string;
}

interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

const STOP_NOTES: Record<string, string> = {
  tool_budget: 'Stopped at the tool-call limit for one message. Ask me to continue.',
  time_budget: 'Stopped at the time limit for one message. Try a narrower question.',
  aborted: 'Stopped.',
};

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function useMcpChat(product: ChatProduct) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [usage, setUsage] = useState<UsageTotals>({
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
  });
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  }, []);

  const reset = useCallback(() => {
    stop();
    setTurns([]);
    setUsage({ promptTokens: 0, completionTokens: 0, cachedTokens: 0 });
  }, [stop]);

  const send = useCallback(
    async (text: string, context: ChatContextSelection = {}) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;

      const userTurn: ChatTurn = { id: newId(), role: 'user', content: trimmed, tools: [] };
      const assistantId = newId();
      const assistantTurn: ChatTurn = { id: assistantId, role: 'assistant', content: '', tools: [] };

      // Snapshot the history the model should see, before the new turns are appended.
      const history = turns
        .filter((t) => t.content.trim())
        .map((t) => ({ role: t.role, content: t.content }));

      setTurns((prev) => [...prev, userTurn, assistantTurn]);
      setIsStreaming(true);

      const patch = (fn: (turn: ChatTurn) => ChatTurn): void => {
        setTurns((prev) => prev.map((t) => (t.id === assistantId ? fn(t) : t)));
      };

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) throw new Error('Your session expired. Please sign in again.');

        const res = await fetch(`${ORCHESTRATOR_URL}/v1/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            messages: [...history, { role: 'user', content: trimmed }],
            context: { product, ...context },
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}) as { message?: string });
          throw new Error(body.message ?? `Request failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }

            switch (event.type) {
              case 'token':
                patch((t) => ({ ...t, content: t.content + (event.text as string) }));
                break;

              case 'tool_call':
                patch((t) => ({
                  ...t,
                  tools: [
                    ...t.tools,
                    {
                      id: event.id as string,
                      name: event.name as string,
                      args: event.args,
                      status: 'running',
                    },
                  ],
                }));
                break;

              case 'tool_result':
                patch((t) => ({
                  ...t,
                  tools: t.tools.map((tool) =>
                    tool.id === event.id
                      ? {
                          ...tool,
                          status: event.ok ? 'ok' : 'failed',
                          summary: event.summary as string,
                        }
                      : tool,
                  ),
                }));
                break;

              case 'usage':
                setUsage((u) => ({
                  promptTokens: u.promptTokens + (event.promptTokens as number),
                  completionTokens: u.completionTokens + (event.completionTokens as number),
                  cachedTokens: u.cachedTokens + (event.cachedTokens as number),
                }));
                break;

              case 'error':
                patch((t) => ({ ...t, error: event.message as string }));
                break;

              case 'done': {
                const note = STOP_NOTES[event.reason as string];
                if (note) patch((t) => ({ ...t, note }));
                break;
              }
            }
          }
        }
      } catch (err) {
        // An abort is a user action, not a failure to report.
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          patch((t) => ({
            ...t,
            error: err instanceof Error ? err.message : 'Something went wrong.',
          }));
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [isStreaming, product, turns],
  );

  return { turns, send, stop, reset, isStreaming, usage };
}

/** Fetches the slash commands the MCP server registers, so the UI never hardcodes them. */
export async function fetchCommands(): Promise<
  { name: string; title: string; description: string }[]
> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return [];
  const res = await fetch(`${ORCHESTRATOR_URL}/v1/commands`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { commands?: { name: string; title: string; description: string }[] };
  return body.commands ?? [];
}

/** Expands a registered MCP prompt into the message text that starts a turn. */
export async function expandCommand(
  name: string,
  args: Record<string, string> = {},
): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  const res = await fetch(`${ORCHESTRATOR_URL}/v1/commands/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ arguments: args }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { text?: string };
  return body.text ?? null;
}
