// Pure tests for the desktop tag-suggestion layer (no Electron, no browser):
//   • crawlAndSuggest() driven by a FAKE PageDriver — BFS, classification,
//     EM-overlap flagging, notScanned labeling, depth/budget, driver cleanup.
//   • parseSuggestions() — the paste path across every input shape.
//   • createSuggestedTags() — the approved-create loop (outcome mapping).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/suggestion-service.test.ts

import { crawlAndSuggest, type PageDriver, type DrivenPage } from '../scan-core';
import { parseSuggestions, suggestionsFromData, createSuggestedTags } from '../suggestion-service';
import type { PageScanRaw, RawElement } from '../../../../../web-audit-mcp/src/agent/tag-suggest/collect.js';
import type { RawForm } from '../../../../../web-audit-mcp/src/agent/forms.js';
import type { SuggestedTagView } from '../../../shared/ipc';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const a = (href: string, over: Partial<RawElement> = {}): RawElement => ({
  tag: 'a',
  href,
  text: '',
  hasDownload: false,
  region: '',
  ...over,
});
const button = (text: string): RawElement => ({ tag: 'button', href: '', text, hasDownload: false, region: '' });
const raw = (elements: RawElement[]): PageScanRaw => ({
  elements,
  signals: { scriptSrcs: [], classNames: [], selectorsPresent: [] },
});
const contactForm: RawForm = {
  index: 0,
  action: 'https://acme.com/submit',
  method: 'post',
  fieldCount: 2,
  fields: [
    { tag: 'input', type: 'email', name: 'email', id: '', label: 'Email', placeholder: '', autocomplete: 'email', required: true },
    { tag: 'textarea', type: 'textarea', name: 'message', id: '', label: 'Message', placeholder: '', autocomplete: '', required: false },
  ],
  hasPrivacyLink: false,
  text: 'contact us',
};

function fakeDriver(pages: Record<string, DrivenPage>): { driver: PageDriver; closes: () => number; opened: () => string[] } {
  let closeCount = 0;
  const openedUrls: string[] = [];
  const norm = (u: string): string => u.replace(/\/$/, '');
  return {
    driver: {
      async open(url) {
        openedUrls.push(url);
        return pages[url] ?? pages[norm(url)] ?? { ok: false, httpStatus: null, finalUrl: null, error: 'not found' };
      },
      async close() {
        closeCount += 1;
      },
    },
    closes: () => closeCount,
    opened: () => openedUrls,
  };
}

const oneTag = {
  id: 'x',
  page: '/contact',
  label: 'Contact form → GA4 generate_lead',
  evidence: 'form',
  confidence: 'high',
  enhancedMeasurementOverlap: false,
  platform: 'ga4_event',
  tagName: 'GA4 - generate_lead',
  measurementId: '{{GA4 Measurement ID}}',
  eventName: 'generate_lead',
  trigger: { name: 'Form submit - contact', kind: 'form_submit' },
};

// The desktop package is CommonJS, so top-level await is unavailable — run the
// awaited checks inside an async IIFE.
async function main(): Promise<void> {
  // ── crawlAndSuggest: two-page site, full classification ────────────────────
  {
    const home: DrivenPage = {
      ok: true,
      httpStatus: 200,
      finalUrl: 'https://acme.com/',
      raw: raw([
        a('https://acme.com/contact', { text: 'Contact' }), // internal nav → BFS link
        a('mailto:hi@acme.com', { text: 'Email us', region: 'footer' }), // email_click
        a('https://partner.com/x', { text: 'Partner' }), // outbound (EM overlap)
        a('https://acme.com/guide.pdf', { text: 'Guide' }), // file_download (EM overlap)
        button('Book a demo'), // cta_click
      ]),
      rawForms: [],
    };
    const contact: DrivenPage = {
      ok: true,
      httpStatus: 200,
      finalUrl: 'https://acme.com/contact',
      raw: raw([a('https://acme.com/', { text: 'Home' }), a('tel:+15551234567', { text: 'Call', region: 'header' })]),
      rawForms: [contactForm],
    };
    const fd = fakeDriver({ 'https://acme.com/': home, 'https://acme.com/contact': contact });
    const res = await crawlAndSuggest(fd.driver, 'https://acme.com/', { maxPages: 10, maxDepth: 2 });

    const events = new Set(res.suggestions.map((s) => s.eventName));
    check('crawl: visits entry + linked contact page', res.summary.pagesScanned === 2 && fd.opened().length === 2);
    check('crawl: contact form → generate_lead', events.has('generate_lead'));
    check('crawl: mailto → email_click, tel → phone_click', events.has('email_click') && events.has('phone_click'));
    check('crawl: download + outbound + cta detected', events.has('file_download') && events.has('outbound_click') && events.has('cta_click'));
    check('crawl: six unique suggestions', res.summary.suggestions === 6, `${res.summary.suggestions}`);
    check('crawl: EM overlap = 2 (download + outbound)', res.summary.enhancedMeasurementOverlap === 2, `${res.summary.enhancedMeasurementOverlap}`);
    check(
      'crawl: byConfidence high=3 medium=2 low=1',
      res.summary.byConfidence.high === 3 && res.summary.byConfidence.medium === 2 && res.summary.byConfidence.low === 1,
      JSON.stringify(res.summary.byConfidence),
    );
    check('crawl: newTracking = suggestions − EM overlap', res.summary.newTracking === res.summary.suggestions - res.summary.enhancedMeasurementOverlap);
    check('crawl: every suggestion is a ga4_event payload', res.suggestions.every((s) => s.platform === 'ga4_event' && !!s.tagName && !!s.trigger.kind));
    check('crawl: siteHost derived from start', res.siteHost === 'acme.com');
    check('crawl: driver.close() called exactly once', fd.closes() === 1, `${fd.closes()}`);
  }

  // ── maxDepth clamps to a minimum of 1, so a linked page is still reached ────
  {
    const home: DrivenPage = {
      ok: true,
      httpStatus: 200,
      finalUrl: 'https://acme.com/',
      raw: raw([a('https://acme.com/contact', { text: 'Contact' }), a('mailto:hi@acme.com')]),
      rawForms: [],
    };
    const fd = fakeDriver({
      'https://acme.com/': home,
      'https://acme.com/contact': { ok: true, httpStatus: 200, finalUrl: 'x', raw: raw([]), rawForms: [contactForm] },
    });
    const res = await crawlAndSuggest(fd.driver, 'https://acme.com/', { maxDepth: 1, maxPages: 10 });
    check('depth: reaches the depth-1 linked page', res.summary.pagesScanned === 2);
  }

  // ── notScanned labeling: HTTP error + nav failure ──────────────────────────
  {
    const home: DrivenPage = {
      ok: true,
      httpStatus: 200,
      finalUrl: 'https://acme.com/',
      raw: raw([a('https://acme.com/gone', { text: 'Gone' }), a('https://acme.com/broken', { text: 'Broken' })]),
      rawForms: [],
    };
    const fd = fakeDriver({
      'https://acme.com/': home,
      'https://acme.com/gone': { ok: true, httpStatus: 404, finalUrl: 'x' },
      'https://acme.com/broken': { ok: false, httpStatus: null, finalUrl: null, error: 'timeout' },
    });
    const res = await crawlAndSuggest(fd.driver, 'https://acme.com/', {});
    const reason = (u: string): string | undefined => res.notScanned.find((n) => n.url.replace(/\/$/, '') === u)?.reason;
    check('notScanned: HTTP 404 labeled "http 404"', reason('https://acme.com/gone') === 'http 404', JSON.stringify(res.notScanned));
    check('notScanned: nav failure labeled "scan failed: …"', (reason('https://acme.com/broken') ?? '').startsWith('scan failed: timeout'));
  }

  // ── bad start URL → empty result, no throw ─────────────────────────────────
  {
    const fd = fakeDriver({});
    const res = await crawlAndSuggest(fd.driver, 'not a url', {});
    check('bad start URL → empty result + warning + driver closed', res.suggestions.length === 0 && res.warnings.length > 0 && fd.closes() === 1);
  }

  // ── parseSuggestions: the four accepted shapes + junk ──────────────────────
  check('paste: full report ({suggestions:[…]}) passes through', parseSuggestions(JSON.stringify({ suggestions: [oneTag] })).suggestions.length === 1);
  check('paste: bare SuggestedTag[] passes through', parseSuggestions(JSON.stringify([oneTag])).suggestions[0].eventName === 'generate_lead');
  check(
    'paste: SuggestInput ({siteHost,forms,elements}) → engine builds generate_lead',
    parseSuggestions(
      JSON.stringify({
        siteHost: 'acme.com',
        forms: [{ page: '/contact', purpose: 'contact', action: 'https://acme.com/x', provider: { vendor: 'unknown', confidence: 'low', evidence: '' } }],
        elements: [],
      }),
    ).suggestions.some((s) => s.eventName === 'generate_lead'),
  );
  check(
    'paste: PageScan[] → engine builds suggestions',
    parseSuggestions(
      JSON.stringify([
        { page: '/contact', signals: { scriptSrcs: [], classNames: [], selectorsPresent: [] }, forms: [{ purpose: 'contact', action: 'https://acme.com/x' }], elements: [] },
      ]),
    ).suggestions.some((s) => s.eventName === 'generate_lead'),
  );
  check('paste: report drops non-GA4 items with a warning', (() => {
    const r = suggestionsFromData({ suggestions: [oneTag, { foo: 'bar' }] });
    return r.suggestions.length === 1 && r.warnings.length === 1;
  })());
  check('paste: invalid JSON throws', (() => { try { parseSuggestions('not json'); return false; } catch { return true; } })());
  check('paste: unrecognized JSON shape throws', (() => { try { parseSuggestions('{"hello":1}'); return false; } catch { return true; } })());
  check('paste: empty string throws', (() => { try { parseSuggestions('   '); return false; } catch { return true; } })());

  // ── createSuggestedTags: outcome mapping, sequential, fail-isolation ───────
  {
    const calls: Array<Record<string, unknown>> = [];
    const execute = async (_name: string, args: Record<string, unknown>): Promise<string> => {
      calls.push(args);
      const tn = String(args.tagName);
      if (tn === 'BOOM') throw new Error('api 400');
      if (tn === 'NOPE') return JSON.stringify({ declined: true });
      return JSON.stringify({ tag: { name: tn }, trigger: { reused: tn === 'REUSE' } });
    };
    const tag = (id: string, tagName: string): SuggestedTagView => ({
      id, page: '/', label: '', evidence: '', confidence: 'high', enhancedMeasurementOverlap: false,
      platform: 'ga4_event', tagName, measurementId: '{{GA4 Measurement ID}}', eventName: 'e', trigger: { name: 't', kind: 'all_clicks' },
    });
    const outcomes = await createSuggestedTags(execute, { accountId: '1', containerId: '2', workspaceId: '3' }, [
      tag('a', 'OK'), tag('b', 'BOOM'), tag('c', 'REUSE'), tag('d', 'NOPE'),
    ]);
    check('create: one outcome per tag, in order', outcomes.length === 4 && outcomes.map((o) => o.id).join('') === 'abcd');
    check('create: ok tag → ok:true with name', outcomes[0].ok && outcomes[0].tagName === 'OK');
    check('create: a thrown error is isolated, later tags still run', !outcomes[1].ok && (outcomes[1].error ?? '').includes('api 400') && outcomes[2].ok === true);
    check('create: reused trigger surfaced', outcomes[2].triggerReused === true);
    check('create: declined → ok:false error "declined"', !outcomes[3].ok && outcomes[3].error === 'declined');
    check('create: workspace ids passed to every call', calls.every((c) => c.accountId === '1' && c.containerId === '2' && c.workspaceId === '3') && calls.length === 4);
  }

  console.log(`\nsuggestion-service: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}

void main();
