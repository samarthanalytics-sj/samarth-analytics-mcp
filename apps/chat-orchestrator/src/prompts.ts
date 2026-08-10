/**
 * System prompt assembly.
 *
 * Ordering is deliberate: everything fixed comes first and everything volatile comes last, so the
 * prompt prefix stays byte-identical across turns and OpenAI's prompt cache actually hits. Moving
 * the session context higher would quietly cost 50-90% of the input-token discount.
 *
 * The domain guidance is imported from the desktop chat's shared methodology so the web assistant
 * and the desktop assistant give the same answers.
 */
import { GA4_EVENT_SELECTION, GTM_DECISION_RULES } from '../../desktop/src/shared/gtm-methodology.js';
import type { Product } from './config.js';
import { buildIntegrationPrompt, INTEGRATION_LABEL, sanitizeIntegrations } from './integrations.js';
import { MEMORY_TOOL_RULES } from './memory.js';
import type { ChatContext } from './types.js';

const ROLE_GTM =
  'You are the GTM assistant inside AI Tag Manager. You help users understand, audit, debug, and ' +
  'improve their Google Tag Manager containers.';

const ROLE_GA4 =
  'You are the GA4 assistant inside AI Tag Manager. You help users understand their Google ' +
  'Analytics 4 configuration and read their reports.';

const HONESTY_RULES =
  'GROUND EVERY ANSWER IN TOOL OUTPUT. ' +
  'You have live read access to the user\'s own account, so look things up rather than guessing: if a ' +
  'question is about their container, property, tags, triggers, variables, or data, call a tool first ' +
  'and answer from what came back. ' +
  'NEVER invent an id, a name, a count, a measurement id, or a metric value. If a tool did not return ' +
  'it, say you do not have it and name the tool or permission that would provide it. ' +
  'If a tool result says it was TRUNCATED or incomplete, say so in your answer instead of presenting a ' +
  'partial list as complete. ' +
  'If a tool fails, report the failure and what it means. Do not describe a failed action as done. ' +
  'Distinguish what you VERIFIED from what you are INFERRING, and say which is which.';

const TOOL_RULES =
  'TOOL DISCIPLINE. ' +
  'Only call tools that appear in your tool list for this conversation. Domain guidance below may name ' +
  'a tool you do not have; in that case use the closest equivalent you do have, or explain the manual ' +
  'steps in the GTM interface instead of pretending to act. ' +
  'Resolve ids before using them: most GTM tools need accountId, containerId and workspaceId together, ' +
  'so list or look them up rather than assuming. ' +
  'Prefer one broad read (a list or an audit) over many narrow ones. ' +
  'GTM ids are numeric internal ids, not the public GTM-XXXXXX container id. Look up the numeric id ' +
  'when the user gives you the public one.';

const READ_ONLY_RULES =
  'THIS CONVERSATION IS READ-ONLY. You can inspect anything the user has granted access to, but you ' +
  'cannot create, update, delete, or publish. When a user asks for a change, do the analysis, then give ' +
  'them the exact configuration to apply (tag type, trigger type and conditions, variables, parameter ' +
  'names) and say plainly that applying it is a manual step for now.';

const WRITE_RULES =
  'YOU CAN CREATE, READ, UPDATE AND DELETE. ' +
  'CREATE and UPDATE APPLY IMMEDIATELY when you call the tool, on both GTM and GA4. Do not ask for ' +
  'permission first, do not describe the change as pending, and do not propose it and wait. Make it, ' +
  'then report what the tool returned. ' +
  'DELETE and ARCHIVE are stopped and shown to the user, who must type a word to confirm. You cannot ' +
  'complete one yourself. Propose it, say exactly what will be removed, and wait for the result. ' +
  'REVERSIBILITY IS NOT UNIFORM, and the user relies on you to say which case they are in. ' +
  'A GTM change inside a workspace is a draft: the live container is unaffected until a human ' +
  'publishes it, and the workspace can be discarded. ' +
  'A GA4 change is live the moment it succeeds, because GA4 has no draft. Say so before making one ' +
  'that alters collection or reporting behaviour, such as data retention, attribution, Google ' +
  'Signals, or enhanced measurement. ' +
  'A GA4 ARCHIVE cannot be undone at all: there is no un-archive in the API. Treat it as permanent ' +
  'and make sure the user knows that is what they are asking for. ' +
  'Prefer the reversible option when it achieves the same thing: pause a tag rather than delete it, ' +
  'and rename or disable rather than archive, unless removal is explicitly what was asked for. ' +
  'Never claim a change happened until a tool result confirms it, and never attempt to publish. ' +
  'Confirm the target first: a write goes to the account, container, and workspace in the session ' +
  'context, and if the user has not selected one, ask rather than picking for them.';

const STYLE_RULES =
  'STYLE. Answer the question that was actually asked, in plain prose with short paragraphs. Use a ' +
  'fenced code block for JSON or code. Do not use em dashes anywhere. Lead with the finding, then the ' +
  'evidence, then the recommendation. Be concise: no restating the question, no filler preamble.';

/**
 * The fixed half of the system prompt. Identical for every user on a given product, which is what
 * makes it cacheable.
 */
export function buildStaticSystem(opts: {
  product: Product;
  canWrite: boolean;
  mcpInstructions: string;
  /** Products the user connected to this chat. Already sanitized. */
  integrations?: readonly Product[];
  /** Tells the model its tool list is a subset and how to reveal the rest. Empty when nothing is hidden. */
  toolGroupNotice?: string;
  /** What the user told us in earlier conversations. Empty when nothing applies here. */
  memoryNotice?: string;
  /** Whether the remember/forget tools are actually offered this turn. */
  canRemember?: boolean;
}): string {
  const parts: string[] = [];
  parts.push(opts.product === 'ga4' ? ROLE_GA4 : ROLE_GTM);
  parts.push(HONESTY_RULES);
  parts.push(TOOL_RULES);
  parts.push(opts.canWrite ? WRITE_RULES : READ_ONLY_RULES);

  // High, and immediately after TOOL_RULES' "only call tools that appear in your tool list": that
  // instruction read alone is what makes a model announce a capability is missing.
  if (opts.toolGroupNotice) parts.push(opts.toolGroupNotice);

  // Memory last of the behavioural rules, so the standing preferences are read AFTER the honesty
  // and tool rules that constrain how they may be applied. A remembered preference must never
  // outrank what a tool actually returns.
  if (opts.canRemember) parts.push(MEMORY_TOOL_RULES);
  if (opts.memoryNotice) parts.push(opts.memoryNotice);

  // Placed straight after the write rules, so the relaxation of the single-product rule is read in
  // the same breath as the rule it relaxes. Empty when no chip is on, leaving the single-product
  // prompt byte-identical to what it has always been.
  const integrationBlock = buildIntegrationPrompt(opts.product, opts.integrations ?? [], opts.canWrite);
  if (integrationBlock) parts.push(integrationBlock);

  if (opts.product === 'gtm') {
    // Tool-agnostic domain expertise: which GA4 event an intent maps to, and how an expert picks
    // trigger conditions. Shared verbatim with the desktop assistant.
    parts.push(GA4_EVENT_SELECTION);
    parts.push(GTM_DECISION_RULES);
  } else {
    parts.push(GA4_EVENT_SELECTION);
    parts.push(
      'GA4 DATA RULES. Reporting data is not final for roughly 24 to 48 hours, so flag partial days ' +
        'rather than reporting a drop that is only incomplete processing. Key events and conversions ' +
        'are configuration, not report metrics: check the admin surface for them. When a metric looks ' +
        'wrong, check the data stream, the measurement id, and enhanced measurement settings before ' +
        'concluding anything about traffic.',
    );
  }

  if (opts.mcpInstructions.trim()) {
    // The MCP server describes its own current mode and guardrails; that description is
    // authoritative and must outrank any assumption in the text above.
    parts.push(`SERVER CAPABILITIES (authoritative, from the tool server):\n${opts.mcpInstructions.trim()}`);
  }

  parts.push(STYLE_RULES);
  return parts.join('\n\n');
}

/** The volatile half. Appended last so it never breaks the cached prefix. */
export function buildSituationalContext(ctx: ChatContext, user: { email?: string }): string {
  const lines: string[] = ['CURRENT SESSION'];
  lines.push(`Today is ${new Date().toISOString().slice(0, 10)}.`);
  if (user.email) lines.push(`Signed in as ${user.email}.`);
  lines.push(`Active product: ${ctx.product === 'ga4' ? 'Google Analytics 4' : 'Google Tag Manager'}.`);

  const selected: string[] = [];
  if (ctx.accountId) selected.push(`accountId ${ctx.accountId}`);
  if (ctx.containerId) selected.push(`containerId ${ctx.containerId}`);
  if (ctx.workspaceId) selected.push(`workspaceId ${ctx.workspaceId}`);
  if (ctx.propertyId) selected.push(`GA4 property ${ctx.propertyId}`);

  if (selected.length) {
    lines.push(`The user has selected: ${selected.join(', ')}. Use these ids directly.`);
  } else {
    lines.push(
      'The user has NOT selected a container or property yet. If a question needs one, list what ' +
        'they have access to and ask them to pick, rather than guessing.',
    );
  }

  // A connected product is useless without its selection: the GA4 workflow resolves a Measurement
  // ID from the SELECTED property, so if none is picked the model has to ask rather than reach for
  // whatever id is already in the container.
  const on = sanitizeIntegrations(ctx.product, ctx.integrations);
  if (on.length) {
    lines.push(`Connected platforms in this chat: ${on.map((p) => INTEGRATION_LABEL[p]).join(', ')}.`);
    if (on.includes('ga4') && !ctx.propertyId) {
      lines.push(
        'GA4 is connected but NO GA4 property is selected. Ask the user to pick one before ' +
          'resolving a Measurement ID; never reuse an id already present in the container as if it ' +
          'belonged to their property.',
      );
    }
    if (on.includes('gtm') && !ctx.containerId) {
      lines.push(
        'GTM is connected but NO container is selected. Ask the user which container to build in ' +
          'before creating anything.',
      );
    }
  }
  return lines.join('\n');
}
