import { anthropicClient } from './anthropic';
import { openaiClient } from './openai';
import { geminiClient } from './gemini';
import { capToolResult } from '../../shared/context-budget';
import { attachReference, referenceForResult, referenceForError } from '../../shared/jit-reference';
import type {
  LlmClient,
  LlmProvider,
  LlmToolCall,
  LlmTurn,
  RetryNotice,
  ToolExecutor,
} from './types';

/** Resolve the LLM client for a provider. */
export function createProvider(provider: LlmProvider): LlmClient {
  switch (provider) {
    case 'anthropic':
      return anthropicClient;
    case 'openai':
      return openaiClient;
    case 'gemini':
      return geminiClient;
    default:
      throw new Error(`Unknown LLM provider: ${provider as string}`);
  }
}

export interface RunChatInput {
  system: string;
  model: string;
  apiKey: string;
  messages: LlmTurn[];
  /** When aborted, the loop stops and returns the text so far (user pressed Stop). */
  signal?: AbortSignal;
}

export interface RunChatResult {
  text: string;
  steps: number;
}

export interface RunChatCallbacks {
  /** Streamed text chunks from the model as they arrive. */
  onDelta?: (text: string) => void;
  /** Fired when the model invokes a tool. */
  onToolCall?: (call: LlmToolCall) => void;
  /** Fired after a tool runs: ok=false carries the error so the UI can show failures. `content` is
   *  the tool's raw output on success, so the caller can carry it into the NEXT turn's context
   *  (see tool-memory.ts) instead of the model re-calling the same tool to re-learn the answer. */
  onToolResult?: (result: { name: string; ok: boolean; error?: string; args?: Record<string, unknown>; content?: string }) => void;
  /** Fired when the provider rate-limits us and the request is about to be retried, so the UI can
   *  show "retrying in Ns" rather than an unexplained pause. */
  onRetry?: (notice: RetryNotice) => void;
}

/**
 * Agentic loop: stream a model turn; if it asks for tools, execute them, feed the
 * results back, and repeat until it produces a final text answer (or hits
 * maxSteps). Provider-agnostic — works for any LlmClient.
 */
export async function runChat(
  client: LlmClient,
  input: RunChatInput,
  executor: ToolExecutor,
  callbacks: RunChatCallbacks = {},
  maxSteps = 6
): Promise<RunChatResult> {
  const messages: LlmTurn[] = [...input.messages];
  const tools = executor.list();
  let lastToolError: { name: string; message: string } | null = null;

  for (let step = 1; step <= maxSteps; step++) {
    if (input.signal?.aborted) {
      console.error('[chat] stopped by user');
      return { text: 'Stopped.', steps: step - 1 };
    }
    let reply;
    try {
      reply = await client.chatStream(
        {
          system: input.system,
          model: input.model,
          apiKey: input.apiKey,
          tools,
          messages,
          signal: input.signal,
          onRetry: callbacks.onRetry,
        },
        (delta) => callbacks.onDelta?.(delta)
      );
    } catch (e) {
      if (input.signal?.aborted || (e as { name?: string })?.name === 'AbortError') {
        console.error('[chat] stopped by user (mid-stream)');
        return { text: 'Stopped.', steps: step };
      }
      throw e;
    }

    if (reply.toolCalls && reply.toolCalls.length > 0) {
      console.error(`[chat] step ${step}: model requested ${reply.toolCalls.length} tool call(s): ${reply.toolCalls.map((c) => c.name).join(', ')}`);
      messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls });
      const results = [];
      // Fail fast: once a tool call in this batch errors, STOP — don't prompt the user
      // to approve the remaining changes (e.g. don't ask to update tags 2-4 when tag 1
      // already failed). We still push a result for every call so the provider's
      // tool_use/tool_result pairing stays valid; the skipped ones report why.
      let batchFailed = false;
      for (const call of reply.toolCalls) {
        // Stop must halt the batch BETWEEN tool calls. With delete-only approvals,
        // creates/edits no longer pause at a confirm card, so this check is the only
        // brake left on queued writes after the user presses Stop.
        if (input.signal?.aborted) {
          results.push({
            id: call.id,
            name: call.name,
            content: 'Skipped: the user pressed Stop before this call ran.',
            isError: true,
          });
          continue;
        }
        if (batchFailed) {
          results.push({
            id: call.id,
            name: call.name,
            content:
              'Skipped: an earlier change in this batch failed, so this one was not run. ' +
              'Tell the user what failed and stop — do not retry the rest until they decide how to proceed.',
            isError: true,
          });
          continue;
        }
        callbacks.onToolCall?.(call);
        try {
          const content = await executor.execute(call.name, call.args);
          // The MODEL's copy is capped; the UI and the change journal keep the full result below.
          // Uncapped, one large list/audit payload was re-sent on every remaining step of the turn.
          const capped = capToolResult(call.name, content);
          if (capped.capped) {
            console.error(`[chat] ${call.name}: result capped for the model (${capped.originalChars} -> ${capped.content.length} chars)`);
          }
          // Just-in-time reference AFTER the cap, so a large result can never trim away the
          // methodology that tells the model how to report it.
          const forModel = attachReference(capped.content, referenceForResult(call.name));
          results.push({ id: call.id, name: call.name, content: forModel });
          callbacks.onToolResult?.({ name: call.name, ok: true, args: call.args, content });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          // A rejected RAW create is exactly when the model needs the resource shapes, so they ride
          // on the error instead of being paid for on every request.
          results.push({ id: call.id, name: call.name, content: attachReference(message, referenceForError(call.name)), isError: true });
          batchFailed = true;
          lastToolError = { name: call.name, message };
          callbacks.onToolResult?.({ name: call.name, ok: false, error: message });
        }
      }
      messages.push({ role: 'tool', results });
      continue;
    }

    console.error(`[chat] step ${step}: model returned a final answer (no tool calls)`);
    return { text: reply.text ?? '', steps: step };
  }

  // Ran out of steps without the model giving a final answer — surface WHY (the real tool
  // error) and make clear the task did NOT complete, instead of a vague "stopped".
  console.error(`[chat] stopped after ${maxSteps} steps without a final answer (tool-call limit)`);
  const reason = lastToolError
    ? ` The last error was — \`${lastToolError.name}\`: ${lastToolError.message}`
    : '';
  return {
    text: `⚠️ I couldn't finish this — I reached the tool-call limit (${maxSteps} steps) without completing it, so **the task was NOT done.**${reason} Tell me how you'd like to proceed, or I can try a different approach.`,
    steps: maxSteps,
  };
}
