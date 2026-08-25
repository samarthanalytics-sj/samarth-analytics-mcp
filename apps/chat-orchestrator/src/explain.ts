/**
 * Turning a failure into a reason a person can act on.
 *
 * An event's Reason column is the one thing everybody reads, and until now it too often said
 * "Unexpected error" or carried a raw upstream body. Both are useless in different ways: the first
 * says nothing, the second says everything at once. "listen EADDRINUSE: address already in use
 * 127.0.0.1:8787" is precise and means nothing to most readers; "Port 8787 is already in use, so
 * another orchestrator is probably running" is the same fact, answerable.
 *
 * Pure and table-driven, so every rule is one line and every rule is testable. The full technical
 * text is never discarded - it rides in the event's `error` field, which the dashboard shows when a
 * row is expanded.
 *
 * The fallback matters as much as the rules. When nothing matches, this returns the FIRST SENTENCE
 * of the real message rather than a generic label, because an unrecognised error's own words beat
 * anything invented for it.
 */

export interface Explanation {
  /** Why it happened, in one short sentence. No trailing full stop: the surfaces add their own. */
  reason: string;
  /** What happens next, or what to do, when there is something worth saying. */
  action?: string;
}

/** Where the failure came from, which changes what an identical string means. */
export type FailureKind =
  | 'startup'
  | 'crash'
  | 'turn'
  | 'tool'
  | 'scan'
  | 'identity'
  | 'auth'
  | 'database'
  | 'slack';

interface Rule {
  /** Kinds this applies to. Absent means any. */
  kinds?: FailureKind[];
  re: RegExp;
  reason: string | ((m: RegExpMatchArray) => string);
  action?: string;
}

/**
 * Ordered, most specific first. A rule that could swallow a more precise one below it belongs
 * lower, not higher.
 */
const RULES: Rule[] = [
  // ── The process and its host ─────────────────────────────────────────────
  {
    re: /EADDRINUSE[^]*?(\d+\.\d+\.\d+\.\d+:(\d+)|:(\d+))/,
    reason: (m) => `Port ${m[2] ?? m[3]} is already in use, so another orchestrator is probably still running`,
    action: 'Stop the other process; the supervisor keeps retrying meanwhile',
  },
  { re: /EADDRINUSE/, reason: 'The port is already in use, so another orchestrator is probably still running' },
  {
    re: /spawn\s+(\S+)\s+ENOENT/,
    reason: (m) => `The program it tried to start was not found: ${m[1]}`,
    action: 'Check the path is built and correct',
  },
  { re: /ENOENT[^]*?(?:open|no such file)[^]*?'([^']+)'/, reason: (m) => `A file it needs is missing: ${m[1]}` },
  { re: /\bEACCES\b/, reason: 'The operating system refused access to a file or port' },
  {
    re: /heap out of memory|ERR_WORKER_OUT_OF_MEMORY|Allocation failed/,
    reason: 'The process ran out of memory',
    action: 'The supervisor restarts it; if it repeats, fewer MCP sessions or more RAM',
  },
  { re: /\bENOSPC\b/, reason: 'The disk is full' },

  // ── Reaching other machines ──────────────────────────────────────────────
  {
    re: /ECONNREFUSED[^]*?(\d+\.\d+\.\d+\.\d+:\d+)/,
    reason: (m) => `Nothing is listening at ${m[1]}`,
  },
  { re: /\bECONNREFUSED\b/, reason: 'The connection was refused: the other end is not running' },
  { re: /ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/, reason: 'The hostname could not be resolved' },
  { re: /\bECONNRESET\b|\bEPIPE\b|socket hang up/, reason: 'The connection dropped mid-request' },
  {
    re: /certificate|ERR_CERT|SELF_SIGNED|CERT_HAS_EXPIRED|ERR_TLS/i,
    reason: 'The other end presented a certificate this machine would not accept',
  },
  {
    re: /\bETIMEDOUT\b|ESOCKETTIMEDOUT|\bAbortError\b|The operation was aborted|timed? ?out/i,
    reason: 'It took too long and was given up on',
  },

  // ── OpenAI ───────────────────────────────────────────────────────────────
  {
    re: /insufficient_quota|exceeded your current quota|billing_hard_limit|account is not active/i,
    reason: 'The OpenAI account has no remaining credit',
    action: 'Add credit; retrying will not help until then',
  },
  {
    re: /rate_limit_exceeded|tokens per min|TPM|Rate limit reached/i,
    reason: "OpenAI's per-minute limit for this account was full",
    action: 'It clears on its own; the turn retries or the user can resend',
  },
  {
    re: /invalid_api_key|Incorrect API key|no API key provided/i,
    reason: 'OpenAI rejected the API key',
    action: 'Check OPENAI_API_KEY on the orchestrator host',
  },
  {
    re: /model_not_found|does not exist or you do not have access/i,
    reason: 'OpenAI rejected the configured model',
    action: 'Run "npm run models" for the ids this key can use, then set OPENAI_MODEL',
  },
  { kinds: ['turn'], re: /context_length_exceeded|maximum context length/i, reason: 'The conversation grew past the model\'s context limit' },

  // ── Google, through the MCP ──────────────────────────────────────────────
  {
    re: /invalid_grant|Token has been expired or revoked|access token has expired|invalid authentication credentials|invalid credentials/i,
    reason: "The user's Google authorization has expired or been revoked",
    action: 'They reconnect Google from Settings',
  },
  {
    re: /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient permission/i,
    reason: 'The Google account is connected but not with the permissions this needs',
    action: 'They reconnect Google and accept the requested access',
  },
  {
    re: /request is missing required authentication credential|could not load the default credentials/i,
    reason: 'No Google credentials were available for this request',
  },
  {
    re: /quotaExceeded|RESOURCE_EXHAUSTED|rateLimitExceeded|userRateLimitExceeded/i,
    reason: "Google's API quota for this project was exhausted",
    action: 'It refills on its own; heavy runs may need spacing out',
  },
  {
    re: /PERMISSION_DENIED|\bpermission\b[^]*\bdenied\b|does not have permission/i,
    reason: 'Google refused: this account cannot reach that container or property',
  },
  { re: /\bNOT_FOUND\b|Requested entity was not found/i, reason: 'Google could not find what was asked for' },
  { re: /FAILED_PRECONDITION/i, reason: 'Google refused the request in the state that resource is in' },
  { re: /INVALID_ARGUMENT/i, reason: 'Google rejected one of the values sent' },

  // ── Supabase and the database ────────────────────────────────────────────
  {
    re: /relation "?([\w.]+)"? does not exist|Could not find the table/i,
    reason: (m) => `The database is missing ${m[1] ?? 'a table this needs'}`,
    action: 'Apply the outstanding migrations',
  },
  { re: /schema cache|PGRST\d+/i, reason: 'The database rejected the request through PostgREST' },
  { re: /JWSError|jwt expired|invalid signature|JWT/i, reason: 'A token failed verification' },
  { kinds: ['database'], re: /\b401\b|\b403\b/, reason: 'The database refused the credentials this process is using' },

  // ── Browsing, for site scans ─────────────────────────────────────────────
  { kinds: ['scan'], re: /net::ERR_|NS_ERROR|Navigation timeout|net::ERR_ABORTED/i, reason: 'The page could not be loaded' },
  { kinds: ['scan'], re: /\b403\b|Forbidden|blocked|captcha/i, reason: 'The site refused the scanner' },
  { kinds: ['scan'], re: /Executable doesn't exist|browserType\.launch/i, reason: 'The browser the scanner needs is not installed on this host' },

  // ── Slack ────────────────────────────────────────────────────────────────
  { kinds: ['slack'], re: /no_service|no_team|invalid_token/i, reason: 'Slack no longer recognises this webhook', action: 'Issue a new one and save it in Admin > Orchestrator' },
  { kinds: ['slack'], re: /channel_not_found|not_in_channel/i, reason: 'The Slack channel this webhook points at is gone or closed to it' },
  { kinds: ['slack'], re: /invalid_payload/i, reason: 'Slack rejected the message body' },

  // ── The MCP session ──────────────────────────────────────────────────────
  { re: /MCP|stdio transport|Connection closed/i, kinds: ['startup', 'crash', 'turn', 'identity'], reason: 'The MCP tool server could not be reached' },
];

/** Strips wrappers that carry no meaning: "Error: ", codes in brackets, trailing punctuation. */
function tidy(text: string): string {
  return text
    .replace(/^\s*(?:[A-Za-z]*Error|Exception):\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The first sentence, for when no rule matches.
 *
 * An unrecognised failure's own first clause is more informative than any label invented for it, so
 * this trims rather than replaces. Bounded, because some upstream bodies are a page of JSON.
 */
function firstSentence(text: string, max = 140): string {
  const flat = tidy(text);
  if (!flat) return 'No reason was reported';
  // A JSON body has no sentences worth taking; name it rather than quoting a fragment of it.
  if (/^[[{]/.test(flat)) {
    const message = flat.match(/"(?:message|error_description|detail)"\s*:\s*"((?:[^"\\]|\\.){3,200})"/);
    if (message) return tidy(message[1]).slice(0, max);
    return 'The other end returned an error with no readable message';
  }
  const cut = flat.split(/(?<=[.!?])\s|(?=\s[-–—]\s)|\n/)[0] ?? flat;
  const out = cut.replace(/[.\s]+$/, '');
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/**
 * The reason and, where there is one, what happens next.
 *
 * `status` and `code` are consulted only when the text alone does not decide it, so an upstream
 * message that already says what went wrong wins over a status code that merely says a family.
 */
export function explainError(
  raw: string,
  ctx: { kind?: FailureKind; code?: string; status?: number } = {},
): Explanation {
  const text = `${ctx.code ? `${ctx.code} ` : ''}${raw ?? ''}`;

  for (const rule of RULES) {
    if (rule.kinds && ctx.kind && !rule.kinds.includes(ctx.kind)) continue;
    if (rule.kinds && !ctx.kind) continue;
    const m = text.match(rule.re);
    if (!m) continue;
    return {
      reason: typeof rule.reason === 'function' ? rule.reason(m) : rule.reason,
      ...(rule.action ? { action: rule.action } : {}),
    };
  }

  // Nothing matched by text. A status code still narrows it to a family, which beats the raw body.
  if (ctx.status && ctx.status >= 500) {
    return { reason: `The other end returned a ${ctx.status}: ${firstSentence(raw, 80)}` };
  }
  if (ctx.status === 429) return { reason: 'Rate limited by the other end', action: 'It clears on its own' };
  if (ctx.status === 401 || ctx.status === 403) return { reason: `Refused (${ctx.status}): the credentials were not accepted` };

  return { reason: firstSentence(raw) };
}

/**
 * Why a process that was not asked to stop, stopped.
 *
 * The supervisor sees only an exit code, and on Windows every external kill arrives as the same
 * unsigned -1, so this says what that number means rather than printing it and hoping.
 */
export function explainExit(
  code: number | null,
  signal: string | null,
  fastExits = 0,
): Explanation {
  if (fastExits >= 3) {
    return {
      reason: `It has failed to stay up ${fastExits} times in a row, which is usually configuration rather than bad luck`,
      action: 'Check the error above this in the log, and the .env, before waiting for the next attempt',
    };
  }
  if (signal === 'SIGKILL' || code === 137) {
    return { reason: 'It was killed outright, usually by the operating system running short of memory' };
  }
  if (signal) return { reason: `It was stopped by ${signal}` };
  // 4294967295 is -1 unsigned: Windows reporting TerminateProcess, which is what an external stop
  // looks like here. 3221225786 is 0xC000013A, Ctrl+C in a console.
  if (code === 4294967295 || code === -1) {
    return { reason: 'Something outside the process stopped it, which on this host is how a deploy or a manual kill looks' };
  }
  if (code === 3221225786) return { reason: 'Someone pressed Ctrl+C in its console window' };
  if (code === 0) return { reason: 'It exited cleanly without being asked to, which it should never do' };
  if (code === 1) return { reason: 'It exited with an error' };
  if (code != null) return { reason: `It exited with code ${code}` };
  return { reason: 'It stopped without reporting why' };
}
