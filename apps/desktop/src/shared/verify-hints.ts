// Letting a saved note spare the verifier a run it cannot win.
//
// Verification drives a container's real tags against the live site. Some tags cannot be driven at
// all for reasons the app has no way to see: the form sits behind a login, the CTA only exists for
// signed-in users, the flow only works in production. Every run attempts them, fails, and reports an
// inconclusive verdict that the operator has to re-interpret each time.
//
// If the operator has already said so in chat, the run can skip those tags. The rule that makes this
// safe is that a skip is NOT a pass: a skipped tag is reported in the existing "not verifiable" list
// with the note that caused it, never counted as verified, and never silently dropped. An
// unverifiable tag and a broken tag must stay distinguishable.
//
// Parsing is FAIL-CLOSED, like the suggestion rules: only phrasings that name a subject AND state a
// reason are read. A note this cannot parse changes nothing, which keeps a stray sentence from
// quietly shrinking a verification run.
//
// PURE. The caller reads the memory store and applies the result.

/** A saved note, reduced to what this needs. */
export interface HintMemory {
  id?: string;
  kind: string;
  text: string;
  enabled?: boolean;
}

/** One reason to skip, and the words that identify what it applies to. */
export interface VerifySkipHint {
  /** The subject as written, for the report. */
  subject: string;
  /** Distinctive lowercase terms of the subject, for matching. */
  terms: string[];
  /** Why it cannot be driven, in the user's own words. */
  reason: string;
  /** The whole note, so the report can cite it. */
  source: string;
  memoryId?: string;
}

/**
 * Words that identify nothing on their own.
 *
 * Three groups: GTM nouns ("tag", "form"), generic quantifiers ("some", "things") which is what keeps
 * "some things cannot be tested" from skipping anything, and shape descriptors ("flow", "journey")
 * so "the checkout flow" identifies itself by "checkout" and still matches a /checkout page.
 */
const WEAK = new Set([
  'tag', 'tags', 'trigger', 'triggers', 'form', 'forms', 'page', 'pages', 'button', 'link', 'event',
  'events', 'the', 'this', 'that', 'our', 'their', 'site', 'website', 'ga4', 'gtm', 'google', 'and',
  'for', 'with', 'from', 'only', 'just', 'all', 'any', 'test', 'tests', 'testing',
  'some', 'thing', 'things', 'stuff', 'everything', 'anything', 'nothing', 'most', 'many', 'them',
  'flow', 'flows', 'journey', 'funnel', 'process', 'steps', 'step', 'section', 'part',
]);

/**
 * Phrasings that state BOTH a subject and an untestable reason. Group 1 is the subject.
 *
 * Deliberately narrow. "the contact form is important" names a subject and no reason; "we cannot test
 * things" names a reason and no subject. Neither skips anything.
 */
const SKIP_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(.{3,60}?)\s+(?:is|are|sits?|lives?)\s+behind\s+(?:a\s+)?(?:login|log ?in|paywall|auth\w*|sign ?in)/i, reason: 'behind a login' },
  { re: /\b(.{3,60}?)\s+(?:requires?|needs?)\s+(?:an?\s+)?(?:login|log ?in|sign ?in|auth\w*|account)/i, reason: 'requires sign-in' },
  { re: /\b(?:do\s*n[o']?t|don't|never|skip|stop)\s+(?:verify|verifying|test|testing|drive|driving)\s+(.{3,60})/i, reason: 'you asked not to verify it' },
  { re: /\b(.{3,60}?)\s+(?:can(?:no|')?t|cannot)\s+be\s+(?:verified|tested|driven|automated)/i, reason: 'cannot be driven' },
  { re: /\b(.{3,60}?)\s+only\s+works?\s+(?:in|on)\s+production/i, reason: 'production only' },
];

/** Significant words of a subject phrase. */
export function subjectTerms(subject: string): string[] {
  return [...new Set(
    String(subject ?? '')
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 4 && !WEAK.has(w)),
  )];
}

/**
 * Read verification skips out of saved notes.
 *
 * Only `rule`, `preference`, `decision` and `fact` notes are read. Unlike the suggestion rules a
 * `fact` counts here, because "the pricing form is behind a login" IS a fact about the site and is
 * exactly the thing worth acting on. Muted notes are skipped, as everywhere else.
 */
export function deriveVerifyHints(memories: readonly HintMemory[]): VerifySkipHint[] {
  const out: VerifySkipHint[] = [];
  const seen = new Set<string>();
  for (const m of memories ?? []) {
    if (!m || m.enabled === false) continue;
    if (!['rule', 'preference', 'decision', 'fact'].includes(String(m.kind))) continue;
    const text = String(m.text ?? '');
    for (const { re, reason } of SKIP_PATTERNS) {
      const hit = re.exec(text);
      if (!hit) continue;
      const subject = hit[1].replace(/^(?:the|our|their|a|an)\s+/i, '').replace(/[.,;]+$/, '').trim();
      const terms = subjectTerms(subject);
      if (!terms.length) break; // a reason with no identifiable subject skips nothing
      const key = terms.join('|');
      if (seen.has(key)) break;
      seen.add(key);
      out.push({ subject, terms, reason, source: text, ...(m.id ? { memoryId: m.id } : {}) });
      break; // one hint per note
    }
  }
  return out;
}

/** The tag fields this reads. */
export interface HintTag {
  id: string;
  tagName: string;
  eventName?: string;
  page?: string;
}

export interface AppliedHints<T> {
  /** Tags still worth driving. */
  tags: T[];
  /** Tags held back, each with the note that caused it. NEVER a pass. */
  skipped: Array<{ id: string; tagName: string; reason: string; subject: string; source: string }>;
}

/**
 * Hold back the tags a note says cannot be driven.
 *
 * A tag matches a hint when every distinctive word of the hint's subject appears in the tag's name,
 * event or page, so "pricing form" holds back the pricing form and not every form on the site.
 */
export function applyVerifyHints<T extends HintTag>(tags: readonly T[], hints: readonly VerifySkipHint[]): AppliedHints<T> {
  const keep: T[] = [];
  const skipped: AppliedHints<T>['skipped'] = [];
  for (const t of tags ?? []) {
    if (!t) continue;
    const hay = `${t.tagName ?? ''} ${t.eventName ?? ''} ${t.page ?? ''}`.toLowerCase();
    const hit = (hints ?? []).find((h) => h.terms.every((term) => hay.includes(term)));
    if (hit) skipped.push({ id: t.id, tagName: t.tagName, reason: hit.reason, subject: hit.subject, source: hit.source });
    else keep.push(t);
  }
  return { tags: keep, skipped };
}

/** The line shown in the "not verifiable" list, so a skip never reads as a pass. */
export function describeVerifySkip(s: { reason: string; subject: string }): string {
  return `Not attempted: your saved note says "${s.subject}" is ${s.reason}. This is NOT a pass - the tag was never driven, so nothing is known about whether it fires. Remove that note in Settings > Memory to verify it anyway.`;
}
