// A NO-BROWSER scraping engine: fetch the raw HTML and parse it with Cheerio.
// Fast and light (no Chromium), and a good fallback for static / server-rendered
// pages. It mirrors the in-page DOM extractors (collectPageInBrowser /
// extractFormsInPage) — including the div/JS-form heuristic — but in Cheerio.
//
// LIMITATION (told to the user): Cheerio does NOT run JavaScript, so it only sees
// server-rendered HTML — JS-injected forms/widgets and iframe contents are
// invisible to it. For those, the Electron/Playwright engines are needed.

import { load, type CheerioAPI, type Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { PageScanRaw, RawElement } from '../../../../web-audit-mcp/src/agent/tag-suggest/collect.js';
import type { RawForm, RawFormField } from '../../../../web-audit-mcp/src/agent/forms.js';
import type { PageDriver, DrivenPage } from './scan-core';
import { safeFetch } from './ssrf';
// Shared with the browser collectors so the no-browser path detects the SAME vendors. Importing
// them (rather than keeping a third copy) is why this driver cannot drift from providers.ts.
import { PROVIDER_SELECTORS, PROVIDER_ID_PREFIXES } from '../../../../web-audit-mcp/src/agent/tag-suggest/providers.js';
const SUBMIT_RE = /\b(submit|send|subscribe|sign\s*up|sign\s*me\s*up|get\s+started|register|join\b|request\s+(a\s+)?(quote|demo|info|callback)|contact\s+us|book\s+(a\s+)?(demo|call|meeting)|get\s+(a\s+)?quote)\b/i;
const TEXTISH = new Set(['text', 'email', 'tel', 'url', 'search', 'password', 'number', 'textarea']);

/** Parse HTML → the same RawElement/RawForm shapes the DOM extractors produce.
 *  PURE (no network) so it is unit-tested with an HTML string. */
export function extractWithCheerio(html: string, baseUrl: string): { raw: PageScanRaw; rawForms: RawForm[] } {
  const $ = load(html);
  const abs = (href: string): string => {
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return href;
    }
  };
  const tagOf = (sel: Cheerio<AnyNode>): string => String(sel.prop('tagName') || '').toLowerCase();
  const txt = (sel: Cheerio<AnyNode>): string => sel.text().replace(/\s+/g, ' ').trim().slice(0, 120);
  const regionOf = (sel: Cheerio<AnyNode>): RawElement['region'] => {
    const t = tagOf(sel.closest('header,footer,nav,main'));
    return t === 'header' || t === 'footer' || t === 'nav' || t === 'main' ? t : '';
  };
  // A link that reads as a CTA by MARKUP alone: a btn/button/cta class token, role=button, or an
  // onclick. Cheerio has no layout, so unlike the in-page collector (which also uses getComputedStyle
  // to catch a class-less styled button) this server-HTML path can only go on the class/role signals.
  const looksCta = (sel: Cheerio<AnyNode>): boolean => {
    if (sel.attr('role') === 'button' || sel.attr('onclick') !== undefined) return true;
    return /(^|[\s_-])(btn|button|cta)([\s_-]|$)/.test((sel.attr('class') || '').toLowerCase());
  };

  const elements: RawElement[] = [];
  // class/id are carried through so the trigger-strategy ladder has the same signals here as in the
  // browser drivers; without them a no-JS scan could only ever key a trigger on link text.
  $('a[href]').slice(0, 400).each((_i, el) => {
    const $el = $(el);
    elements.push({
      tag: 'a', href: abs($el.attr('href') || ''), text: txt($el), hasDownload: $el.attr('download') !== undefined,
      region: regionOf($el), cta: looksCta($el),
      className: $el.attr('class') || undefined, elementId: $el.attr('id') || undefined,
      // Cloudflare Email Obfuscation: the ORIGIN serves the encoded form and CF's own script restores
      // the mailto in the browser. This path never runs that script, so without the payload a
      // no-JS scan finds zero emails on a page a browser scan reads normally.
      cfEmail: $el.attr('data-cfemail') || undefined,
    });
  });
  $('button, [role="button"]:not(a)').slice(0, 400).each((_i, el) => {
    const $el = $(el);
    elements.push({ tag: 'button', href: '', text: txt($el), hasDownload: false, region: regionOf($el), className: $el.attr('class') || undefined, elementId: $el.attr('id') || undefined });
  });
  // Non-link contact/location blocks. Mirrors the browser collector's CONTACT_SEL pass.
  const CONTACT_SEL = '[class*="address" i], [class*="location" i], [class*="phone" i], [class*="tel" i], [class*="email" i], [class*="hours" i], [class*="directions" i]';
  $(CONTACT_SEL).slice(0, 400).each((_i, el) => {
    const $el = $(el);
    if ($el.closest('a[href], button, [role="button"]').length) return;
    if ($el.find('a[href], button').length) return;
    const label = txt($el);
    if (!label || label.length > 200) return;
    elements.push({
      tag: 'button', href: '', text: label, hasDownload: false, region: regionOf($el), cta: false,
      className: $el.attr('class') || undefined, elementId: $el.attr('id') || undefined, nonLink: true,
    });
  });

  const scriptSrcs: string[] = [];
  $('script[src]').slice(0, 200).each((_i, el) => {
    const s = $(el).attr('src');
    if (s) scriptSrcs.push(abs(s));
  });
  const iframeSrcs: string[] = [];
  $('iframe[src]').slice(0, 50).each((_i, el) => {
    const s = $(el).attr('src');
    if (s) iframeSrcs.push(abs(s));
  });
  // Lazy iframes (data-src) + click-to-load YouTube facades (lite-youtube-embed,
  // the .youtube-player[data-id] pattern) — present in the server HTML even though
  // the real <iframe src> only appears after scroll/click.
  $('iframe[data-src], iframe[data-lazy-src]').slice(0, 50).each((_i, el) => {
    const s = $(el).attr('data-src') || $(el).attr('data-lazy-src');
    if (s) iframeSrcs.push(abs(s));
  });
  $('lite-youtube[videoid], .youtube-player[data-id], [data-youtube-id], [data-yt-id]').slice(0, 30).each((_i, el) => {
    const id = $(el).attr('videoid') || $(el).attr('data-id') || $(el).attr('data-youtube-id') || $(el).attr('data-yt-id') || '';
    if (/^[\w-]{6,15}$/.test(id)) iframeSrcs.push('https://www.youtube.com/embed/' + id);
  });
  const classNames = new Set<string>();
  $('[class]').slice(0, 1000).each((_i, el) => {
    const c = $(el).attr('class');
    if (c) for (const t of c.split(/\s+/)) if (t) classNames.add(t);
  });
  const selectorsPresent: string[] = [];
  for (const sel of PROVIDER_SELECTORS) {
    try {
      if ($(sel).length) selectorsPresent.push(sel);
    } catch {
      /* invalid selector */
    }
  }
  // The REAL id of any element whose id prefix names a provider: the shape identifies the vendor,
  // and the id carries that vendor's durable form number (gform_12, mktoForm_521, wpcf7-f34-p9-o1).
  for (const prefix of PROVIDER_ID_PREFIXES) {
    try {
      const id = $(`[id^="${prefix}"]`).first().attr('id');
      if (id) selectorsPresent.push('#' + id);
    } catch {
      /* invalid selector */
    }
  }

  const rawForms = extractFormsCheerio($, abs);
  // Visible-text sample for phone detection. Cheerio has no layout, so script/style bodies are
  // removed explicitly - innerText's job in the browser drivers. Same cap as the browser path.
  let textSample = '';
  try {
    const $body = $('body').clone();
    $body.find('script, style, noscript, template').remove();
    textSample = $body.text().replace(/\s+/g, ' ').trim().slice(0, 20000);
  } catch {
    /* no body / parse quirk - text-based detection simply finds nothing on this driver */
  }
  return {
    raw: {
      elements,
      ...(textSample ? { textSample } : {}),
      signals: { scriptSrcs: scriptSrcs.slice(0, 300), classNames: [...classNames].slice(0, 600), selectorsPresent, iframeSrcs: iframeSrcs.slice(0, 80) },
    },
    rawForms,
  };
}

function fieldOf($: CheerioAPI, el: AnyNode): RawFormField | null {
  const $el = $(el);
  const tag = String($el.prop('tagName') || '').toLowerCase();
  const type = ($el.attr('type') || tag).toLowerCase();
  if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) return null;
  const id = $el.attr('id') || '';
  let label = '';
  if (id && /^[\w-]+$/.test(id)) {
    const lab = $(`label[for="${id}"]`).first();
    if (lab.length) label = lab.text().trim();
  }
  if (!label) {
    const c = $el.closest('label');
    if (c.length) label = c.text().trim();
  }
  if (!label) label = $el.attr('aria-label') || '';
  const field: RawFormField = {
    tag,
    type,
    name: $el.attr('name') || '',
    id,
    label: label.slice(0, 160),
    placeholder: ($el.attr('placeholder') || '').slice(0, 160),
    autocomplete: $el.attr('autocomplete') || '',
    required: $el.attr('required') !== undefined,
  };
  if (tag === 'select') {
    const opts: string[] = [];
    $el.find('option').each((_i, o) => {
      const t = ($(o).text() || $(o).attr('value') || '').replace(/\s+/g, ' ').trim();
      if (t) opts.push(t);
    });
    if (opts.length) field.options = opts.slice(0, 40);
  }
  return field;
}

function fieldsIn($: CheerioAPI, root: Cheerio<AnyNode>): RawFormField[] {
  const fields: RawFormField[] = [];
  root.find('input, select, textarea').slice(0, 50).each((_i, el) => {
    const f = fieldOf($, el);
    if (f) fields.push(f);
  });
  return fields;
}

// Like fieldsIn, but EXCLUDING fields inside a real <form> descendant — those are already captured as
// native forms in step 1. Mirrors the in-page extractor's fieldsOutsideForm, so a wrapper containing a
// <form> plus an outside "Book a demo" button isn't re-detected as a second, phantom div-form.
function fieldsOutsideForm($: CheerioAPI, root: Cheerio<AnyNode>): RawFormField[] {
  const fields: RawFormField[] = [];
  root.find('input, select, textarea').each((_i, el) => {
    if (fields.length >= 50) return false;
    if ($(el).closest('form').length) return;
    const f = fieldOf($, el);
    if (f) fields.push(f);
  });
  return fields;
}

function privacyIn(root: Cheerio<AnyNode>): boolean {
  return root.find('a[href*="privacy"], a[href*="datenschutz"], a[href*="confidentialite"], a[href*="privacidad"], a[href*="cookie-policy"]').length > 0;
}

function extractFormsCheerio($: CheerioAPI, abs: (href: string) => string): RawForm[] {
  const out: RawForm[] = [];
  // The PROVIDER's own durable form id, mirroring forms.ts providerIdOf: the element itself, then
  // its provider wrapper, then a descendant. Vendors disagree on the attribute NAME (HubSpot
  // data-form-id, WPForms data-formid, Contact Form 7 data-wpcf7-id), so all three are read.
  const PROVIDER_ID_SEL = '[data-form-id],[data-formid],[data-wpcf7-id]';
  const readProviderId = ($n: Cheerio<AnyNode>): string => {
    if (!$n.length) return '';
    for (const a of ['data-form-id', 'data-formid', 'data-wpcf7-id']) {
      const v = ($n.first().attr(a) || '').trim();
      if (v) return v;
    }
    return '';
  };
  const providerIdOf = ($el: Cheerio<AnyNode>): string =>
    readProviderId($el.closest(PROVIDER_ID_SEL)) || readProviderId($el.find(PROVIDER_ID_SEL).first());
  // The form's visible heading/label (mirrors forms.ts titleOf): aria-label →
  // aria-labelledby → a legend/heading inside → the nearest heading in its card.
  const headingIn = ($root: Cheerio<AnyNode>): string => {
    const h = $root.find('legend, h1, h2, h3, h4, h5, h6').first();
    return h.length ? h.text().replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  };
  const titleOf = ($el: Cheerio<AnyNode>): string => {
    const al = ($el.attr('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (al) return al.slice(0, 60);
    const lb = $el.attr('aria-labelledby');
    if (lb) {
      const t = $(`[id="${lb}"]`).first();
      const s = t.length ? t.text().replace(/\s+/g, ' ').trim() : '';
      if (s) return s.slice(0, 60);
    }
    const inside = headingIn($el);
    if (inside) return inside;
    let $node = $el.parent();
    for (let i = 0; i < 3 && $node.length; i++, $node = $node.parent()) {
      const h = headingIn($node);
      if (h) return h;
    }
    return '';
  };
  // 1. Real <form> elements.
  $('form').slice(0, 25).each((_i, el) => {
    const form = $(el);
    const fields = fieldsIn($, form);
    out.push({
      index: out.length,
      action: abs(form.attr('action') || ''),
      method: (form.attr('method') || 'get').toLowerCase(),
      formId: form.attr('id') || '',
      providerFormId: providerIdOf(form),
      formName: form.attr('name') || '',
      formClasses: form.attr('class') || '',
      title: titleOf(form),
      fieldCount: fields.length,
      fields,
      hasPrivacyLink: privacyIn(form),
      text: form.text().toLowerCase().replace(/\s+/g, ' ').slice(0, 1500),
    });
  });
  // 2. div/JS "forms": a non-<form> container with input field(s) + a submit-like
  //    control. Anchored on the submit button; requires a real text-ish field.
  const seen = new Set<AnyNode>();
  $('button, [role="button"], input[type="submit"], input[type="button"]').each((_i, el) => {
    if (out.length >= 25) return;
    const btn = $(el);
    if (btn.closest('form').length) return;
    const label = (btn.text() + ' ' + (btn.attr('value') || '')).trim();
    if (!SUBMIT_RE.test(label)) return;
    let host: Cheerio<AnyNode> | null = null;
    let node = btn.parent();
    for (let i = 0; node.length && i < 6; i++, node = node.parent()) {
      if (String(node.prop('tagName') || '').toLowerCase() === 'form') break;
      if (fieldsOutsideForm($, node).length >= 1) {
        host = node;
        break;
      }
    }
    if (!host || host.closest('form').length) return;
    const hostEl = host.get(0);
    if (!hostEl || seen.has(hostEl)) return; // same container reached via two buttons
    const fields = fieldsOutsideForm($, host);
    if (!fields.some((f) => TEXTISH.has(f.type))) return;
    seen.add(hostEl);
    out.push({
      index: out.length,
      action: '',
      method: 'js',
      formId: host.attr('id') || '',
      providerFormId: providerIdOf(host),
      formName: '',
      formClasses: host.attr('class') || '',
      title: titleOf(host),
      fieldCount: fields.length,
      fields,
      hasPrivacyLink: privacyIn(host),
      text: (host.text() + ' ' + label).toLowerCase().replace(/\s+/g, ' ').slice(0, 1500),
    });
  });
  return out;
}

export interface CheerioDriverOptions {
  navTimeoutMs?: number;
}

export function createCheerioDriver(opts: CheerioDriverOptions = {}): PageDriver {
  const navTimeoutMs = opts.navTimeoutMs ?? 15_000;
  return {
    async open(url: string): Promise<DrivenPage> {
      try {
        const { status, finalUrl, body } = await safeFetch(url, navTimeoutMs);
        if (status >= 400 || !body) return { ok: true, httpStatus: status, finalUrl };
        const { raw, rawForms } = extractWithCheerio(body, finalUrl);
        return { ok: true, httpStatus: status, finalUrl, raw, rawForms };
      } catch (e) {
        return { ok: false, httpStatus: null, finalUrl: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
      }
    },
    async close(): Promise<void> {
      /* nothing to tear down */
    },
  };
}
