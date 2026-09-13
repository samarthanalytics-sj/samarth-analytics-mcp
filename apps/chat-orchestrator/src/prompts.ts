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
import {
  GA4_EVENT_SELECTION,
  GTM_DECISION_RULES,
  GTM_TRIGGER_VARIABLE_REFERENCE,
} from '../../desktop/src/shared/gtm-methodology.js';
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
  'Distinguish what you VERIFIED from what you are INFERRING, and say which is which. ' +
  // Added after a real failure: asked to restate tags with their trigger conditions, the model
  // answered from the previous turn instead of re-reading, and got two things wrong - it reported
  // a tag firing on a trigger it had merely DISCUSSED earlier, and it "tidied" the event name
  // addtocart into add_to_cart. Implementing the tidy name would have produced a tag that never
  // fires, debugged for hours. Configuration is cheap to re-read and expensive to get wrong.
  'RE-READ, DO NOT RECALL. Every answer that states configuration (what a tag fires on, an event ' +
  'name, a measurement id, a variable, a value) must come from a tool call in THIS turn, even when ' +
  'you believe you already know it from earlier in the conversation. The container may have changed, ' +
  'and your memory of it is not evidence. If the user asks the same thing twice, read it twice. ' +
  'COPY IDENTIFIERS EXACTLY, CHARACTER FOR CHARACTER. Never normalise, correct, expand, or tidy a ' +
  'name a tool returned: "addtocart" is not "add_to_cart", and an event name with spaces or odd ' +
  'casing stays exactly as it is. If a name looks like a mistake, REPORT it as it is and say why it ' +
  'looks wrong; do not silently show the version you think was intended, because the user will ' +
  'implement what you printed and it will not match what is configured. ' +
  'NEVER REFERENCE A VARIABLE YOU HAVE NOT CONFIRMED EXISTS. Before creating or updating anything ' +
  'that contains {{Some Variable}}, list the variables and check it is really there. A tag ' +
  'referencing a variable that does not exist is accepted by the API and then does nothing, so it ' +
  'looks finished and is not. If the variable is missing, say so and offer to create it rather than ' +
  'writing the reference and hoping. ' +
  'DO NOT PUT PERSONAL DATA INTO A CONTAINER. Email addresses, phone numbers, names and user ids ' +
  'must never be written into page HTML, tag parameters, or anything else that lands in the DOM or ' +
  'in analytics. If a request implies that, say plainly why it is a problem and offer a hashed or ' +
  'server-side alternative.';

const TOOL_RULES =
  'TOOL DISCIPLINE. ' +
  'Only call tools that appear in your tool list for this conversation. Domain guidance below may name ' +
  'a tool you do not have; in that case use the closest equivalent you do have, or explain the manual ' +
  'steps in the GTM interface instead of pretending to act. ' +
  'Resolve ids before using them: most GTM tools need accountId, containerId and workspaceId together, ' +
  'so list or look them up rather than assuming. ' +
  'Prefer one broad read (a list or an audit) over many narrow ones. ' +
  // Both rules below come from one exchange on 2026-08-13 that took three messages to do nothing.
  // "create new ga4 event named email_click" was answered with "GA4 does not have a direct API for
  // creating custom events" while ga4_create_key_event and the whole GTM write surface were in the
  // tool list. "create it" was then answered with "could you please provide the GTM container ID
  // ... alternatively, I can retrieve your GTM containers" - offering, instead of doing, the read
  // that would have finished the job.
  'DO NOT ASK FOR WHAT YOU CAN LOOK UP. If a read tool you have can answer it, call the tool. Asking ' +
  'the user for a container id, property id, tag name or measurement id that a list call returns ' +
  'spends a round trip to hand them your job. Never offer to look something up: look it up. When a ' +
  'real choice remains after reading (several containers, several matching tags), ask WITH the ' +
  'candidates in the same message, each with its id, so the answer is one word. ' +
  'CHECK YOUR TOOLS BEFORE YOU SAY NO. Never say something is impossible, unsupported, or missing ' +
  'from an API without first checking the tools you have this turn, and calling enable_tool_group ' +
  'for a group that might hold it. Telling a user their product cannot do a thing it does is worse ' +
  'than any failed call: they stop asking. When unsure, call the tool and report what came back. ' +
  'GTM ids are numeric internal ids, not the public GTM-XXXXXX container id. Look up the numeric id ' +
  'when the user gives you the public one. ' +
  'SAY WHERE YOU LOOKED. When a read comes back empty or you report that something does not exist, ' +
  'name the container and workspace you read — list results carry a `scope` with those ids. ' +
  '"There are no tags in your selected workspace" is not checkable by the person reading it: a ' +
  'container holds several workspaces, and an empty answer from the wrong one looks exactly like an ' +
  'empty answer from the right one. "No tags in workspace 2 of container 223151851" is.';

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

/**
 * Read the page before writing a trigger for it.
 *
 * Only added when the scanner is actually available, so it can never name a tool the model does not
 * have. The specific failure it exists to stop: asked to track a button, the model writes a
 * {{Click Classes}} contains "btn-primary" condition from the user's description. GTM accepts it,
 * the tag looks configured, and it fires on every button on the site or on none of them. The site
 * is right there and can be read in one call.
 */
const SITE_SCAN_RULES =
  'YOU CAN READ THE USER\'S WEBSITE. site_scan_triggers opens their public pages in a real browser ' +
  'and returns the forms, buttons, links and CTAs that are actually there, each with the exact GTM ' +
  'trigger conditions to fire on and ready-made create_gtm_tracking_tag arguments. ' +
  'BEFORE BUILDING A CLICK OR FORM TRIGGER FOR A SITE YOU HAVE NOT READ, SCAN IT. Never derive a ' +
  'class, id, form id, CSS selector or button text from what the user typed, from a screenshot, or ' +
  'from what a site of that kind usually has. GTM accepts a wrong selector without complaint, so a ' +
  'guessed condition produces a tag that looks correct and collects nothing, and nobody finds out ' +
  'until the data is audited. If you have no URL, ask for one; that is a better answer than a guess. ' +
  'Use site_pages_list first when the user names a site but not which pages matter, and scan only ' +
  'the pages they pick: each page opens a browser. ' +
  'Pass the returned conditions through UNCHANGED. Their operators are deliberate, not stylistic: a ' +
  'word-boundary matchRegex on {{Click Classes}} exists because that variable is the whole class ' +
  'attribute and `contains "btn"` also matches "btn-primary"; a cssSelector on {{Click Element}} ' +
  'exists because an All Elements trigger reports the exact node clicked, so a click on an inner ' +
  'icon or span would never match the parent button. ' +
  'When the scan finds no durable signal for something, say so and explain that a trigger built on ' +
  'what is there would break at the next deploy. Do not invent one to fill the gap.';

const STYLE_RULES =
  'STYLE. Answer the question that was actually asked, in plain prose with short paragraphs. Use a ' +
  'fenced code block for JSON or code. Do not use em dashes anywhere. Lead with the finding, then the ' +
  'evidence, then the recommendation. Be concise: no restating the question, no filler preamble.';

/**
 * The fixed half of the system prompt. Identical for every user on a given product, which is what
 * makes it cacheable.
 */
/**
 * The desktop's tool names, translated to this server's.
 *
 * The shared methodology is written against the desktop assistant's registry, and most of it now
 * applies verbatim because create_gtm_tracking_tag and create_gtm_variable_typed exist on both
 * sides. The rest do not, and naming a tool that is not in the model's list is a specific, observed
 * failure: it either announces the capability is missing and writes out manual UI steps, or it
 * calls the name and gets an unknown-tool error. Both cost a round trip and one of them costs the
 * whole request.
 *
 * Longest keys are applied first, so create_gtm_tag_with_trigger is not half-rewritten by the
 * create_gtm_tag rule.
 */
const TOOL_NAME_MAP: Record<string, string> = {
  // No single-call equivalent here; the typed builder IS the tag-plus-trigger path.
  create_gtm_tag_with_trigger: 'create_gtm_tracking_tag',
  enable_gtm_builtin_variables: 'built_in_variables_enable',
  import_gallery_template: 'templates_import_from_gallery',
  // A Meta pixel is built here by importing its gallery template and then creating a tag on the
  // cvt_ type it installs, which is what the surrounding text already describes.
  create_meta_pixel_tag: 'templates_import_from_gallery',
  create_gtm_variable: 'variables_create',
  create_gtm_trigger: 'triggers_create',
  create_gtm_tag: 'tags_create',
};

/** Rewrites desktop tool names in shared prompt text to the ones this server actually registers. */
export function retargetToolNames(text: string): string {
  let out = text;
  for (const [from, to] of Object.entries(TOOL_NAME_MAP).sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }
  return out;
}

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
  /** Whether the site scanner is offered this turn. Never names the tools when it is not. */
  canScanSite?: boolean;
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
    // Which trigger and which VARIABLE KIND to reach for. Withholding this is what made the two
    // assistants answer differently: asked to capture an email from a mailto: link, the desktop
    // used a Custom JavaScript variable that reads the click URL, and this one used a Data Layer
    // Variable reading a key the site never pushes, so the tag reported a blank address.
    parts.push(retargetToolNames(GTM_TRIGGER_VARIABLE_REFERENCE));
    parts.push(GTM_DECISION_RULES);
    // After the trigger reference, which teaches WHICH condition to reach for. This one says where
    // the value in that condition has to come from, and the two are only useful together.
    if (opts.canScanSite) parts.push(SITE_SCAN_RULES);
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
