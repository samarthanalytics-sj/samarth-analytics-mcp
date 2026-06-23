// EXPERIMENTAL single-page "AI scan": screenshot the page, let an OpenAI vision
// model read it + pick the GA4 tags worth creating, and map each pick back onto the
// REAL scraped element/form so the resulting tag has a precise, creatable trigger.
// The screenshot is sent to OpenAI (the user's own key) — outbound, opt-in only.
//
// Split so the pure part (aiTagsToSuggestions: AI picks + scraped inventory →
// SuggestedTag[]) is unit-tested without any network or browser.

import type { SuggestedTag } from '../../../../web-audit-mcp/src/agent/tag-suggest/types.js';
import type { RawElement } from '../../../../web-audit-mcp/src/agent/tag-suggest/collect.js';
import type { RawForm } from '../../../../web-audit-mcp/src/agent/forms.js';
import type { TagScanResult } from '../../shared/ipc';
import { pageScanFromDriven, assembleResult, emptyResult, type PageDriver, type DrivenPage } from './scan-core';

const GA4_VAR = '{{GA4 Measurement ID}}';
const PAGE_PARAMS = [
  { name: 'page_path', value: '{{Page Path}}' },
  { name: 'page_referrer', value: '{{Referrer}}' },
];
// GTM rejects ":" and a few chars in resource names — strip them (mirrors the engine).
const clean = (s: string): string => (s || '').replace(/[<>:]/g, ' ').replace(/\s{2,}/g, ' ').trim();
function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** One tag the vision model picked. It references a scraped element/form by index
 *  (so the tag gets a REAL trigger condition), or stands alone (pageview/custom). */
export interface AiTagPick {
  name: string;
  event: string;
  kind: 'form' | 'click' | 'link' | 'pageview';
  elementIndex?: number;
  formIndex?: number;
  why?: string;
}

/** Map the AI's picks onto the scraped inventory → creatable SuggestedTag[]. PURE. A
 *  pick with a bad/missing reference (e.g. a form pick with no matching form) is
 *  dropped rather than producing a tag with no trigger. */
export function aiTagsToSuggestions(picks: AiTagPick[], page: string, elements: RawElement[], forms: RawForm[]): SuggestedTag[] {
  const out: SuggestedTag[] = [];
  for (const p of picks) {
    const name = clean(String(p?.name ?? '')).slice(0, 80);
    const event = clean(String(p?.event ?? '')).replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 40);
    if (!name || !event) continue;
    const tagName = clean(name.startsWith('GA4') ? name : `GA4 Event - ${name}`);
    const base = {
      id: hashId(`ai|${page}|${p.kind}|${name}|${p.elementIndex ?? p.formIndex ?? ''}`),
      page,
      confidence: 'medium' as const,
      enhancedMeasurementOverlap: false,
      platform: 'ga4_event' as const,
      tagName,
      measurementId: GA4_VAR,
      eventName: event,
      note: '🤖 AI-suggested from the page screenshot — review its trigger before creating.',
      evidence: clean(String(p?.why ?? '')).slice(0, 200) || 'picked by the vision model from the page screenshot',
      label: `🤖 ${name} → GA4 "${event}"`,
    };
    if (p.kind === 'form') {
      const f = forms[p.formIndex ?? -1];
      if (!f) continue;
      out.push({
        ...base,
        eventParameters: [{ name: 'form_id', value: '{{Form ID}}' }, { name: 'form_url', value: '{{Form URL}}' }, ...PAGE_PARAMS],
        trigger: {
          name: clean(`${name} Trigger`),
          kind: 'form_submit',
          ...(f.formId ? { formIdValue: f.formId, formIdOperator: 'equals' as const } : {}),
        },
      });
    } else if (p.kind === 'link' || p.kind === 'click') {
      const el = elements[p.elementIndex ?? -1];
      if (!el) continue;
      const useUrl = p.kind === 'link' && !!el.href;
      out.push({
        ...base,
        eventParameters: [{ name: 'cta_text', value: '{{Click Text}}' }, { name: 'click_url', value: '{{Click URL}}' }, ...PAGE_PARAMS],
        trigger: useUrl
          ? { name: clean(`${name} Trigger`), kind: 'link_click', clickUrlValue: el.href, clickUrlOperator: 'contains' as const }
          : { name: clean(`${name} Trigger`), kind: 'all_clicks', clickTextValue: el.text.slice(0, 60), clickTextOperator: 'contains' as const },
      });
    } else if (p.kind === 'pageview') {
      out.push({ ...base, eventParameters: PAGE_PARAMS, trigger: { name: clean(`${name} Trigger`), kind: 'pageview' } });
    }
  }
  return out;
}

/** Compact, indexed inventory text the vision model picks from. */
function buildInventory(elements: RawElement[], forms: RawForm[]): string {
  const els = elements
    .filter((e) => (e.text || e.href))
    .slice(0, 60)
    .map((e, i) => `  [E${i}] ${e.tag} "${(e.text || '').slice(0, 60)}"${e.href ? ` → ${e.href.slice(0, 100)}` : ''}`)
    .join('\n');
  const frms = forms
    .slice(0, 15)
    .map((f, i) => `  [F${i}] id="${f.formId}" action="${(f.action || '').slice(0, 80)}" fields: ${f.fields.map((x) => x.name).filter(Boolean).slice(0, 8).join(', ')}`)
    .join('\n');
  return `ELEMENTS (clickable links/buttons):\n${els || '  (none)'}\n\nFORMS:\n${frms || '  (none)'}`;
}

const SYSTEM_PROMPT =
  'You are a Google Tag Manager / GA4 measurement analyst. Given a screenshot of a web page and a list of the page\'s real clickable ELEMENTS and FORMS (each with an index like [E3] or [F1]), decide which GA4 event tags are worth creating to measure user intent on this page (form submissions, key CTA/button clicks, important outbound/download links, video, etc.). ' +
  'Return STRICT JSON: {"tags":[{"name":"<short human tag name>","event":"<snake_case GA4 event name>","kind":"form|click|link|pageview","formIndex":<n for kind form>,"elementIndex":<n for kind click/link>,"why":"<one short reason>"}]}. ' +
  'Reference a REAL element/form index for every form/click/link tag (so the tag can be wired to it). Prefer 4-12 high-value tags. Do NOT invent indices that are not in the list. Skip generic nav links.';

interface VisionDeps {
  fetchImpl?: typeof fetch;
}

/** Ask OpenAI vision which tags to create. Returns [] on any error/parse failure. */
export async function openaiVisionSuggest(
  apiKey: string,
  model: string,
  pngBase64: string,
  inventory: string,
  deps: VisionDeps = {},
): Promise<AiTagPick[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Here is the page inventory:\n\n${inventory}\n\nReturn the tags JSON.` },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBase64}`, detail: 'auto' } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    let msg = `OpenAI HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      if (j?.error?.message) msg = j.error.message;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? '';
  let parsed: { tags?: unknown };
  try {
    parsed = JSON.parse(content) as { tags?: unknown };
  } catch {
    return [];
  }
  return Array.isArray(parsed.tags) ? (parsed.tags as AiTagPick[]) : [];
}

export interface AiScanInput {
  url: string;
  apiKey: string;
  model: string;
  driver: PageDriver;
  siteHostHint?: string;
}

/** Open ONE page, screenshot it, run the vision model, and merge its picks (wired to
 *  the real scraped elements/forms) with the normal scraped suggestions. */
export async function aiScanPage(input: AiScanInput): Promise<TagScanResult> {
  const { url, apiKey, model, driver } = input;
  let siteHost = input.siteHostHint ?? '';
  try {
    siteHost = siteHost || new URL(url).hostname;
  } catch {
    /* validated upstream */
  }
  const warnings: string[] = [];
  let driven: DrivenPage;
  let pngBase64: string | null = null;
  try {
    driven = await driver.open(url);
    if (driver.screenshot) {
      const buf = await driver.screenshot();
      pngBase64 = buf ? buf.toString('base64') : null;
    }
  } finally {
    await driver.close();
  }

  const pageScan = pageScanFromDriven(driven, url, siteHost);
  if (!pageScan) {
    return emptyResult(url, siteHost, [driven.error ? `Could not read the page: ${driven.error}` : 'Could not read the page.']);
  }

  let aiSuggestions: SuggestedTag[] = [];
  if (!pngBase64) {
    warnings.push('Could not capture a screenshot — showing the scraped suggestions only.');
  } else {
    try {
      const elements = driven.raw?.elements ?? [];
      const forms = driven.rawForms ?? [];
      const picks = await openaiVisionSuggest(apiKey, model, pngBase64, buildInventory(elements, forms));
      aiSuggestions = aiTagsToSuggestions(picks, pageScan.page, elements, forms);
      if (!aiSuggestions.length) warnings.push('The AI returned no usable tags — showing the scraped suggestions.');
    } catch (e) {
      warnings.push(`AI analysis failed: ${e instanceof Error ? e.message : String(e)}. Showing the scraped suggestions only.`);
    }
  }

  return assembleResult(url, siteHost, [pageScan], [], warnings, 1, aiSuggestions);
}
