// PURE matching + field-dedup for CONTAINER-TAG-DRIVEN form verification (no browser).
//
// The flow: from the container's FORM tags (custom_event on form_submission, split by form name),
// find the site forms they target, keep only those, and collapse their fields into ONE de-duplicated
// data-entry set (email shown once). Fills/submits nothing — that's the driver's job.

import type { FormFillView, MatchedFormView, SharedFillField } from '../../shared/ipc';

/** A page's form + the page it lives on. */
export type PagedForm = FormFillView & { page: string };

/** A container FORM tag's identity hint for matching. */
export interface FormTagIdentity {
  tagName: string;
  eventName: string;
  /** ga4_event / meta_pixel / linkedin_insight / … — so the verdict + fix know GA4 vs pixel. */
  platform: string;
  /** The tag's resolved form-name condition (customEventData), when present — the best match key. */
  formName?: string;
}

// Words that don't help tell one form from another (tag-name boilerplate + generic filler).
// Includes generic OFFER words ("consultation", "audit", "mockup", …) that appear across many form-tag
// names ("Get Your Free <service> Consultation Form Tag") but almost never in the form itself — leaving
// them in inflated the tag's token count and, under the majority rule, kept the SERVICE token (ga4,
// conversion, cro, …) from carrying the match. The service token is the real signal; these are noise.
const STOP = new Set([
  'form', 'forms', 'tag', 'tags', 'the', 'ga4', 'event', 'events', 'get', 'your', 'a', 'an', 'to',
  'for', 'and', 'of', 'us', 'our', 'gtm', 'click', 'submit', 'submission', 'free', 'new',
  'consultation', 'audit', 'audits', 'mockup',
]);

function tokens(s: string): Set<string> {
  const norm = (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return new Set(norm.split(' ').filter((t) => t.length > 2 && !STOP.has(t)));
}

/** The token-sets to try as a tag's FORM identity, most-specific first: its resolved form_name (the
 *  trigger condition, when present), its tag NAME, then its event name. A tag matches a form if ANY of
 *  these yields a confident overlap — because a site can bind many DOM-identical, ANONYMOUS forms (no
 *  id/name/title) that differ only by page path, while giving them a shared/generic `form_name` condition
 *  (e.g. one "solution_contact_form" across every /services/* page). In that case the SERVICE token that
 *  actually distinguishes the form lives in the tag NAME ("… GA4 Implementation Consultation …") and in
 *  the page path (/services/ga4-implementation), NOT in the generic form_name — so keying only off
 *  form_name misses the match. Deduped; empty sets dropped. GA4 boilerplate is stripped by the STOP set. */
function tagIdentities(tag: FormTagIdentity): Set<string>[] {
  const out: Set<string>[] = [];
  const seen = new Set<string>();
  const add = (s: Set<string>): void => {
    if (s.size === 0) return;
    const k = [...s].sort().join(',');
    if (!seen.has(k)) { seen.add(k); out.push(s); }
  };
  if (tag.formName && tag.formName.trim()) add(tokens(tag.formName));
  add(tokens(tag.tagName));
  add(tokens(tag.eventName));
  return out;
}

/** True when a custom-event trigger's event name denotes a FORM submission (form_submission,
 *  form_submit, submit_form …). Scroll/CTA/other custom-event tags (custom_scroll_depth, cta_click)
 *  are NOT form tags, so they must be excluded before form matching — otherwise they get piled onto a
 *  form and reported as failing to "fire on submit". Bounded by `_`/ends so "platform_view" is not a
 *  form event. PURE. */
export function isFormEventName(eventName: string): boolean {
  return /(^|_)forms?(_|$)/i.test(eventName ?? '');
}

/** The form's identity text: its visible title + form id, PLUS the tokens of the page it lives on.
 *  The page path disambiguates the many near-identical service/solution landing forms — e.g. a generic
 *  "Get a Free Audit" form on /services/cro-audits contributes {cro, audits}, so the CRO tag matches it
 *  where the visible title alone would not. */
function formIdentity(form: FormFillView & { page?: string }): Set<string> {
  const t = tokens(form.title);
  for (const e of tokens(form.formId)) t.add(e);
  if (form.page) {
    try { for (const e of tokens(new URL(form.page).pathname.replace(/[/_-]+/g, ' '))) t.add(e); } catch { /* not a URL */ }
  }
  return t;
}

function shared(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

/** Match the container's form tags to the site's forms (by identity token overlap). Returns the UNIQUE
 *  forms that matched >=1 tag (each carrying the tag names expected to fire on it) + the tags that
 *  matched no form (a coverage gap). A tag matches its best form when they share >=1 distinctive token. */
export function matchFormsToTags(
  forms: PagedForm[],
  tags: FormTagIdentity[],
): { matched: MatchedFormView[]; unmatchedTags: string[] } {
  const formTok = forms.map(formIdentity);
  const byKey = new Map<string, MatchedFormView>();
  const unmatched: string[] = [];
  // Is a token->form match CONFIDENT? A strong MAJORITY of the identity's tokens must appear in the form
  // (>=60%, and >=2 when the identity has that many), so a single generic shared token never matches a
  // multi-token identity (the old "consultation" pile-on of ~18 Meta tags stays fixed). For a LONE-token
  // identity the token must be DISTINCTIVE (present in only a few forms). This replaced the old
  // full-coverage rule, which dropped e.g. a "Server Side Tracking Consultation" tag whose form shares
  // {server,side,tracking} but not "consultation" (3 of 4). Anything short stays a coverage gap.
  const scoreIdentity = (tt: Set<string>): { idx: number; score: number } => {
    let bestIdx = -1;
    let bestScore = 0;
    forms.forEach((_f, i) => {
      const sc = shared(tt, formTok[i]);
      if (sc > bestScore) { bestScore = sc; bestIdx = i; }
    });
    const need = Math.max(tt.size >= 2 ? 2 : 1, Math.ceil(tt.size * 0.6));
    let confident = bestIdx >= 0 && bestScore >= need;
    if (confident && tt.size === 1) {
      const only = [...tt][0];
      const formsWithTok = formTok.reduce((n, ft) => n + (ft.has(only) ? 1 : 0), 0);
      confident = formsWithTok <= Math.max(2, Math.ceil(forms.length * 0.25));
    }
    return confident ? { idx: bestIdx, score: bestScore } : { idx: -1, score: 0 };
  };
  for (const tag of tags) {
    // Try each of the tag's identities (form_name condition → tag name → event name) and keep the
    // strongest confident match. So when the form_name condition is generic/shared, the SERVICE token in
    // the tag name still pairs with the form's page-path token.
    let bestIdx = -1;
    let bestScore = -1;
    for (const tt of tagIdentities(tag)) {
      const r = scoreIdentity(tt);
      if (r.idx >= 0 && r.score > bestScore) { bestIdx = r.idx; bestScore = r.score; }
    }
    if (bestIdx >= 0) {
      const f = forms[bestIdx];
      const key = `${f.page}|${f.formId}|${f.title}`;
      let mv = byKey.get(key);
      if (!mv) {
        mv = {
          page: f.page,
          formTitle: f.title,
          formId: f.formId,
          formClasses: f.formClasses,
          method: f.method,
          purpose: f.purpose,
          fields: f.fields.map((x) => ({ selector: x.selector, type: x.type, role: x.role, label: x.label, value: x.value, ...(x.options && x.options.length ? { options: x.options } : {}) })),
          expectedTags: [],
        };
        byKey.set(key, mv);
      }
      if (!mv.expectedTags.some((x) => x.tagName === tag.tagName)) mv.expectedTags.push({ tagName: tag.tagName, eventName: tag.eventName, platform: tag.platform });
    } else {
      unmatched.push(tag.tagName);
    }
  }
  return { matched: [...byKey.values()], unmatchedTags: unmatched };
}

/** The de-dup key for a field: by role, except selects (their options differ) key on role+label. */
export function dedupKey(field: { role: string; label: string }): string {
  return field.role === 'select' ? `select|${(field.label ?? '').toLowerCase().trim()}` : field.role;
}

/** Collapse the matched forms' fields into ONE editable set — each distinct field shown ONCE (email
 *  once, name once). The operator fills these once; at submit each form pulls values back by dedupKey. */
export function dedupeSharedFields(forms: MatchedFormView[]): SharedFillField[] {
  const map = new Map<string, SharedFillField>();
  for (const f of forms) {
    for (const fld of f.fields) {
      const key = dedupKey(fld);
      if (!map.has(key)) {
        map.set(key, { key, role: fld.role, label: fld.label, type: fld.type, value: fld.value, ...(fld.options && fld.options.length ? { options: fld.options } : {}) });
      }
    }
  }
  return [...map.values()];
}
