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
  'YOU CAN CHANGE THINGS, AND WHAT THAT COSTS DEPENDS ON WHERE. ' +
  'A change inside a GTM workspace (tags, triggers, variables, folders) APPLIES IMMEDIATELY when you ' +
  'call the tool. It is a draft: the live container is unaffected until a human publishes it, and the ' +
  'workspace can be discarded. Do not ask for permission first and do not describe it as pending. ' +
  'A DELETE is stopped and shown to the user, who must type the word DELETE. Nothing reverts a delete ' +
  'here, so prefer pausing a tag over removing it unless removal is what was asked for. ' +
  'A change with no draft behind it, meaning anything in GA4 Admin or at GTM container, version, ' +
  'environment, or permission level, is stopped and shown to the user for approval. It takes effect ' +
  'the moment it succeeds, so say plainly what it will do before proposing it. ' +
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
}): string {
  const parts: string[] = [];
  parts.push(opts.product === 'ga4' ? ROLE_GA4 : ROLE_GTM);
  parts.push(HONESTY_RULES);
  parts.push(TOOL_RULES);
  parts.push(opts.canWrite ? WRITE_RULES : READ_ONLY_RULES);

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
  return lines.join('\n');
}
