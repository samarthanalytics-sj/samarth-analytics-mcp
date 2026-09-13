// Pure engine: EVENT-NAME HYGIENE. GA4 treats every spelling as a separate event ("PageView",
// "page-view" and "page_view" are three different events), so naming drift silently splits reports,
// breaks standard-report/tooling recognition, and makes windows incomparable. This engine flags,
// over the event names the audit ALREADY fetched (no new API calls):
//   1. Naming-convention violations, each with the EXACT rename - a standard GA4 name when the event
//      is clearly a misspelt standard event (signup -> sign_up), else the snake_case form.
//   2. High-cardinality name FAMILIES (product_1234_click, product_1235_click, ...) - the changing
//      part belongs in a parameter; per-name events bloat toward GA4's distinct-event limits.
//   3. Key events that NEVER fired - marked as conversions but recorded zero times in the current
//      AND prior window (the drop-to-zero case, prior>0 -> 0, is ga4-integrity's job; this catches
//      the goal that never worked at all). Skipped honestly when the event list may be truncated.
// Aggregated findings (one per check), same shape as the config audit, so they ride the existing
// findings table / score / Slack summary without new plumbing.

import type { Ga4Finding } from './ga4-audit';

export interface Ga4EventHygieneInput {
  /** Current + prior window events with counts (getGa4EventDeltas output). */
  events: Array<{ name: string; count: number; priorCount?: number }>;
  keyEventNames: string[];
  /** True when the event list may have hit the query row cap - the never-fired check then stays
   *  silent rather than calling a low-volume event dead. */
  possiblyTruncated?: boolean;
  windowDays?: number;
}

/** GA4 standard (auto + recommended) event names: when an observed name is one of these with the
 *  punctuation/casing wrong, the rename suggestion is the STANDARD name, not just snake_case. */
const STANDARD_EVENTS = [
  'page_view', 'session_start', 'first_visit', 'user_engagement', 'file_download', 'form_start', 'form_submit',
  'sign_up', 'login', 'search', 'share', 'select_content', 'contact', 'generate_lead', 'working_lead',
  'qualify_lead', 'close_convert_lead', 'purchase', 'refund', 'add_to_cart', 'remove_from_cart', 'view_item',
  'view_item_list', 'select_item', 'view_cart', 'begin_checkout', 'add_shipping_info', 'add_payment_info',
  'add_to_wishlist', 'view_promotion', 'select_promotion', 'video_start', 'video_progress', 'video_complete',
  'tutorial_begin', 'tutorial_complete', 'join_group', 'submit_application',
];

const normKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const STANDARD_BY_NORM = new Map(STANDARD_EVENTS.map((e) => [normKey(e), e]));

/** Lowercase snake_case per GA4 conventions. */
export const toSnakeEventName = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s\-.]+/g, '_')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');

const VALID_NAME = /^[a-z][a-z0-9_]*$/;
/** System/internal names the checks must ignore. */
const ignored = (name: string): boolean => !name || name === '(not set)' || name.startsWith('gtm.') || name.startsWith('_');

export function auditGa4EventHygiene(input: Ga4EventHygieneInput): Ga4Finding[] {
  const out: Ga4Finding[] = [];
  const active = input.events.filter((e) => !ignored(e.name) && (e.count > 0 || (e.priorCount ?? 0) > 0));

  // ── 1 · Naming-convention violations, each with its exact rename ──
  const renames: Array<{ name: string; suggested: string; standard: boolean; count: number }> = [];
  for (const e of active) {
    const std = STANDARD_BY_NORM.get(normKey(e.name));
    if (std && e.name !== std) {
      renames.push({ name: e.name, suggested: std, standard: true, count: e.count });
    } else if (!std && !VALID_NAME.test(e.name)) {
      const snake = toSnakeEventName(e.name);
      if (snake && snake !== e.name) renames.push({ name: e.name, suggested: snake, standard: false, count: e.count });
    }
  }
  if (renames.length) {
    renames.sort((a, z) => Number(z.standard) - Number(a.standard) || z.count - a.count);
    const shown = renames.slice(0, 8).map((r) => `"${r.name}" -> ${r.suggested}${r.standard ? ' (GA4 standard name)' : ''}`).join(', ');
    const more = renames.length > 8 ? ` (+${renames.length - 8} more)` : '';
    const stdCount = renames.filter((r) => r.standard).length;
    out.push({
      severity: stdCount ? 'medium' : 'low',
      category: 'hygiene',
      message: `${renames.length} event name${renames.length === 1 ? '' : 's'} violate GA4 naming conventions: ${shown}${more}. GA4 treats every spelling as a SEPARATE event, so these split reports across variants${stdCount ? `, and ${stdCount} of them are misspelt STANDARD events - GA4's built-in reports and integrations only recognise the exact standard name` : ''}.`,
      recommendation: 'Rename at the source (the GTM tag’s Event Name field or the code that pushes the event) to lowercase snake_case, using the exact GA4 standard name where one exists. Renames are not retroactive - old names stay in historical data, so compare windows carefully after the change.',
    });
  }

  // ── 2 · High-cardinality name families (ids embedded in the NAME instead of a parameter) ──
  const families = new Map<string, { members: number; example: string; events: number }>();
  for (const e of active) {
    const fam = e.name.replace(/\d+/g, '#');
    if (!fam.includes('#')) continue;
    const f = families.get(fam) ?? { members: 0, example: e.name, events: 0 };
    f.members += 1;
    f.events += e.count;
    families.set(fam, f);
  }
  const bloated = [...families.entries()].filter(([, f]) => f.members >= 5).sort((a, z) => z[1].members - a[1].members);
  if (bloated.length) {
    const shown = bloated.slice(0, 3).map(([fam, f]) => `${fam} (${f.members} variants, e.g. "${f.example}")`).join(', ');
    const total = bloated.reduce((sum, [, f]) => sum + f.members, 0);
    out.push({
      severity: 'medium',
      category: 'hygiene',
      message: `High-cardinality event names: ${shown}${bloated.length > 3 ? ` (+${bloated.length - 3} more families)` : ''} - ${total} distinct event names that differ only by an embedded number. Each variant is a separate GA4 event, so reports are unreadable and the property creeps toward GA4's distinct-event-name limits.`,
      recommendation: 'Send ONE event per family and move the changing part (the id) into an event parameter (e.g. product_click with a product_id parameter), then register that parameter as a custom dimension if you need to segment by it.',
    });
  }

  // ── 3 · Key events that NEVER fired (zero in current AND prior window) ──
  // Truncated event list -> a low-volume event may simply be beyond the cap; stay silent (honest).
  if (!input.possiblyTruncated) {
    const seen = new Map(input.events.map((e) => [e.name, e]));
    const silent = input.keyEventNames.filter((k) => {
      if (!k || ignored(k)) return false;
      const e = seen.get(k);
      return !e || (e.count === 0 && (e.priorCount ?? 0) === 0); // prior>0 -> 0 is ga4-integrity's drop-to-zero
    });
    if (silent.length) {
      const span = input.windowDays ? ` in the last ${input.windowDays * 2} days (current + prior window)` : '';
      out.push({
        severity: 'medium',
        category: 'integrity',
        message: `Key event${silent.length === 1 ? '' : 's'} that never fired: ${silent.map((s) => `"${s}"`).join(', ')} - marked as ${silent.length === 1 ? 'a conversion' : 'conversions'} but recorded ZERO times${span}. Either the tag never fires, or the key-event name in GA4 does not exactly match the event the site actually sends.`,
        recommendation: 'Trigger the action once and watch GA4 DebugView/Realtime: if nothing arrives, fix the tag; if an event arrives under a DIFFERENT name, align the key-event name to it (exact match). If the goal is retired, un-mark it as a key event so conversion counts stay honest.',
      });
    }
  }

  return out;
}
