// Pure tests for the desktop tag-suggestion layer (no Electron, no browser):
//   • crawlAndSuggest() driven by a FAKE PageDriver — BFS, classification,
//     EM-overlap flagging, notScanned labeling, depth/budget, driver cleanup.
//   • parseSuggestions() — the paste path across every input shape.
//   • createSuggestedTags() — the approved-create loop (outcome mapping).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/suggestion-service.test.ts

import { crawlAndSuggest, scanUrls, assembleResult, dedupSuggestions, detectInstalled, type PageDriver, type DrivenPage, type ScanProgress } from '../scan-core';
import type { SuggestedTag } from '../../../../../web-audit-mcp/src/agent/tag-suggest/types.js';
import { mergeDriven } from '../multi-driver';
import { parseSitemapLocs, extractCrawlLinks } from '../discover';
import { parseSuggestions, suggestionsFromData, createSuggestedTags, planGoogleTagVars, provisionVariables } from '../suggestion-service';
import type { ContainerSnapshot } from '../../google/gtm-builders';
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
  formId: 'contact-form',
  formName: 'contact',
  formClasses: 'contact-form needs-validation',
  title: 'Get a Free Consultation',
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
        button('Book a demo'), // book_demo_click (specific CTA intent → medium)
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
    check('crawl: titled contact form → event derived from its title (matches the tag name)', events.has('get_a_free_consultation_form'));
    check('crawl: mailto → email_click, tel → phone_click', events.has('email_click') && events.has('phone_click'));
    check('crawl: download + outbound + named CTA detected', events.has('file_download') && events.has('outbound_click') && events.has('book_a_demo_click'));
    // full mode (scan path): the 6 scan-derived tags (incl. the per-file "PDF Download" tag) +
    // GA4 Configuration = 7. There is no form catch-all anymore. PDF needs no separate catch-all —
    // the "PDF Download" tag's {{Click URL}} contains .pdf already fires site-wide.
    check('crawl: full list = 6 scan tags + GA4 Configuration = 7', res.summary.suggestions === 7, `${res.summary.suggestions}`);
    check('crawl: GA4 Configuration (google_tag) is included', res.suggestions.some((s) => s.platform === 'google_tag' && s.tagName === 'GA4 Configuration'));
    check('crawl: per-file "PDF Download" tag included; NO All-Form and NO All-PDF catch-all', res.suggestions.some((s) => s.tagName === 'GA4 - Event - PDF Download Click Tag') && !res.suggestions.some((s) => s.tagName === 'GA4 - Event - All Form Submissions Tag') && !res.suggestions.some((s) => s.tagName === 'GA4 - Event - All PDF Downloads'));
    check('crawl: EM overlap = 2 (PDF download + outbound)', res.summary.enhancedMeasurementOverlap === 2, `${res.summary.enhancedMeasurementOverlap}`);
    check(
      'crawl: byConfidence high=4 medium=3 low=0 (form catch-all removed)',
      res.summary.byConfidence.high === 4 && res.summary.byConfidence.medium === 3 && res.summary.byConfidence.low === 0,
      JSON.stringify(res.summary.byConfidence),
    );
    check('crawl: newTracking = suggestions − EM overlap', res.summary.newTracking === res.summary.suggestions - res.summary.enhancedMeasurementOverlap);
    check('crawl: every suggestion is a ga4_event or google_tag payload', res.suggestions.every((s) => (s.platform === 'ga4_event' || s.platform === 'google_tag') && !!s.tagName && !!s.trigger.kind));
    check('crawl: siteHost derived from start', res.siteHost === 'acme.com');
    check('crawl: driver.close() called exactly once', fd.closes() === 1, `${fd.closes()}`);
    check('crawl: inventory lists ALL detected elements (5) + forms (1), pre-dedup', res.inventory.elements.length === 5 && res.inventory.forms.length === 1,
      `${res.inventory.elements.length} els, ${res.inventory.forms.length} forms`);
    check('crawl: inventory element carries page/kind/text/href', res.inventory.elements.every((e) => typeof e.page === 'string' && typeof e.kind === 'string'));

    // Part 3 — onProgress streams the RUNNING list after each page.
    const fd2 = fakeDriver({ 'https://acme.com/': home, 'https://acme.com/contact': contact });
    const progressEvents: ScanProgress[] = [];
    const res2 = await crawlAndSuggest(fd2.driver, 'https://acme.com/', { maxPages: 10, maxDepth: 2 }, (p) => progressEvents.push(p));
    check('stream: onProgress fired once per scanned page', progressEvents.length === res2.summary.pagesScanned && progressEvents.length === 2);
    check('stream: each event carries the RUNNING suggestion list; the last equals the final list', progressEvents[progressEvents.length - 1].suggestions.length === res2.summary.suggestions);
    check('stream: the list GROWS across pages (page 1 ≤ page 2)', progressEvents[0].suggestions.length <= progressEvents[1].suggestions.length);
    check('stream: GA4 Configuration is present from the very first event', progressEvents[0].suggestions.some((s) => s.platform === 'google_tag'));
    check('stream: progress carries scanned/opened counters', progressEvents[0].scanned === 1 && progressEvents[1].scanned === 2);

    // Meta platform: platforms:['ga4','meta'] yields BOTH GA4 and Meta pixel tags; each Meta tag reuses
    // its GA4 source's trigger name (shared trigger on create). Default (no platforms) stays GA4-only.
    const fdM = fakeDriver({ 'https://acme.com/': home, 'https://acme.com/contact': contact });
    const resM = await crawlAndSuggest(fdM.driver, 'https://acme.com/', { maxPages: 10, maxDepth: 2, platforms: ['ga4', 'meta'] });
    check('meta: both platforms → GA4 + meta_pixel suggestions present', resM.suggestions.some((s) => s.platform === 'ga4_event') && resM.suggestions.some((s) => s.platform === 'meta_pixel'));
    check('meta: the Meta base pixel (PageView) + a Lead pixel are emitted', resM.suggestions.some((s) => s.platform === 'meta_pixel' && s.eventName === 'PageView') && resM.suggestions.some((s) => s.platform === 'meta_pixel' && s.eventName === 'Lead'));
    // Each meta tag's trigger name is shared with a GA4 tag's trigger name.
    const gaTrigNames = new Set(resM.suggestions.filter((s) => s.platform !== 'meta_pixel').map((s) => s.trigger.name));
    check('meta: every Meta tag reuses a GA4 trigger name (shared trigger on create)', resM.suggestions.filter((s) => s.platform === 'meta_pixel').every((s) => gaTrigNames.has(s.trigger.name)));
    const resGa4Only = await crawlAndSuggest(fakeDriver({ 'https://acme.com/': home, 'https://acme.com/contact': contact }).driver, 'https://acme.com/', { maxPages: 10, maxDepth: 2 });
    check('meta: default (no platforms) is unchanged — no meta_pixel suggestions', !resGa4Only.suggestions.some((s) => s.platform === 'meta_pixel'));
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

  // ── mergeDriven: union of engines, dedup doubles, keep uniques ─────────────
  {
    const mk = (els: RawElement[], forms: RawForm[]): DrivenPage => ({ ok: true, httpStatus: 200, finalUrl: 'x', raw: raw(els), rawForms: forms });
    const merged = mergeDriven([
      mk([a('mailto:hi@acme.com'), a('https://partner.com/x')], [contactForm]),
      mk([a('mailto:hi@acme.com'), a('https://acme.com/guide.pdf')], [contactForm]), // mailto + form are doubles
    ]);
    check('multi: doubled element kept once, uniques kept → 3 total', merged.raw?.elements.length === 3, `${merged.raw?.elements.length}`);
    check('multi: doubled form kept once', merged.rawForms?.length === 1);
    check('multi: merged is ok with the content engine status', merged.ok && merged.httpStatus === 200);
  }
  {
    const merged = mergeDriven([
      { ok: false, httpStatus: null, finalUrl: null, error: 'timeout' },
      { ok: true, httpStatus: 200, finalUrl: 'y', raw: raw([a('tel:+15551234567')]), rawForms: [] },
    ]);
    check('multi: one engine fails, the other still contributes', merged.ok && merged.raw?.elements.length === 1);
  }
  check('multi: all engines fail → not ok', mergeDriven([{ ok: false, httpStatus: null, finalUrl: null, error: 'a' }]).ok === false);

  // ── discovery parsers (pure) ───────────────────────────────────────────────
  {
    const sm = parseSitemapLocs('<?xml version="1.0"?><urlset><url><loc>https://acme.com/</loc></url><url><loc>https://acme.com/contact</loc></url></urlset>');
    check('sitemap: parses <loc> entries (not an index)', sm.locs.length === 2 && !sm.isIndex && sm.locs.includes('https://acme.com/contact'));
    const idx = parseSitemapLocs('<sitemapindex><sitemap><loc>https://acme.com/sitemap1.xml</loc></sitemap></sitemapindex>');
    check('sitemap: detects a sitemapindex', idx.isIndex && idx.locs[0] === 'https://acme.com/sitemap1.xml');
    const links = extractCrawlLinks(
      '<a href="/contact">C</a><a href="https://acme.com/pricing">P</a><a href="https://other.com/x">O</a><a href="mailto:x@a.com">M</a>',
      'https://acme.com/',
      'https://acme.com/',
    );
    check('crawl-links: same-site only, absolute, no mailto/offsite',
      links.includes('https://acme.com/contact') && links.includes('https://acme.com/pricing') &&
      !links.some((l) => l.includes('other.com')) && !links.some((l) => l.startsWith('mailto')));
  }

  // ── scanUrls: deep-scan a chosen list (no BFS) ─────────────────────────────
  {
    const fd = fakeDriver({
      'https://acme.com/contact': { ok: true, httpStatus: 200, finalUrl: 'x', raw: raw([a('mailto:hi@acme.com')]), rawForms: [contactForm] },
      'https://acme.com/pricing': { ok: true, httpStatus: 200, finalUrl: 'x', raw: raw([a('tel:+15551234567')]), rawForms: [] },
    });
    const res = await scanUrls(fd.driver, ['https://acme.com/contact', 'https://acme.com/pricing'], 'acme.com');
    const events = new Set(res.suggestions.map((s) => s.eventName));
    check('scanUrls: scans exactly the listed pages (2), no crawl', res.summary.pagesScanned === 2 && fd.opened().length === 2);
    check('scanUrls: builds suggestions from those pages', events.has('get_a_free_consultation_form') && events.has('email_click') && events.has('phone_click'));
    check('scanUrls: driver closed once', fd.closes() === 1);
  }

  // ── detectInstalled: GTM/GA4 ids live on the scanned site ──────────────────
  {
    const inst = detectInstalled([
      'https://www.googletagmanager.com/gtm.js?id=GTM-ABC123',
      'https://www.googletagmanager.com/gtag/js?id=G-XYZ789',
      'https://www.googletagmanager.com/gtag/js?id=AW-111222&l=dataLayer',
      'https://cdn.example.com/app.js',
    ]);
    check('installed: detects the GTM container id', inst.containers.includes('GTM-ABC123') && inst.containers.length === 1);
    check('installed: detects G-/AW- measurement ids', inst.measurementIds.includes('G-XYZ789') && inst.measurementIds.includes('AW-111222'));
    check('installed: ignores unrelated scripts', detectInstalled(['https://x.com/a.js']).containers.length === 0);
    // From raw page HTML (discovery): the inline GTM snippet.
    check('installed: catches the inline GTM snippet in HTML',
      detectInstalled([`<script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-INLINE9');</script>`]).containers.includes('GTM-INLINE9'));
  }

  // ── parseSuggestions: the four accepted shapes + junk ──────────────────────
  check('paste: full report ({suggestions:[…]}) passes through', parseSuggestions(JSON.stringify({ suggestions: [oneTag] })).suggestions.length === 1);
  check('paste: bare SuggestedTag[] passes through', parseSuggestions(JSON.stringify([oneTag])).suggestions[0].eventName === 'generate_lead');
  check(
    'paste: SuggestInput ({siteHost,forms,elements}) → engine builds contact_form',
    parseSuggestions(
      JSON.stringify({
        siteHost: 'acme.com',
        forms: [{ page: '/contact', purpose: 'contact', action: 'https://acme.com/x', provider: { vendor: 'unknown', confidence: 'low', evidence: '' } }],
        elements: [],
      }),
    ).suggestions.some((s) => s.eventName === 'contact_form'),
  );
  check(
    'paste: PageScan[] → engine builds suggestions',
    parseSuggestions(
      JSON.stringify([
        { page: '/contact', signals: { scriptSrcs: [], classNames: [], selectorsPresent: [] }, forms: [{ purpose: 'contact', action: 'https://acme.com/x' }], elements: [] },
      ]),
    ).suggestions.some((s) => s.eventName === 'contact_form'),
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
      // The tool's precheck short-circuit for a name already in the container (no create).
      if (tn === 'DUPE') return JSON.stringify({ alreadyExists: true, tag: { name: tn }, message: 'already exists' });
      return JSON.stringify({ tag: { name: tn }, trigger: { reused: tn === 'REUSE' } });
    };
    const tag = (id: string, tagName: string): SuggestedTagView => ({
      id, page: '/', label: '', evidence: '', confidence: 'high', enhancedMeasurementOverlap: false,
      platform: 'ga4_event', tagName, measurementId: '{{GA4 Measurement ID}}', eventName: 'e', trigger: { name: 't', kind: 'all_clicks' },
    });
    const progress: Array<[number, number]> = [];
    const fast = { sleep: async (): Promise<void> => {}, throttleMs: 0, onProgress: (d: number, t: number): void => { progress.push([d, t]); } };
    const outcomes = await createSuggestedTags(execute, { accountId: '1', containerId: '2', workspaceId: '3' }, [
      tag('a', 'OK'), tag('b', 'BOOM'), tag('c', 'REUSE'), tag('d', 'NOPE'), tag('e', 'DUPE'),
    ], fast);
    check('create: one outcome per tag, in order', outcomes.length === 5 && outcomes.map((o) => o.id).join('') === 'abcde');
    check('create: ok tag → ok:true with name', outcomes[0].ok && outcomes[0].tagName === 'OK');
    check('create: a thrown (non-quota) error is isolated, later tags still run', !outcomes[1].ok && (outcomes[1].error ?? '').includes('api 400') && outcomes[2].ok === true);
    check('create: reused trigger surfaced', outcomes[2].triggerReused === true);
    // The precheck-skip (already present) must count as EXISTING, not created — the reported total was
    // inflated because a skip was mapped to ok:true.
    check('create: precheck-skip (alreadyExists) → existing:true, NOT ok:true (count not inflated)',
      outcomes[4].existing === true && outcomes[4].ok === false && outcomes.filter((o) => o.ok).length === 2);
    check('create: onProgress fires once per tag with (done, total)', progress.length === 5 && progress[4][0] === 5 && progress[4][1] === 5);
    check('create: declined → ok:false error "declined"', !outcomes[3].ok && outcomes[3].error === 'declined');
    check('create: workspace ids passed to every call', calls.every((c) => c.accountId === '1' && c.containerId === '2' && c.workspaceId === '3') && calls.length === 5);

    // The GA4 Configuration base tag (google_tag) must send tagId + configSettings,
    // NOT eventName/eventParameters (the registry's google_tag branch reads tagId).
    const gtag: SuggestedTagView = {
      id: 'g', page: 'site-wide', label: '', evidence: '', confidence: 'high', enhancedMeasurementOverlap: false,
      platform: 'google_tag', tagName: 'GA4 Configuration', measurementId: '{{GA4 Measurement ID}}',
      tagId: '{{GA4 Measurement ID}}', configSettings: [{ name: 'send_page_view', value: 'true' }],
      eventName: '', trigger: { name: 'All Pages', kind: 'pageview' },
    };
    const gcalls: Array<Record<string, unknown>> = [];
    const gexec = async (_n: string, args: Record<string, unknown>): Promise<string> => { gcalls.push(args); return JSON.stringify({ tag: { name: 'GA4 Configuration' } }); };
    await createSuggestedTags(gexec, { accountId: '1', containerId: '2', workspaceId: '3' }, [gtag], fast);
    check('create: google_tag sends platform + tagId + configSettings and OMITS eventName', gcalls[0].platform === 'google_tag' && gcalls[0].tagId === '{{GA4 Measurement ID}}' && Array.isArray(gcalls[0].configSettings) && gcalls[0].eventName === undefined);

    // A meta_pixel suggestion drives a create_gtm_tracking_tag call with platform 'meta_pixel', sending
    // the pixel id via measurementId and the Meta event via eventName (the registry's meta branch reads
    // those). No change to createSuggestedTags was needed — it already forwards these for non-google_tag.
    const metaTag: SuggestedTagView = {
      id: 'm', page: '/contact', label: 'Meta Lead', evidence: '', confidence: 'high', enhancedMeasurementOverlap: false,
      platform: 'meta_pixel', tagName: 'Meta - Lead - Contact Form Tag', measurementId: '{{Meta Pixel ID}}',
      eventName: 'Lead', trigger: { name: 'Contact Form Trigger', kind: 'form_submit', formIdValue: 'lead-form', formIdOperator: 'equals' },
    };
    const mcalls: Array<Record<string, unknown>> = [];
    const mexec = async (_n: string, args: Record<string, unknown>): Promise<string> => { mcalls.push(args); return JSON.stringify({ tag: { name: 'Meta - Lead - Contact Form Tag' }, trigger: { reused: false } }); };
    const mout = await createSuggestedTags(mexec, { accountId: '1', containerId: '2', workspaceId: '3' }, [metaTag], fast);
    check('create: meta_pixel drives a create call with platform meta_pixel + pixel id (measurementId) + Meta eventName',
      mcalls[0].platform === 'meta_pixel' && mcalls[0].measurementId === '{{Meta Pixel ID}}' && mcalls[0].eventName === 'Lead' && mout[0].ok === true);

    // A google_ads_conversion suggestion drives a create call with conversionId + conversionLabel
    // (NOT measurementId/eventName) — the registry's awct branch reads those. measurementId holds the
    // Conversion ID; conversionLabel holds the Conversion Label.
    const adsConvTag: SuggestedTagView = {
      id: 'gc', page: '/contact', label: 'Google Ads Conversion', evidence: '', confidence: 'high', enhancedMeasurementOverlap: false,
      platform: 'google_ads_conversion', tagName: 'Google Ads - Conversion - Contact Form Tag',
      measurementId: '{{Google Ads Conversion ID}}', conversionLabel: '{{Google Ads Conversion Label}}',
      eventName: 'contact_form', trigger: { name: 'Contact Form Trigger', kind: 'form_submit', formIdValue: 'lead-form', formIdOperator: 'equals' },
    };
    const gccalls: Array<Record<string, unknown>> = [];
    const gcexec = async (_n: string, args: Record<string, unknown>): Promise<string> => { gccalls.push(args); return JSON.stringify({ tag: { name: 'Google Ads - Conversion - Contact Form Tag' }, trigger: { reused: false } }); };
    const gcout = await createSuggestedTags(gcexec, { accountId: '1', containerId: '2', workspaceId: '3' }, [adsConvTag], fast);
    check('create: google_ads_conversion drives a create call with conversionId + conversionLabel (no measurementId/eventName leak)',
      gccalls[0].platform === 'google_ads_conversion' && gccalls[0].conversionId === '{{Google Ads Conversion ID}}' && gccalls[0].conversionLabel === '{{Google Ads Conversion Label}}' &&
      gccalls[0].measurementId === undefined && gccalls[0].eventName === undefined && gcout[0].ok === true);

    // conversion_linker sends NO id fields; google_ads_remarketing sends only conversionId.
    const linkerTag: SuggestedTagView = {
      id: 'cl', page: 'site-wide', label: 'Conversion Linker', evidence: '', confidence: 'high', enhancedMeasurementOverlap: false,
      platform: 'conversion_linker', tagName: 'Google Ads - Conversion Linker', measurementId: '', eventName: '', trigger: { name: 'All Pages', kind: 'pageview' },
    };
    const clcalls: Array<Record<string, unknown>> = [];
    const clexec = async (_n: string, args: Record<string, unknown>): Promise<string> => { clcalls.push(args); return JSON.stringify({ tag: { name: 'Google Ads - Conversion Linker' } }); };
    await createSuggestedTags(clexec, { accountId: '1', containerId: '2', workspaceId: '3' }, [linkerTag], fast);
    check('create: conversion_linker sends no id fields', clcalls[0].platform === 'conversion_linker' && clcalls[0].conversionId === undefined && clcalls[0].measurementId === undefined && clcalls[0].eventName === undefined);

    // A pixel platform (pinterest) still flows the eventName/measurementId path unchanged.
    const pinTag: SuggestedTagView = {
      id: 'pt', page: '/p', label: 'Pinterest', evidence: '', confidence: 'high', enhancedMeasurementOverlap: false,
      platform: 'pinterest_tag', tagName: 'Pinterest - addtocart - Add To Cart Tag', measurementId: '{{Pinterest Tag ID}}', eventName: 'addtocart',
      trigger: { name: 'Add To Cart Trigger', kind: 'all_clicks', clickTextValue: 'Add to Cart', clickTextOperator: 'equals' },
    };
    const ptcalls: Array<Record<string, unknown>> = [];
    const ptexec = async (_n: string, args: Record<string, unknown>): Promise<string> => { ptcalls.push(args); return JSON.stringify({ tag: { name: 'Pinterest - addtocart - Add To Cart Tag' } }); };
    await createSuggestedTags(ptexec, { accountId: '1', containerId: '2', workspaceId: '3' }, [pinTag], fast);
    check('create: pinterest_tag sends measurementId (Tag ID) + eventName like the other pixels',
      ptcalls[0].platform === 'pinterest_tag' && ptcalls[0].measurementId === '{{Pinterest Tag ID}}' && ptcalls[0].eventName === 'addtocart');
  }

  // ── assembleResult: the AI-derived `extra` respects the platform selection too ──
  {
    // A GA4 tag the AI path would merge in as `extra`. Meta-only must NOT leak it, and "Both" must
    // ALSO derive its Meta counterpart (mirrors the engine path) — the platform-leak fix.
    const ga4Extra = {
      id: 'ai1', page: '/contact', label: 'Contact form', evidence: 'ai', confidence: 'high',
      enhancedMeasurementOverlap: false, platform: 'ga4_event', tagName: 'GA4 - Event - Contact Form (Lead)',
      measurementId: '{{GA4 Measurement ID}}', eventName: 'generate_lead',
      trigger: { name: 'Contact Form submit', kind: 'form_submit', formIdValue: 'c', formIdOperator: 'equals' },
    } as unknown as SuggestedTag;
    const metaOnly = assembleResult('https://x.com', 'x.com', [], [], [], 0, [ga4Extra], ['meta']).suggestions;
    check('assembleResult: meta-only drops the GA4 AI extra (no ga4_event leaks)', !metaOnly.some((s) => s.platform === 'ga4_event'));
    check('assembleResult: meta-only derives a Meta counterpart of the GA4 AI extra',
      metaOnly.some((s) => s.platform === 'meta_pixel' && s.eventName === 'Lead' && s.id === 'meta-ai1'));
    const both = assembleResult('https://x.com', 'x.com', [], [], [], 0, [ga4Extra], ['ga4', 'meta']).suggestions;
    check('assembleResult: both keeps the GA4 AI extra AND its Meta counterpart',
      both.some((s) => s.id === 'ai1' && s.platform === 'ga4_event') && both.some((s) => s.id === 'meta-ai1' && s.platform === 'meta_pixel'));
  }

  // ── dedupSuggestions: two suggestions with the SAME tag name collapse to one ──
  {
    // Same tag name but a slightly different trigger (an engine tag + the AI vision pass's copy of the
    // same button) — GTM tag names must be unique, so the second could never be created. Identity is
    // platform + name only, so these collapse; a differently-named tag survives.
    const mk = (over: Partial<SuggestedTag>): SuggestedTag => ({
      id: 'x', page: 'site-wide', label: '', evidence: '', confidence: 'high', enhancedMeasurementOverlap: false,
      platform: 'ga4_event', tagName: 'GA4 - Event - Free Audit Click Tag', measurementId: '{{GA4 Measurement ID}}',
      eventName: 'free_audit_click',
      trigger: { name: 'Free Audit Click Trigger', kind: 'all_clicks', clickTextValue: 'Free Audit', clickTextOperator: 'equals' },
      ...over,
    } as unknown as SuggestedTag);
    const engine = mk({ id: 'engine' });
    // AI copy: same name, but clickTextValue differs (so its suggestionKey/trigger differs — the case the
    // OLD trigger-inclusive key let slip past).
    const aiCopy = mk({ id: 'ai', trigger: { name: 'Free Audit Click Trigger', kind: 'all_clicks', clickTextValue: 'FREE AUDIT', clickTextOperator: 'equals' } as SuggestedTag['trigger'] });
    const distinct = mk({ id: 'contact', tagName: 'GA4 - Event - Contact Us Click Tag', eventName: 'contact_us_click' });
    const out = dedupSuggestions([engine, aiCopy, distinct]);
    check('dedup: two same-named tags (differing trigger) collapse to ONE; the first is kept',
      out.length === 2 && out.filter((s) => s.tagName.includes('Free Audit')).length === 1 && out.some((s) => s.id === 'engine') && out.some((s) => s.tagName.includes('Contact Us')));
  }

  // ── createSuggestedTags: GTM quota / rate-limit retry-with-backoff ─────────
  {
    const ids = { accountId: '1', containerId: '2', workspaceId: '3' };
    const tag = (id: string): SuggestedTagView => ({
      id, page: '/', label: '', evidence: '', confidence: 'high', enhancedMeasurementOverlap: false,
      platform: 'ga4_event', tagName: 'T', measurementId: '{{GA4 Measurement ID}}', eventName: 'e', trigger: { name: 't', kind: 'all_clicks' },
    });
    // Transient quota error twice, then success → retried with exponential backoff.
    let attempts = 0;
    const slept: number[] = [];
    const execQuota = async (): Promise<string> => {
      attempts += 1;
      if (attempts < 3) throw new Error("Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user' of service 'tagmanager.googleapis.com'");
      return JSON.stringify({ tag: { name: 'T' } });
    };
    const out1 = await createSuggestedTags(execQuota, ids, [tag('q')], { sleep: async (ms: number): Promise<void> => { slept.push(ms); }, throttleMs: 0, maxRetries: 4 });
    check('create: a quota error is retried with backoff, then succeeds', out1.length === 1 && out1[0].ok === true && attempts === 3);
    check('create: backoff is exponential (2s, 4s)', slept.length === 2 && slept[0] === 2000 && slept[1] === 4000);
    // Persistent quota error → gives up after maxRetries (returns the error, not a throw).
    let n = 0;
    const execAlways = async (): Promise<string> => { n += 1; throw new Error('RESOURCE_EXHAUSTED: rateLimitExceeded'); };
    const out2 = await createSuggestedTags(execAlways, ids, [tag('z')], { sleep: async (): Promise<void> => {}, throttleMs: 0, maxRetries: 2 });
    check('create: persistent quota error → ok:false after maxRetries+1 attempts', out2[0].ok === false && n === 3);

    // "Found entity with duplicate name" → marked existing (skipped), not an error,
    // and NOT retried (the name won't free up).
    let dn = 0;
    const execDup = async (): Promise<string> => { dn += 1; throw new Error('Found entity with duplicate name.'); };
    const outDup = await createSuggestedTags(execDup, ids, [tag('d')], { sleep: async (): Promise<void> => {}, throttleMs: 0 });
    check('create: duplicate-name → existing:true (skipped, not error), tried once', outDup[0].existing === true && outDup[0].ok === false && dn === 1);
  }

  // ── planGoogleTagVars: provision the {{variable}} a GA4 Configuration references ──
  {
    const snap = (vars: Array<{ name: string; type: string }>): ContainerSnapshot => ({ tags: [], triggers: [], variables: vars } as unknown as ContainerSnapshot);
    const gcfg = (over: Partial<SuggestedTagView> = {}): SuggestedTagView => ({
      id: 'g', page: 'site-wide', label: '', evidence: '', confidence: 'high', enhancedMeasurementOverlap: false,
      platform: 'google_tag', tagName: 'GA4 Configuration', measurementId: 'G-XXXXXXXXXX', tagId: '{{GA4 Measurement ID}}', eventName: '', trigger: { name: 'All Pages', kind: 'pageview' }, ...over,
    });
    check('plan: placeholder Measurement ID → row BLOCKED, no variable created', (() => { const p = planGoogleTagVars(snap([]), [gcfg()]); return p.creates.length === 0 && p.errors.has('g'); })());
    check('plan: real id → CREATE Constant "GA4 Measurement ID"=id, no error', (() => { const p = planGoogleTagVars(snap([]), [gcfg({ measurementId: 'G-ABC1234567' })]); return p.errors.size === 0 && p.creates.length === 1 && p.creates[0].name === 'GA4 Measurement ID' && p.creates[0].value === 'G-ABC1234567'; })());
    check('plan: existing Constant variable → REUSE (no create, no error)', (() => { const p = planGoogleTagVars(snap([{ name: 'GA4 Measurement ID', type: 'c' }]), [gcfg({ measurementId: 'G-ABC1234567' })]); return p.creates.length === 0 && p.errors.size === 0; })());
    check('plan: a NON-constant variable owns the name → row BLOCKED (conflict)', (() => { const p = planGoogleTagVars(snap([{ name: 'GA4 Measurement ID', type: 'v' }]), [gcfg({ measurementId: 'G-ABC1234567' })]); return p.errors.has('g') && p.creates.length === 0; })());
    check('plan: literal G- tagId → no variable needed, no error', (() => { const p = planGoogleTagVars(snap([]), [gcfg({ tagId: 'G-ABC1234567', measurementId: 'G-ABC1234567' })]); return p.creates.length === 0 && p.errors.size === 0; })());
    check('plan: ga4_event rows are ignored', (() => { const ev: SuggestedTagView = { id: 'e', page: '/', label: '', evidence: '', confidence: 'high', enhancedMeasurementOverlap: false, platform: 'ga4_event', tagName: 'T', measurementId: '{{GA4 Measurement ID}}', eventName: 'e', trigger: { name: 't', kind: 'all_clicks' } }; const p = planGoogleTagVars(snap([]), [ev]); return p.creates.length === 0 && p.errors.size === 0; })());
    check('plan: a REAL id containing an X-run (G-1XXXAB2345) is ACCEPTED (only the all-X placeholder is rejected)', (() => { const p = planGoogleTagVars(snap([]), [gcfg({ measurementId: 'G-1XXXAB2345' })]); return p.errors.size === 0 && p.creates.length === 1 && p.creates[0].value === 'G-1XXXAB2345'; })());
    check('plan: the GA4-config default (G-1234567890) is ACCEPTED → creates the Constant, no block', (() => { const p = planGoogleTagVars(snap([]), [gcfg({ measurementId: 'G-1234567890' })]); return p.errors.size === 0 && p.creates.length === 1 && p.creates[0].name === 'GA4 Measurement ID' && p.creates[0].value === 'G-1234567890'; })());
  }

  // ── provisionVariables: resilient variable creation (failures isolated) ──────
  {
    const ids = { accountId: '1', containerId: '2', workspaceId: '3' };
    const fast = { sleep: async (): Promise<void> => {} };
    const okCalls: Array<Record<string, unknown>> = [];
    const okExec = async (_n: string, a: Record<string, unknown>): Promise<string> => { okCalls.push(a); return '{}'; };
    const f1 = await provisionVariables(okExec, ids, [{ name: 'V', value: 'G-ABC1234567' }], fast);
    check('provision: success → no failures, create called once', f1.size === 0 && okCalls.length === 1);
    const dupExec = async (): Promise<string> => { throw new Error('Found entity with duplicate name.'); };
    check('provision: duplicate-name (TOCTOU race) is TOLERATED → not a failure', (await provisionVariables(dupExec, ids, [{ name: 'V', value: 'x' }], fast)).size === 0);
    let qn = 0;
    const quotaExec = async (): Promise<string> => { qn += 1; throw new Error('RESOURCE_EXHAUSTED: rateLimitExceeded'); };
    const f3 = await provisionVariables(quotaExec, ids, [{ name: 'V', value: 'x' }], { sleep: async (): Promise<void> => {}, maxRetries: 2 });
    check('provision: persistent quota → retried then recorded as failed var', f3.has('v') && qn === 3);
    const errExec = async (): Promise<string> => { throw new Error('api 400 invalid'); };
    check('provision: other error → recorded per-variable (so only dependent rows fail)', (await provisionVariables(errExec, ids, [{ name: 'V', value: 'x' }], fast)).has('v'));
  }

  console.log(`\nsuggestion-service: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}

void main();
