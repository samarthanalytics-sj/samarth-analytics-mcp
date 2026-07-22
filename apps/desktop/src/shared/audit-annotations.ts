// Attaching what the user already told us to the findings an audit produces.
//
// The audit reports evidence, not opinions. So when someone has said "the Meta pixel is ungated on
// purpose, we do not operate in the EU", the tempting move is to stop reporting that finding. That
// would be wrong twice over: the note may be stale or simply mistaken, and an audit that hides a
// Critical consent finding because of a sentence typed months ago is no longer an audit.
//
// So annotation is STRICTLY ADDITIVE. It attaches the note to the finding and changes nothing else:
// not the severity, not the confidence, not the recommendation, not the count, not the order. The
// operator reads the finding at full weight AND sees what they said about it, and decides. That
// invariant is asserted in the tests, because it is the entire reason this is safe to build.
//
// PURE. The caller reads the memory store and applies the result.

/** A saved note, reduced to what this needs. */
export interface AnnotationMemory {
  id?: string;
  kind: string;
  text: string;
  enabled?: boolean;
  updatedAt?: number;
}

/** The finding fields this reads. Deliberately a subset: nothing here may write the rest. */
export interface AnnotatableFinding {
  category: string;
  message: string;
  checkId?: string;
  resource?: { kind: string; id: string; name: string; type?: string };
}

/** The note attached to a finding, plus how strongly it applies. */
export interface FindingAnnotation {
  /** The saved note, verbatim. */
  text: string;
  /** id of the memory, so the UI can link to it in Settings > Memory. */
  memoryId?: string;
  /** 'named' = the note names this exact resource; 'topic' = it speaks to this kind of finding. */
  basis: 'named' | 'topic';
  /** True when the note reads as a deliberate decision ("on purpose", "by design", "we know"). */
  acknowledged: boolean;
}

/** Phrasings that mark a note as a conscious decision rather than an observation. */
const ACKNOWLEDGED = /\b(on purpose|intentional(?:ly)?|by design|deliberate(?:ly)?|we know|known|accepted|agreed|signed off|won'?t fix|wontfix|not a (?:bug|problem|concern))\b/i;

/** Finding categories, mapped to the words a human uses for them. */
const TOPIC_TERMS: Record<string, string[]> = {
  consent: ['consent', 'consent mode', 'gdpr', 'cmp', 'cookie banner', 'ad_storage', 'analytics_storage'],
  paused: ['paused', 'pause'],
  unused: ['unused', 'orphan', 'orphaned'],
  naming: ['naming', 'name convention', 'naming convention'],
  duplicate: ['duplicate', 'double firing', 'double-firing', 'double counting', 'double-counting'],
  deprecated: ['deprecated', 'universal analytics', 'legacy'],
};

/** Words too generic to prove a note is about a particular resource. */
const WEAK = new Set(['tag', 'tags', 'trigger', 'triggers', 'variable', 'variables', 'event', 'events', 'form', 'click', 'page', 'ga4', 'gtm', 'google']);

/** Does `text` mention this resource by name? Requires a distinctive token, not just "Tag". */
function namesResource(text: string, name: string | undefined): boolean {
  const hay = String(text ?? '').toLowerCase();
  const raw = String(name ?? '').trim().toLowerCase();
  if (!raw) return false;
  if (raw.length >= 6 && hay.includes(raw)) return true; // the whole name, quoted or inline
  const tokens = raw.split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !WEAK.has(t));
  if (!tokens.length) return false;
  // Every distinctive word of the resource name must appear: "Meta Pixel Purchase" should not attach
  // to a note that only says "purchase".
  return tokens.every((t) => hay.includes(t));
}

/** Does `text` speak to this finding's topic? */
function namesTopic(text: string, category: string): boolean {
  const terms = TOPIC_TERMS[String(category ?? '').toLowerCase()];
  if (!terms) return false;
  const hay = String(text ?? '').toLowerCase();
  return terms.some((t) => hay.includes(t));
}

/**
 * Find the note that best explains a finding, or nothing.
 *
 * A note that names the resource wins over one that merely discusses the topic, and among equals the
 * most recently updated wins, because that is the one the operator last believed.
 */
export function annotationFor(
  finding: AnnotatableFinding,
  memories: readonly AnnotationMemory[],
): FindingAnnotation | undefined {
  const usable = (memories ?? []).filter((m) => m && m.enabled !== false && String(m.text ?? '').trim());
  const scored: Array<{ m: AnnotationMemory; basis: 'named' | 'topic' }> = [];
  for (const m of usable) {
    if (namesResource(m.text, finding.resource?.name)) scored.push({ m, basis: 'named' });
    else if (namesTopic(m.text, finding.category)) scored.push({ m, basis: 'topic' });
  }
  if (!scored.length) return undefined;
  scored.sort((a, b) =>
    (a.basis === b.basis ? 0 : a.basis === 'named' ? -1 : 1)
    || (b.m.updatedAt ?? 0) - (a.m.updatedAt ?? 0));
  const best = scored[0];
  return {
    text: best.m.text,
    ...(best.m.id ? { memoryId: best.m.id } : {}),
    basis: best.basis,
    acknowledged: ACKNOWLEDGED.test(best.m.text),
  };
}

/**
 * Annotate every finding that has a relevant note.
 *
 * Returns NEW finding objects carrying `userNote`, with every other field copied through untouched.
 * Severity, confidence, recommendation, fix, order and count are all preserved by construction: this
 * only ever adds a field.
 */
export function annotateFindings<T extends AnnotatableFinding>(
  findings: readonly T[],
  memories: readonly AnnotationMemory[],
): Array<T & { userNote?: FindingAnnotation }> {
  return (findings ?? []).map((f) => {
    const note = annotationFor(f, memories);
    return note ? { ...f, userNote: note } : { ...f };
  });
}

/** How the UI should introduce the note, given how it was matched. */
export function annotationLabel(a: FindingAnnotation): string {
  if (a.acknowledged) return 'You noted this is intentional. It is still reported at full severity, because a note cannot prove runtime behaviour.';
  return a.basis === 'named' ? 'Your note about this resource:' : 'Your note on this topic:';
}
