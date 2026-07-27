import { anthropicClient } from './anthropic';
import { log } from '../logger';
import { openaiClient } from './openai';
import { geminiClient } from './gemini';
import { capToolResult } from '../../shared/context-budget';
import { attachReference, referenceForResult, referenceForError } from '../../shared/jit-reference';
import { addCacheUsage, formatCacheUsage, type CacheUsage } from '../../shared/prompt-cache';
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
  /** The fixed leading part of `system`, passed through to the provider so it can cache it. */
  systemStatic?: string;
  model: string;
  apiKey: string;
  messages: LlmTurn[];
  /** When aborted, the loop stops and returns the text so far (user pressed Stop). */
  signal?: AbortSignal;
}

export interface RunChatResult {
  text: string;
  steps: number;
  /** Input-token accounting summed over every step of the loop, when the provider reported it.
   *  This is the number that shows whether prompt caching is earning its keep: the prefix is
   *  re-sent on every step, so `read` should climb from step 2 onward. */
  usage?: CacheUsage;
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

/** Deterministic stringify (keys sorted) so identical tool-call arguments hash the same regardless of
 *  key order — used to detect a model repeating the exact same write. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

/** How many times an identical WRITE call (same tool + same args) may run in one turn before the loop
 *  blocks further repeats. A write is idempotent at the target, so repeating it changes nothing; a
 *  model that loops on it (observed: update_gtm_trigger on the same trigger 15+ times) burns quota and
 *  never terminates. Two lets an accidental retry through; the third+ is refused. */
const MAX_IDENTICAL_WRITES = 2;

/** True when a write tool's result says it changed NOTHING - an idempotent no-op (the target was
 *  already in the requested state), an already-exists skip, or a declined write. Such a "write" must
 *  not count as forward progress, otherwise a model re-touching already-satisfied items (distinct
 *  enough to dodge the identical-write guard) keeps the step budget alive and never stalls out. */
function isNoOpWriteResult(content: string): boolean {
  try {
    const r = JSON.parse(content) as { noChange?: unknown; alreadyExists?: unknown; declined?: unknown };
    return r?.noChange === true || r?.alreadyExists === true || r?.declined === true;
  } catch {
    return false; // a non-JSON result is a real write
  }
}

/** Progress-aware extension of the step budget (see runChat). */
export interface StepBudgetOptions {
  /** Absolute cap on steps even while making progress — a runaway-loop backstop. Defaults to
   *  `maxSteps` (no extension). A large multi-item build (e.g. 40 GTM tags = trigger + variables +
   *  tag each) legitimately needs far more than the soft ceiling, so the caller raises this. */
  hardMaxSteps?: number;
  /** In the extended zone (past `maxSteps`), stop if this many consecutive steps land NO successful
   *  write — the build has stalled or turned into a read-loop, so re-prompting the user is right.
   *  Tolerates the occasional read/plan step between writes. Default 6. */
  stallSteps?: number;
}

/**
 * Agentic loop: stream a model turn; if it asks for tools, execute them, feed the
 * results back, and repeat until it produces a final text answer (or hits the step
 * budget). Provider-agnostic — works for any LlmClient.
 *
 * The step budget is progress-aware. `maxSteps` is the SOFT ceiling that a normal turn returns well
 * before. Past it, the loop keeps going only while the model is still landing writes (a genuine
 * in-flight build), up to `opts.hardMaxSteps`. This is what lets "create these 40 tags" run all 40
 * to completion under ONE user turn instead of stopping partway to ask the user to say "proceed".
 * A turn that stops writing (finished, stalled, or looping on reads) still stops at the soft ceiling.
 */
export async function runChat(
  client: LlmClient,
  input: RunChatInput,
  executor: ToolExecutor,
  callbacks: RunChatCallbacks = {},
  maxSteps = 6,
  opts: StepBudgetOptions = {}
): Promise<RunChatResult> {
  const messages: LlmTurn[] = [...input.messages];
  let usage: CacheUsage | undefined;
  let lastToolError: { name: string; message: string } | null = null;
  // Count identical WRITE calls this turn (tool + args), so a model that loops on the same idempotent
  // write is stopped instead of repeating it forever.
  const writeCallCounts = new Map<string, number>();

  const hardMaxSteps = Math.max(maxSteps, opts.hardMaxSteps ?? maxSteps);
  const stallSteps = Math.max(1, opts.stallSteps ?? 6);
  // Steps since the last landed write. Starts high so a turn that never writes never enters the
  // extended zone — it stops exactly at the soft ceiling, as before.
  let stepsSinceWrite = Number.MAX_SAFE_INTEGER;

  for (let step = 1; step <= hardMaxSteps; step++) {
    // Past the soft ceiling, only continue while writes are still landing. Otherwise fall through to
    // the "not done" message so the user is asked how to proceed rather than looping silently.
    if (step > maxSteps && stepsSinceWrite >= stallSteps) {
      log.warn(`[chat] soft step budget (${maxSteps}) reached and no write in the last ${stallSteps} steps - stopping`);
      break;
    }
    if (input.signal?.aborted) {
      log.info('[chat] stopped by user');
      return { text: 'Stopped.', steps: step - 1, usage };
    }
    // Re-listed ONCE per step, not once per turn: a gated executor (see tool-groups.ts) sends a
    // minimal tool set by default and grows it when the model asks for a group, so the definitions
    // it just unlocked have to reach the NEXT provider call. Listing here (before the request,
    // never between a tool call and its result) keeps the set stable for the whole step.
    const tools = executor.list();
    let reply;
    try {
      reply = await client.chatStream(
        {
          system: input.system,
          systemStatic: input.systemStatic,
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
        log.info('[chat] stopped by user (mid-stream)');
        return { text: 'Stopped.', steps: step, usage };
      }
      throw e;
    }

    if (reply.usage) {
      usage = addCacheUsage(usage, reply.usage);
      log.info(`[chat] step ${step} ${formatCacheUsage(reply.usage)}`);
    }

    if (reply.toolCalls && reply.toolCalls.length > 0) {
      log.info(`[chat] step ${step}: model requested ${reply.toolCalls.length} tool call(s): ${reply.toolCalls.map((c) => c.name).join(', ')}`);
      messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls });
      const results = [];
      // Fail fast: once a tool call in this batch errors, STOP — don't prompt the user
      // to approve the remaining changes (e.g. don't ask to update tags 2-4 when tag 1
      // already failed). We still push a result for every call so the provider's
      // tool_use/tool_result pairing stays valid; the skipped ones report why.
      let batchFailed = false;
      // Did this step land at least one successful write? That is the "still building" signal that
      // lets the loop continue past the soft ceiling.
      let stepHadWrite = false;
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
        // Block a runaway loop on the SAME idempotent write: once the model has issued this exact
        // (tool + args) write MAX_IDENTICAL_WRITES times this turn, refuse further repeats. Feeds back
        // a result (so tool_use/tool_result pairing stays valid) but does NOT execute or count as
        // forward progress, so the loop's stall detector can then end the turn.
        if (executor.isWrite?.(call.name)) {
          const key = `${call.name} ${stableStringify(call.args)}`;
          const n = (writeCallCounts.get(key) ?? 0) + 1;
          writeCallCounts.set(key, n);
          if (n > MAX_IDENTICAL_WRITES) {
            log.warn(`[chat] blocked repeated identical write: ${call.name} (call #${n} this turn with the same args)`);
            results.push({
              id: call.id,
              name: call.name,
              content:
                `Blocked: you have already called \`${call.name}\` with these exact arguments ${n - 1} time(s) this turn. ` +
                `This write is idempotent, so repeating it changes nothing. Do NOT call it again with the same arguments - ` +
                `move on to the next DISTINCT item, or if the task is complete, give your final answer now.`,
              isError: true,
            });
            callbacks.onToolResult?.({ name: call.name, ok: false, error: 'repeated identical write blocked', args: call.args });
            continue;
          }
        }
        callbacks.onToolCall?.(call);
        try {
          const content = await executor.execute(call.name, call.args);
          // The MODEL's copy is capped; the UI and the change journal keep the full result below.
          // Uncapped, one large list/audit payload was re-sent on every remaining step of the turn.
          const capped = capToolResult(call.name, content);
          if (capped.capped) {
            log.info(`[chat] ${call.name}: result capped for the model (${capped.originalChars} -> ${capped.content.length} chars)`);
          }
          // Just-in-time reference AFTER the cap, so a large result can never trim away the
          // methodology that tells the model how to report it.
          const forModel = attachReference(capped.content, referenceForResult(call.name));
          results.push({ id: call.id, name: call.name, content: forModel });
          // A write is forward progress ONLY if it actually changed something. A no-op (noChange /
          // alreadyExists / declined) does not reset the stall detector, so a model churning
          // already-satisfied writes stalls out instead of running to the hard cap.
          if (executor.isWrite?.(call.name) && !isNoOpWriteResult(content)) stepHadWrite = true;
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
      // Forward-progress accounting: a step that landed a write resets the stall counter (the build
      // is alive and may run past the soft ceiling); a writeless step ages it toward the stall stop.
      stepsSinceWrite = stepHadWrite ? 0 : stepsSinceWrite === Number.MAX_SAFE_INTEGER ? 1 : stepsSinceWrite + 1;
      continue;
    }

    log.info(`[chat] step ${step}: model returned a final answer (no tool calls)`);
    if (usage) log.info(`[chat] turn total ${formatCacheUsage(usage)} over ${step} step(s)`);
    return { text: reply.text ?? '', steps: step, usage };
  }

  // Ran out of budget without the model giving a final answer — surface WHY (the real tool error)
  // and make clear the task did NOT complete, instead of a vague "stopped". The reported ceiling is
  // whatever actually bit: the soft budget for a stalled turn, the hard cap for a runaway one.
  log.warn(`[chat] stopped without a final answer (soft ${maxSteps} / hard ${hardMaxSteps} step budget)`);
  const reason = lastToolError
    ? ` The last error was — \`${lastToolError.name}\`: ${lastToolError.message}`
    : '';
  return {
    text: `⚠️ I couldn't finish this — I reached the tool-call limit without completing it, so **the task was NOT done.**${reason} Tell me how you'd like to proceed, or I can try a different approach.`,
    steps: hardMaxSteps,
  };
}
