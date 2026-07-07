// PURE bridge (no browser): raw forms extracted from a page → per-form FILL PLANS for the
// real-submit review UI. Reuses the shared field classifier + locale profiles (form-fill.ts) and the
// form purpose classifier (forms.ts). Fills/submits NOTHING — it only proposes editable values.

import type { RawForm, RawFormField } from '../../../../web-audit-mcp/src/agent/forms.js';
import { analyzeForms } from '../../../../web-audit-mcp/src/agent/forms.js';
import { buildFillPlan, localeById, LOCALES } from '../../../../web-audit-mcp/src/agent/form-fill.js';
import type { FormFillView } from '../../shared/ipc';

/** A field worth showing/filling: it has a name or id to target and isn't a control/hidden field. */
function fillable(f: RawFormField): boolean {
  return Boolean(f.name || f.id) && !['hidden', 'submit', 'button', 'image', 'reset'].includes(f.type);
}

/** The supported locations for the picker (US now; UK/AUS/etc. registered in LOCALES later). */
export function localeOptions(): Array<{ id: string; label: string }> {
  return Object.values(LOCALES).map((l) => ({ id: l.id, label: l.label }));
}

/** Pair the GA4 events observed on a REAL submit to the container's tags (by event name), so the
 *  operator sees WHICH actual container tags fired — a genuine FIRED, not a synthetic push. PURE. */
export function matchFiredContainerTags(
  events: string[],
  tags: Array<{ tagName: string; eventName: string }>,
): Array<{ tagName: string; eventName: string }> {
  const seen = new Set(events.map((e) => (e ?? '').trim().toLowerCase()).filter(Boolean));
  const out: Array<{ tagName: string; eventName: string }> = [];
  const pushed = new Set<string>();
  for (const t of tags) {
    const en = (t.eventName ?? '').trim().toLowerCase();
    if (en && seen.has(en) && !pushed.has(t.tagName)) {
      out.push({ tagName: t.tagName, eventName: t.eventName });
      pushed.add(t.tagName);
    }
  }
  return out;
}

/** Convert raw forms (from driver.open) into per-form fill plans. `emailTag` makes the test email
 *  traceable + unique per run. PURE (deterministic given its inputs). */
export function toFormFillViews(
  rawForms: RawForm[],
  pageUrl: string,
  localeId: string | undefined,
  emailTag: string,
): FormFillView[] {
  const locale = localeById(localeId);
  const purposeByIndex = new Map(analyzeForms(rawForms, pageUrl).map((a) => [a.index, a.purpose]));
  return rawForms
    .filter((f) => (f.fields ?? []).some(fillable))
    .map((f) => ({
      index: f.index,
      title: (f.title || f.formName || f.formId || `Form ${f.index + 1}`).slice(0, 80),
      formId: f.formId,
      formClasses: f.formClasses,
      action: f.action,
      method: f.method,
      purpose: purposeByIndex.get(f.index) ?? 'other',
      hidden: f.hidden === true,
      fields: buildFillPlan(f.fields.filter(fillable), locale, { emailTag }),
    }));
}
