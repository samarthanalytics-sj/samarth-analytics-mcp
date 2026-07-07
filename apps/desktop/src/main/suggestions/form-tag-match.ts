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
  /** The tag's resolved form-name condition (customEventData), when present — the best match key. */
  formName?: string;
}

// Words that don't help tell one form from another (tag-name boilerplate + generic filler).
const STOP = new Set([
  'form', 'forms', 'tag', 'tags', 'the', 'ga4', 'event', 'events', 'get', 'your', 'a', 'an', 'to',
  'for', 'and', 'of', 'us', 'our', 'gtm', 'click', 'submit', 'submission', 'free', 'new',
]);

function tokens(s: string): Set<string> {
  const norm = (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return new Set(norm.split(' ').filter((t) => t.length > 2 && !STOP.has(t)));
}

/** The tag's identity text: its resolved form_name if we have it, else the tag name with the GA4
 *  boilerplate ("GA4 - Event - … Form Tag") stripped by the STOP set. */
function tagIdentity(tag: FormTagIdentity): Set<string> {
  const t = tokens(tag.formName && tag.formName.trim() ? tag.formName : tag.tagName);
  // The tag's own event name often carries the form identity too (get_in_touch_form).
  for (const e of tokens(tag.eventName)) t.add(e);
  return t;
}

/** The form's identity text: its visible title, then formName/id/classes. */
function formIdentity(form: FormFillView): Set<string> {
  const t = tokens(form.title);
  for (const e of tokens(form.formId)) t.add(e);
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
  for (const tag of tags) {
    const tt = tagIdentity(tag);
    let bestIdx = -1;
    let bestScore = 0;
    forms.forEach((_f, i) => {
      const sc = shared(tt, formTok[i]);
      if (sc > bestScore) { bestScore = sc; bestIdx = i; }
    });
    if (bestIdx >= 0 && bestScore >= 1) {
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
      if (!mv.expectedTags.some((x) => x.tagName === tag.tagName)) mv.expectedTags.push({ tagName: tag.tagName, eventName: tag.eventName });
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
