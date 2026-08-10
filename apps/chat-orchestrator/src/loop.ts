/**
 * The agentic turn: model call, tool calls, model call, until the model answers.
 *
 * Budgets are the safety and cost control. Without them a confused model can loop on a failing tool
 * until the request times out, and each iteration is a full-price completion.
 */
import type { OrchestratorConfig } from './config.js';
import type { McpConnection } from './mcp-client.js';
import type { OpenAiClient } from './openai.js';
import { capToolResult, scopeTools, toOpenAiTools } from './tools.js';
import { buildSituationalContext, buildStaticSystem } from './prompts.js';
import { GoogleIdentityError, isGoogleAuthFailure } from './google-identity.js';
import { forLog, userRef } from './redact.js';
import { summarizeWrite, type ApprovalBroker } from './approvals.js';
import { approvalGate } from './writeTiers.js';
import type { AuditRecorder } from './audit.js';
import type { UsageMeter } from './usage.js';
import { productOf } from './tools.js';
import { attachmentPrompt, type ExtractedAttachment } from './attachments.js';
import { sanitizeIntegrations } from './integrations.js';
import { FORGET_MEMORY, REMEMBER_MEMORY, buildMemoryPrompt, type MemoryRecord, type MemoryScope, type MemoryStore } from './memory.js';
import {
  ENABLE_TOOL_GROUP,
  availableGroups,
  buildToolGroupPrompt,
  describeRevealedGroup,
  enableToolGroupDef,
  filterToolsByGroup,
  groupCounts,
  selectToolGroups,
  type ToolGroup,
} from './tool-groups.js';
import type { ToolDef } from './types.js';
import type { ChatContext, ChatMessage, StreamEvent } from './types.js';

export interface RunTurnArgs {
  cfg: OrchestratorConfig;
  mcp: McpConnection;
  llm: OpenAiClient;
  history: { role: 'user' | 'assistant'; content: string }[];
  context: ChatContext;
  user: { id: string; email?: string };
  /** Files the user attached to the last message, already extracted. See attachments.ts. */
  attachments?: ExtractedAttachment[];
  emit(event: StreamEvent): void;
  signal: AbortSignal;
  /**
   * Mints a new connection after Google rejects the current identity. Returning a fresh connection
   * lets one expired access token cost a retry instead of the whole turn.
   */
  onAuthFailure?: () => Promise<McpConnection>;
  /** Present only when write tools are enabled. Its absence makes a write impossible to execute. */
  approvals?: ApprovalBroker;
  /** Records what happened. Never allowed to fail a turn; see audit.ts. */
  audit?: AuditRecorder;
  /** Durable preferences from earlier conversations. Absent means memory is off. */
  memory?: MemoryStore;
  /** Null when auditing is off or the conversation could not be opened; recording is then skipped. */
  conversationId?: string | null;
  /** Counts this turn against the user's plan. Never allowed to fail a turn; see usage.ts. */
  usage?: UsageMeter;
}

export async function runTurn(args: RunTurnArgs): Promise<void> {
  const { cfg, llm, context, user, emit, signal } = args;
  const startedAt = Date.now();
  let mcp = args.mcp;
  // One refresh per turn. A second failure is a real authorization problem, not an expiry, and
  // looping on it would just burn tokens.
  let authRetryUsed = false;

  // Sanitized here rather than trusted from the body: this list widens the tool surface, so junk
  // or a self-reference must be dropped before it can pick tools.
  const integrations = sanitizeIntegrations(context.product, context.integrations);

  const scoped = scopeTools(mcp.listTools(), {
    product: context.product,
    includeWrites: cfg.enableWriteTools,
    includeDeletes: cfg.enableDeleteTools,
    integrations,
    // No ceiling passed on purpose: this is the PERMITTED set, and progressive disclosure below
    // decides what is actually sent. A tool cut here would be unreachable even via the gate.
  });
  /**
   * Progressive disclosure. `scoped` stays the full permitted set (what this user MAY call); what
   * the model SEES is a subset of it, recomputed whenever a group is revealed.
   *
   * Keeping the two separate matters: permission checks below still run against `scoped`, so
   * hiding a tool from the prompt never becomes a security decision by accident.
   */
  const enabledGroups = new Set<ToolGroup>();
  const gateGroups = availableGroups(scoped);
  const gateCounts = groupCounts(scoped);
  const gate = gateGroups.length > 0 ? enableToolGroupDef(gateGroups, gateCounts) : null;

  const visibleTools = (): ToolDef[] => {
    const selected = selectToolGroups({
      messages: args.history.map((m) => m.content),
      enabled: enabledGroups,
      integrations,
    });
    const shown = filterToolsByGroup(scoped, selected);
    return gate ? [...shown, gate] : shown;
  };

  /**
   * Memory tools are the orchestrator's own, like the group gate: the MCP server has no memory
   * surface, and putting them here means they work without touching that server at all.
   */
  const memoryTools: ToolDef[] = args.memory?.isEnabled()
    ? [
        {
          name: REMEMBER_MEMORY,
          description:
            'Remember a durable preference or house rule so it applies in FUTURE conversations, not just this one. ' +
            'Use it when the user states how they want things done (a tag naming convention, a format they always want, ' +
            'a policy for this container). Scope it to the container or property when it belongs to that one. Do NOT use ' +
            'it for facts you can look up again, which go stale, or for one-off instructions.',
          inputSchema: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'The rule, in one sentence, in the user\'s own terms.' },
              scope: {
                type: 'string',
                enum: ['user', 'container', 'property'],
                description:
                  '"container" or "property" when the rule belongs to the selected one; "user" only when it is genuinely account-wide.',
              },
            },
            required: ['content', 'scope'],
            additionalProperties: false,
          },
          isWrite: false,
          isDelete: false,
          isDestructive: false,
        } as ToolDef,
        {
          name: FORGET_MEMORY,
          description:
            'Forget a remembered preference, by the id shown in the REMEMBERED PREFERENCES list. Use when the user ' +
            'asks you to stop applying something.',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string', description: 'The memory id.' } },
            required: ['id'],
            additionalProperties: false,
          },
          isWrite: false,
          isDelete: false,
          isDestructive: false,
        } as ToolDef,
      ]
    : [];

  let openAiTools = toOpenAiTools([...visibleTools(), ...memoryTools]);
  console.log(
    `[tools] ${visibleTools().length - (gate ? 1 : 0)} of ${scoped.length} tools visible this turn` +
      (gate ? `, ${gateGroups.length} group(s) available on request` : ''),
  );

  emit({
    type: 'ready',
    product: context.product,
    model: cfg.openai.model,
    toolCount: scoped.length,
  });

  // Fetched before the prompt: what the user told us in earlier conversations, scoped to where
  // this session actually is. Failure returns [] inside the store, so a turn never dies for it.
  const memories: MemoryRecord[] = args.memory
    ? await args.memory.forSession(user.id, { containerId: context.containerId, propertyId: context.propertyId })
    : [];
  if (memories.length > 0) {
    args.memory?.markUsed(memories.map((m) => m.id));
    console.log(`[memory] ${memories.length} memor(ies) applied this turn`);
  }

  const staticSystem = buildStaticSystem({
    product: context.product,
    canWrite: cfg.enableWriteTools,
    mcpInstructions: mcp.getInstructions(),
    integrations,
    // Without this the model treats its partial list as the whole surface and tells the user a
    // capability does not exist, which is exactly the failure the old silent cap produced.
    toolGroupNotice: buildToolGroupPrompt(gateGroups),
    // What the user has told us before. Empty when nothing applies here, so a session with no
    // memories keeps the byte-identical cacheable prefix it always had.
    memoryNotice: buildMemoryPrompt(memories),
    canRemember: Boolean(args.memory?.isEnabled()),
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: staticSystem },
    { role: 'system', content: buildSituationalContext(context, user) },
    ...withAttachments(
      boundHistory(args.history, cfg.limits.maxHistoryMessages),
      args.attachments ?? [],
    ),
  ];

  let toolCallsUsed = 0;
  // Accumulated so the audit row reflects the whole turn rather than the last model call: a turn
  // that used tools makes several completions, and billing wants their sum.
  let assistantText = '';
  const spend = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };

  const target = {
    accountId: context.accountId,
    containerId: context.containerId,
    workspaceId: context.workspaceId,
    propertyId: context.propertyId,
  };

  /** Writes the closing record for this turn. Called on every exit path, including the budgets. */
  const finish = (reason: string): void => {
    // Billed on every exit path, including the budget stops. A turn that was cut short still cost
    // whatever it spent before stopping, and not charging for it would let a caller get unlimited
    // work by always hitting the ceiling.
    args.usage?.record(user.id, spend.promptTokens + spend.completionTokens);
    args.audit?.recordAssistantTurn(args.conversationId ?? null, user.id, {
      content: assistantText,
      promptTokens: spend.promptTokens,
      completionTokens: spend.completionTokens,
      cachedTokens: spend.cachedTokens,
      model: cfg.openai.model,
      stopReason: reason,
    });
  };

  for (;;) {
    if (signal.aborted) {
      finish('aborted');
      emit({ type: 'done', reason: 'aborted' });
      return;
    }
    if (Date.now() - startedAt > cfg.limits.maxTurnMs) {
      emit({
        type: 'token',
        text: '\n\n[Stopped: this turn exceeded its time budget. Ask a narrower question, or ask me to continue.]',
      });
      finish('time_budget');
      emit({ type: 'done', reason: 'time_budget' });
      return;
    }

    const result = await llm.streamChat(
      messages,
      openAiTools,
      {
        onDelta: (text) => emit({ type: 'token', text }),
        onUsage: (u) => {
          spend.promptTokens += u.promptTokens;
          spend.completionTokens += u.completionTokens;
          spend.cachedTokens += u.cachedTokens;
          emit({
            type: 'usage',
            promptTokens: u.promptTokens,
            completionTokens: u.completionTokens,
            cachedTokens: u.cachedTokens,
          });
        },
      },
      signal,
    );

    if (result.toolCalls.length === 0) {
      assistantText += result.content ?? '';
      finish('complete');
      emit({ type: 'done', reason: 'complete' });
      return;
    }

    if (toolCallsUsed + result.toolCalls.length > cfg.limits.maxToolCallsPerTurn) {
      emit({
        type: 'token',
        text:
          '\n\n[Stopped: this turn hit its tool-call budget. Here is what I found so far. ' +
          'Ask me to continue if you want me to keep digging.]',
      });
      finish('tool_budget');
      emit({ type: 'done', reason: 'tool_budget' });
      return;
    }

    // The assistant turn carrying the tool calls must be replayed verbatim, or the follow-up tool
    // messages have nothing to attach to.
    assistantText += result.content ?? '';
    messages.push({
      role: 'assistant',
      content: result.content || null,
      tool_calls: result.toolCalls,
    });

    for (const call of result.toolCalls) {
      toolCallsUsed++;

      let parsedArgs: Record<string, unknown> = {};
      let parseError: string | null = null;
      try {
        parsedArgs = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (err) {
        parseError = `Arguments were not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
      }

      emit({ type: 'tool_call', id: call.id, name: call.function.name, args: parsedArgs });

      if (parseError) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: `${parseError}. Retry this call with valid JSON arguments.`,
        });
        emit({
          type: 'tool_result',
          id: call.id,
          name: call.function.name,
          ok: false,
          summary: 'Invalid arguments',
        });
        continue;
      }

      // The gate is handled here rather than sent to the MCP: it is the orchestrator's own tool,
      // and its whole effect is on what the NEXT model call can see.
      if (gate && call.function.name === ENABLE_TOOL_GROUP) {
        const requested = String(parsedArgs.group ?? '') as ToolGroup;
        const known = gateGroups.includes(requested as Exclude<ToolGroup, 'core'>);
        if (!known) {
          const summary = `"${requested}" is not a group in this conversation. Available: ${gateGroups.join(', ')}.`;
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: summary });
          emit({ type: 'tool_result', id: call.id, name: call.function.name, ok: false, summary });
          continue;
        }

        const before = new Set(visibleTools().map((t) => t.name));
        enabledGroups.add(requested);
        const revealed = visibleTools().filter((t) => !before.has(t.name));
        // Recomputed now, so the tools are on the very next model call rather than the one after.
        openAiTools = toOpenAiTools([...visibleTools(), ...memoryTools]);

        const summary = describeRevealedGroup(requested, revealed);
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: summary });
        emit({
          type: 'tool_result',
          id: call.id,
          name: call.function.name,
          ok: true,
          summary: `Revealed ${revealed.length} tool(s) in "${requested}"`,
        });
        console.log(`[tools] revealed group "${requested}": ${revealed.length} tool(s) now visible`);
        continue;
      }

      // Memory tools, handled here for the same reason as the group gate: they are the
      // orchestrator's own and never reach the MCP server.
      if (args.memory && (call.function.name === REMEMBER_MEMORY || call.function.name === FORGET_MEMORY)) {
        let summary: string;
        let ok = true;

        if (call.function.name === REMEMBER_MEMORY) {
          const scope = String(parsedArgs.scope ?? 'user') as MemoryScope;
          const scopeId =
            scope === 'container' ? (context.containerId ?? null) : scope === 'property' ? (context.propertyId ?? null) : null;
          const result = await args.memory.remember(user.id, {
            content: String(parsedArgs.content ?? ''),
            scope,
            scopeId,
          });
          ok = result.stored;
          summary = result.stored
            ? `Remembered${result.reason ? ` (${result.reason})` : ''}. It will apply in future conversations${scope === 'user' ? '' : ` for this ${scope}`}.`
            : (result.reason ?? 'Could not remember that.');
        } else {
          const removed = await args.memory.forget(user.id, String(parsedArgs.id ?? ''));
          ok = removed;
          summary = removed ? 'Forgotten. It will no longer be applied.' : 'No memory with that id belongs to you.';
        }

        messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: summary });
        emit({ type: 'tool_result', id: call.id, name: call.function.name, ok, summary });
        args.audit?.recordToolEvent(args.conversationId ?? null, user.id, {
          ...target,
          toolName: call.function.name,
          product: context.product,
          isWrite: false,
          isDelete: false,
          approval: 'not_required',
          args: parsedArgs,
          ok,
          resultSummary: summary,
          durationMs: 0,
        });
        continue;
      }

      const tool = scoped.find((t) => t.name === call.function.name);
      const callStartedAt = Date.now();
      let approval: 'not_required' | 'approved' | 'declined' | 'timeout' | 'aborted' = 'not_required';

      /** One audit row per tool call, whatever became of it. */
      const record = (ok: boolean, summary: string): void =>
        args.audit?.recordToolEvent(args.conversationId ?? null, user.id, {
          ...target,
          toolName: call.function.name,
          product: productOf(call.function.name),
          surface: tool?.surface,
          isWrite: Boolean(tool?.isWrite),
          isDelete: Boolean(tool?.isDelete),
          approval,
          args: parsedArgs,
          ok,
          resultSummary: summary,
          durationMs: Date.now() - callStartedAt,
        });

      if (tool?.isWrite) {
        if (!args.approvals) {
          // Belt and braces: no write tool should have been visible without a broker.
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: 'This conversation is read-only. Explain the change instead of making it.',
          });
          emit({ type: 'tool_result', id: call.id, name: call.function.name, ok: false, summary: 'Read-only' });
          record(false, 'Refused: this deployment is read-only');
          continue;
        }

        const surface = tool.surface ?? 'gtm_live';
        const gate = approvalGate({ ...tool, name: call.function.name }, cfg.approveLiveWrites);

        if (gate) {
          const outcome = await args.approvals.request(
            user.id,
            call.function.name,
            parsedArgs,
            (approvalId) =>
              emit({
                type: 'approval_required',
                approvalId,
                toolName: call.function.name,
                summary: summarizeWrite(call.function.name, parsedArgs),
                args: parsedArgs,
                confirmWord: gate.confirmWord,
                surface,
              }),
            gate.confirmWord,
          );

          if (!outcome.approved) {
            approval = outcome.reason;
            const why =
              outcome.reason === 'timeout'
                ? 'The user did not respond in time, so nothing was changed.'
                : outcome.reason === 'aborted'
                  ? 'The user stopped the request, so nothing was changed.'
                  : 'The user declined this change, so nothing was changed.';
            console.log(
              `[approval] ${call.function.name} ${outcome.reason} for user ${userRef(user.id)}`,
            );
            messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: why });
            emit({ type: 'tool_result', id: call.id, name: call.function.name, ok: false, summary: why });
            record(false, why);
            continue;
          }

          approval = 'approved';
          // The user may have corrected what the model proposed; their version is what runs.
          parsedArgs = outcome.args;
          console.log(
            `[approval] ${call.function.name} APPROVED by user ${userRef(user.id)}: ${forLog(JSON.stringify(parsedArgs), 200)}`,
          );
        } else {
          // Applied without a prompt. Logged at the same level as an approved write, because this is
          // now the path most changes take and an unlogged mutation is one nobody can reconstruct.
          console.log(
            `[write] ${call.function.name} applied directly (${surface}) for user ${userRef(user.id)}: ${forLog(JSON.stringify(parsedArgs), 200)}`,
          );
        }

        // Every guarded write in this MCP requires confirm=true, and the MCP cannot tell a human
        // decision from an automatic one. What actually holds a change back is the tier above:
        // the gate for anything live or destructive, and the draft workspace for the rest.
        parsedArgs.confirm = true;
      }

      let { ok, text } = await mcp.callTool(call.function.name, parsedArgs);

      if (!ok && !authRetryUsed && args.onAuthFailure && isGoogleAuthFailure(text)) {
        authRetryUsed = true;
        // The retry overwrites `text`, so the failure that triggered it would otherwise be lost.
        // It is the more diagnostic of the two: it says whether the token was expired or simply
        // lacked the scope, which the refresh error cannot tell you.
        console.error(
          `[tool] ${call.function.name} first attempt failed (will refresh): ${forLog(text)}`,
        );
        try {
          mcp = await args.onAuthFailure();
          ({ ok, text } = await mcp.callTool(call.function.name, parsedArgs));
        } catch (err) {
          text =
            err instanceof GoogleIdentityError
              ? `Google authorization failed: ${err.message}`
              : `Google authorization failed: ${err instanceof Error ? err.message : String(err)}`;
          ok = false;
        }
      }

      if (!ok) {
        // The model relays tool failures to the user in its own words, which is useless for
        // diagnosis. Without this line a production failure leaves no trace at all.
        console.error(
          `[tool] ${call.function.name} failed for user ${userRef(user.id)}: ${forLog(text)}`,
        );
      }

      const capped = capToolResult(text, cfg.limits.maxToolResultChars);

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: capped,
      });
      const summary = summarize(capped);
      emit({ type: 'tool_result', id: call.id, name: call.function.name, ok, summary });
      // Written after the call so `parsedArgs` carries any correction made on the approval card:
      // the row has to say what actually ran, not what the model first proposed.
      record(ok, summary);
    }
  }
}

/**
 * Folds this turn's attachments into the LAST user message.
 *
 * Attached to that message rather than sent as a separate system block, because the files belong
 * to what the user just asked - a system message would read as standing context and keep applying
 * to later turns, when in fact the browser only sends the bytes once.
 *
 * Documents become text; images become vision parts, which is why the content can stop being a
 * plain string here. If there is no user message to attach to (a malformed request), the
 * attachments are dropped rather than invented into one.
 */
function withAttachments(messages: ChatMessage[], attachments: ExtractedAttachment[]): ChatMessage[] {
  if (attachments.length === 0) return messages;

  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUser = i;
      break;
    }
  }
  if (lastUser === -1) return messages;

  const original = typeof messages[lastUser].content === 'string' ? (messages[lastUser].content as string) : '';
  const text = `${original}${attachmentPrompt(attachments)}`;
  const images = attachments.filter((a) => a.media);

  const replaced: ChatMessage =
    images.length === 0
      ? { ...messages[lastUser], content: text }
      : {
          ...messages[lastUser],
          content: [
            { type: 'text', text },
            ...images.map((a) => ({
              type: 'image_url' as const,
              image_url: { url: `data:${a.media!.mime};base64,${a.media!.dataBase64}` },
            })),
          ],
        };

  return [...messages.slice(0, lastUser), replaced, ...messages.slice(lastUser + 1)];
}

/**
 * Keeps the most recent turns and tells the model when older ones were dropped, so it never
 * silently answers as if it can still see them.
 */
function boundHistory(
  history: { role: 'user' | 'assistant'; content: string }[],
  max: number,
): ChatMessage[] {
  if (history.length <= max) {
    return history.map((m) => ({ role: m.role, content: m.content }));
  }
  const kept = history.slice(-max);
  const dropped = history.length - kept.length;
  return [
    {
      role: 'system',
      content: `[${dropped} earlier message(s) in this conversation were dropped to fit the context window. If the user refers to something you cannot see, say so and ask them to restate it.]`,
    },
    ...kept.map((m) => ({ role: m.role, content: m.content })),
  ];
}

function summarize(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}
