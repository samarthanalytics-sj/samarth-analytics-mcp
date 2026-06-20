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
import { requestAllowed } from './ssrf';

const PROVIDER_SELECTORS = ['.hs-form', '[data-tf-widget]', '#mce-EMAIL', '#mc-embedded-subscribe', '.gform_wrapper', '.wpcf7', '.wpforms-form', '.wpforms-container'];
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

  const elements: RawElement[] = [];
  $('a[href]').slice(0, 400).each((_i, el) => {
    const $el = $(el);
    elements.push({ tag: 'a', href: abs($el.attr('href') || ''), text: txt($el), hasDownload: $el.attr('download') !== undefined, region: regionOf($el) });
  });
  $('button, [role="button"]:not(a)').slice(0, 400).each((_i, el) => {
    const $el = $(el);
    elements.push({ tag: 'button', href: '', text: txt($el), hasDownload: false, region: regionOf($el) });
  });

  const scriptSrcs: string[] = [];
  $('script[src]').slice(0, 200).each((_i, el) => {
    const s = $(el).attr('src');
    if (s) scriptSrcs.push(abs(s));
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
  const mkto = $('[id^="mktoForm_"]').first().attr('id');
  if (mkto) selectorsPresent.push('#' + mkto);

  const rawForms = extractFormsCheerio($, abs);
  return {
    raw: { elements, signals: { scriptSrcs: scriptSrcs.slice(0, 300), classNames: [...classNames].slice(0, 600), selectorsPresent } },
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
  return {
    tag,
    type,
    name: $el.attr('name') || '',
    id,
    label: label.slice(0, 160),
    placeholder: ($el.attr('placeholder') || '').slice(0, 160),
    autocomplete: $el.attr('autocomplete') || '',
    required: $el.attr('required') !== undefined,
  };
}

function fieldsIn($: CheerioAPI, root: Cheerio<AnyNode>): RawFormField[] {
  const fields: RawFormField[] = [];
  root.find('input, select, textarea').slice(0, 50).each((_i, el) => {
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
  // 1. Real <form> elements.
  $('form').slice(0, 25).each((_i, el) => {
    const form = $(el);
    const fields = fieldsIn($, form);
    out.push({
      index: out.length,
      action: abs(form.attr('action') || ''),
      method: (form.attr('method') || 'get').toLowerCase(),
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
      if (fieldsIn($, node).length >= 1) {
        host = node;
        break;
      }
    }
    if (!host || host.closest('form').length) return;
    const hostEl = host.get(0);
    if (!hostEl || seen.has(hostEl)) return; // same container reached via two buttons
    const fields = fieldsIn($, host);
    if (!fields.some((f) => TEXTISH.has(f.type))) return;
    seen.add(hostEl);
    out.push({
      index: out.length,
      action: '',
      method: 'js',
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

const UA = 'Mozilla/5.0 (compatible; SamarthTagSuggest/1.0; +read-only static scan)';

export function createCheerioDriver(opts: CheerioDriverOptions = {}): PageDriver {
  const navTimeoutMs = opts.navTimeoutMs ?? 15_000;
  return {
    async open(url: string): Promise<DrivenPage> {
      // SSRF: check each hop ourselves (manual redirects) so a public host can't
      // redirect the fetch at a private/loopback/metadata address.
      let current = url;
      try {
        for (let hop = 0; hop <= 5; hop++) {
          if (!(await requestAllowed(current))) return { ok: false, httpStatus: null, finalUrl: null, error: 'blocked by SSRF guard' };
          const res = await fetch(current, {
            redirect: 'manual',
            headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
            signal: AbortSignal.timeout(navTimeoutMs),
          });
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc) return { ok: true, httpStatus: res.status, finalUrl: current };
            current = new URL(loc, current).href;
            continue;
          }
          if (res.status >= 400) return { ok: true, httpStatus: res.status, finalUrl: current };
          const html = await res.text();
          const { raw, rawForms } = extractWithCheerio(html, current);
          return { ok: true, httpStatus: res.status, finalUrl: current, raw, rawForms };
        }
        return { ok: false, httpStatus: null, finalUrl: null, error: 'too many redirects' };
      } catch (e) {
        return { ok: false, httpStatus: null, finalUrl: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
      }
    },
    async close(): Promise<void> {
      /* nothing to tear down */
    },
  };
}
