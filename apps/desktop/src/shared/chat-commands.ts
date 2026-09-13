// Desktop-chat slash commands. Typing "/audit", "/report", "/create-tag", "/debug", "/explain" in the
// chat box expands into a full natural-language instruction the chat brain runs with its own tools.
// PURE + framework-free (no React) so the parsing/expansion is unit-tested, and the renderer only wires
// the menu + input to it. Each command that needs a specific toolset declares its `product` (the chat's
// GTM vs GA4 mode gates which tools the brain has), so the renderer can flip to it before sending.

export type ChatProduct = 'gtm' | 'ga4' | 'ads';

export interface SlashCommand {
  /** The slash name (what the user types after "/"). */
  name: string;
  /** Placeholder for the optional argument, shown in the menu (e.g. "[url or container]"). */
  hint: string;
  /** One-line menu description. */
  desc: string;
  /** When set, the chat must be in this product (its tools) — the renderer flips to it before sending. */
  product?: ChatProduct;
  /** Expand the command (+ its trimmed args) into the instruction actually sent to the chat brain. */
  expand: (args: string) => string;
}

export const CHAT_SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'audit',
    hint: '[url or container]',
    desc: 'Audit the current GTM container for issues',
    product: 'gtm',
    expand: (a) =>
      `Audit ${a ? `the GTM container / site "${a}"` : 'my current GTM container'}. Check for: tags with no firing trigger, paused tags, broken variable/trigger references, GA4 configuration problems, duplicate names, and overly broad triggers. Summarise the findings grouped by severity (errors first), each with a one-line reason and the concrete fix. This is read-only — do not change anything.`,
  },
  {
    name: 'report',
    hint: '[date range]',
    desc: 'Run a GA4 report (default last 28 days)',
    product: 'ga4',
    expand: (a) =>
      `Run a GA4 report for ${a || 'the last 28 days'}: sessions, total users, and conversions (key events), broken down by the default channel group. Give me the headline totals and the top channels, and call out any obvious movement. Read-only — reporting only, do not change GA4 config.`,
  },
  {
    name: 'create-tag',
    hint: '<what to track>',
    desc: 'Create a GA4 event tag (draft only)',
    product: 'gtm',
    expand: (a) =>
      `Create a GA4 event tag for ${a || 'the interaction I describe (ask me which event / click / form / page if it is unclear)'}. Choose the right GA4 event name, set up the appropriate trigger (link/element click, form submit, or a custom_event), and create it as a DRAFT only — never publish. Show me the plan (tag + trigger + variables) and confirm before writing anything.`,
  },
  {
    name: 'debug',
    hint: '<tag name>',
    desc: "Diagnose why a tag isn't firing",
    product: 'gtm',
    expand: (a) =>
      `Help me debug why ${a ? `the tag "${a}"` : 'a tag'} is not firing. Check, in order: is it paused? does it have a firing trigger? do the trigger's conditions actually match the interaction (exact click text / form id / event name — never URL-encoded)? do the variables it references still resolve? is Consent Mode blocking it? Tell me the single most likely cause with the evidence you found, then the fix. Read-only investigation.`,
  },
  {
    name: 'explain',
    hint: '<concept or resource>',
    desc: 'Explain a concept or one of your resources',
    // no product — works in whatever mode the chat is in.
    expand: (a) =>
      a
        ? `Explain "${a}" clearly and concretely. If it is a GTM/GA4 concept, give a plain-language explanation with a short concrete example. If it names a specific tag / trigger / variable / container in my account, look it up and explain what it does, exactly when it fires, and anything notable or risky about its config. End with one practical takeaway. Read-only.`
        : `Explain a GTM or GA4 concept, or one of my tags / triggers / variables. Ask me what I would like explained, then explain it clearly with a concrete example. Read-only.`,
  },
];

const BY_NAME = new Map(CHAT_SLASH_COMMANDS.map((c) => [c.name, c]));

/** Parse "/name rest…" → the command + its trimmed args, or null if the text isn't a known slash
 *  command (so ordinary messages — and paths like "/etc/passwd" — pass through untouched). */
export function parseSlashCommand(text: string): { command: SlashCommand; args: string } | null {
  const m = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const command = BY_NAME.get(m[1].toLowerCase());
  return command ? { command, args: (m[2] ?? '').trim() } : null;
}

/** What the chat brain should actually receive for a message, plus how to DISPLAY it and which product
 *  to run it in. For a plain message, sent === display and product is unchanged (undefined). */
export function resolveChatInput(text: string, currentProduct: ChatProduct): { display: string; sent: string; product: ChatProduct } {
  const parsed = parseSlashCommand(text);
  if (!parsed) return { display: text, sent: text, product: currentProduct };
  return { display: text, sent: parsed.command.expand(parsed.args), product: parsed.command.product ?? currentProduct };
}

/** The commands to show in the autocomplete menu for the current input — only while the user is typing a
 *  bare "/partial" (no space yet). Empty once they add a space/args or the input isn't a slash. */
export function slashMenuMatches(input: string): SlashCommand[] {
  const m = /^\/([a-z-]*)$/i.exec(input);
  if (!m) return [];
  const q = m[1].toLowerCase();
  return CHAT_SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}
