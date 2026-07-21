// Is a form's DOM id the SAME id on the next page load?
//
// Some embedded form providers mint a fresh id every time the form renders. HubSpot is the one that
// prompted this: its embedded form carries an id built from a per-render instance GUID joined to the
// real form GUID, so three scans of one page produced three different ids, all ending in the same
// form GUID.
//
// That matters far beyond a confusing scan report. The suggestion engine scopes a Form Submission
// trigger with {{Form ID}} equals <id>, so an ephemeral id produces a tag that GTM accepts, reports
// as created, and which can then NEVER fire - the id it matches does not exist on any later load.
// A silent, permanent tracking gap that looks like a success.
//
// The rule here is evidence-based, never a guess about a vendor's internals:
//
//   With 2+ ids for the SAME form (the engine already collects these per label, one per page), a
//   shared UUID that appears in all of them while the rest varies is the durable identity. That
//   yields a real scope: {{Form ID}} contains <shared GUID>, which matches every future render.
//
//   With a SINGLE sample there is no way to tell which half is durable. Rather than guess (and
//   risk a trigger that never matches), the id is dropped and the caller falls back to class or
//   page scoping, which fires and can be tightened, instead of silently firing never.

/** A UUID as embedded form providers emit it. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Every UUID inside an id, lowercased, in order. */
export function uuidsIn(id: string): string[] {
  return (String(id ?? '').match(UUID_RE) ?? []).map((u) => u.toLowerCase());
}

/**
 * Could this id have been generated per render?
 *
 * True when it carries a UUID: no site hand-writes one as a stable hook, and every provider that
 * does so (HubSpot, Marketo instances, some React embeds) regenerates at least part of it. Being
 * wrong here is cheap (the trigger falls back to class or page scope, which still fires); the
 * opposite mistake ships a tag that never fires.
 */
export function looksEphemeralFormId(id: string | undefined): boolean {
  return uuidsIn(String(id ?? '')).length > 0;
}

export interface FormIdScope {
  /** The GTM operator to use for {{Form ID}}. */
  operator: 'equals' | 'contains' | 'matchRegex';
  value: string;
  /** Set when the ids were ephemeral and a durable fragment was proven from several samples. */
  stabilized?: boolean;
  /** Plain-language reason, surfaced on the suggestion so the operator can see the reasoning. */
  note?: string;
}

/**
 * How to scope {{Form ID}} for one form, given every id it was seen with.
 *
 * Returns null when no id can be trusted, which tells the caller to fall back down its ladder
 * (class, then page).
 */
export function formIdScope(ids: readonly string[]): FormIdScope | null {
  const seen = [...new Set((ids ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))];
  if (!seen.length) return null;

  const ephemeral = seen.some((id) => looksEphemeralFormId(id));
  if (!ephemeral) {
    // Ordinary hand-written ids: unchanged behaviour.
    if (seen.length === 1) return { operator: 'equals', value: seen[0] };
    return { operator: 'matchRegex', value: `^(${seen.map(escapeRe).join('|')})$` };
  }

  // Ephemeral, and we have more than one sample: a UUID present in EVERY id is the durable identity.
  if (seen.length >= 2) {
    const shared = uuidsIn(seen[0]).filter((u) => seen.every((id) => uuidsIn(id).includes(u)));
    // Only useful if it does not appear in every position of every id by coincidence of being the
    // whole id (that case is not ephemeral at all), and if something else genuinely varies.
    const varies = new Set(seen).size > 1;
    if (shared.length && varies) {
      return {
        operator: 'contains',
        value: shared[0],
        stabilized: true,
        note:
          `This form's DOM id changes on every page load (${seen.length} different ids were seen for the same form), so an exact {{Form ID}} match would never fire again. ` +
          `The trigger matches the part that stayed the same: {{Form ID}} contains "${shared[0]}".`,
      };
    }
  }

  return null;
}

/** Why the id was refused, for the suggestion's note. Null when there is nothing to explain. */
export function ephemeralFormIdNote(ids: readonly string[]): string | null {
  const seen = [...new Set((ids ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))];
  if (!seen.length || !seen.some(looksEphemeralFormId)) return null;
  if (formIdScope(seen)?.stabilized) return null;
  return (
    `This form's id looks generated per page load (it contains a UUID), so a {{Form ID}} trigger built on it would be accepted by GTM and then never fire. ` +
    'It is scoped by class or page instead. For a form-specific trigger, add a stable id to the form, or scope on the provider id that does not change between loads.'
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
