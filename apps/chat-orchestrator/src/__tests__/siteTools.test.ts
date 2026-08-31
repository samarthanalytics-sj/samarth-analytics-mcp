/**
 * Reading the site to build a trigger.
 *
 * Every test here guards a way this can look like it worked and not have. GTM accepts a wrong
 * selector, a missing variable reference and an unscoped click trigger without complaint, so the
 * whole class of bugs is invisible at create time and only shows up as an empty report weeks later.
 * The assertions are about what survives the trip from the scanner to create_gtm_tracking_tag.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DeadlineError } from '../deadline.js';
import { ScanError, type ScanResult, type SiteScanner } from '../scan-client.js';
import {
  CHAT_DEFAULT_PAGES,
  CHAT_MAX_PAGES,
  MAX_SUGGESTIONS_RETURNED,
  SITE_PAGES_LIST,
  SITE_SCAN_TRIGGERS,
  clampPages,
  isSiteTool,
  rankSuggestions,
  runSiteTool,
  siteToolDefs,
  splitEventParameters,
  toChatScanResult,
  toChatSuggestion,
} from '../site-tools.js';

/** A CTA the engine pinned to a semantic class, the commonest real case. */
const CTA = {
  id: 's1',
  page: '/pricing',
  label: 'Book a demo button',
  evidence: 'Button with class "book-a-demo" on /pricing',
  confidence: 'high',
  enhancedMeasurementOverlap: false,
  platform: 'ga4_event',
  tagName: 'GA4 Event - Book Demo',
  measurementId: '{{GA4 Measurement ID}}',
  eventName: 'book_demo',
  eventParameters: [{ name: 'click_text', value: '{{Click Text}}' }],
  trigger: {
    name: 'Click - Book a demo',
    kind: 'all_clicks',
    clickElementValue: '.book-a-demo, .book-a-demo *',
    clickElementOperator: 'cssSelector',
  },
  // Never allowed to reach the model: a base64 JPEG would swallow the whole result budget.
  screenshot: 'data:image/jpeg;base64,AAAA',
  rect: { x: 1, y: 2, w: 3, h: 4 },
};

test('a click condition arrives with its operator and value untouched', () => {
  const s = toChatSuggestion(CTA, 0);
  assert.deepEqual(s.trigger.conditions, [
    { variable: 'Click Element', operator: 'matches CSS selector', value: '.book-a-demo, .book-a-demo *' },
  ]);
  assert.equal(s.trigger.gtmType, 'Click - All Elements');
  // The descendant form is the point of the cssSelector rung: a click on an inner icon still counts.
  assert.equal(
    (s.createWith!.args.trigger as Record<string, unknown>).clickElementValue,
    '.book-a-demo, .book-a-demo *',
  );
});

test('the create payload is ready to send apart from the ids and confirm', () => {
  const args = toChatSuggestion(CTA, 0).createWith!.args;
  assert.equal(toChatSuggestion(CTA, 0).createWith!.tool, 'create_gtm_tracking_tag');
  assert.equal(args.tagName, 'GA4 Event - Book Demo');
  assert.equal(args.platform, 'ga4_event');
  assert.equal(args.eventName, 'book_demo');
  assert.deepEqual(args.eventParameters, [{ name: 'click_text', value: '{{Click Text}}' }]);
  // The ids are the caller's to supply; inventing them here is how a tag lands in the wrong container.
  for (const k of ['accountId', 'containerId', 'workspaceId', 'confirm']) {
    assert.ok(!(k in args), `${k} must not be pre-filled`);
  }
});

test('no screenshot or pixel geometry reaches the model', () => {
  // A single base64 page image is larger than the whole tool-result budget, so one leaked screenshot
  // truncates every suggestion after it.
  const json = JSON.stringify(toChatSuggestion(CTA, 0));
  assert.doesNotMatch(json, /base64/);
  assert.doesNotMatch(json, /screenshot/);
  assert.doesNotMatch(json, /"rect"/);
});

// ── conditions that do not survive creation ────────────────────────────────

const WITH_LOOKUP = {
  ...CTA,
  id: 's2',
  trigger: {
    name: 'Click - FAQ rows',
    kind: 'all_clicks',
    clickElementValue: '.faq-q, .faq-q *',
    clickElementOperator: 'cssSelector',
    lookupTable: { name: 'Lookup - FAQ Question', texts: ['Shipping', 'Returns'] },
    dataLayerConditions: [{ key: 'form_id', value: 'contact-1', operator: 'equals' }],
  },
};

test('a condition the create path drops is reported, not silently lost', () => {
  const s = toChatSuggestion(WITH_LOOKUP, 0);
  // An unscoped click trigger does not fire LESS, it fires on every click on the site. Losing this
  // quietly is the single most damaging thing this mapping could do.
  const dropped = s.trigger.droppedOnCreate ?? [];
  assert.equal(dropped.length, 2);
  assert.ok(dropped.some((d) => d.variable === 'Lookup - FAQ Question'));
  assert.ok(dropped.some((d) => d.variable === 'dlv - form_id'));
  // And the surviving one is still listed as a real condition.
  assert.ok(s.trigger.conditions.some((c) => c.variable === 'Click Element'));
});

test('the dropped conditions are absent from the create payload, not merely flagged', () => {
  const trigger = toChatSuggestion(WITH_LOOKUP, 0).createWith!.args.trigger as Record<string, unknown>;
  // create_gtm_tracking_tag's schema does not declare these and zod strips them. Sending them anyway
  // would put fields in the model's context that read as though they will be applied.
  assert.ok(!('lookupTable' in trigger));
  assert.ok(!('dataLayerConditions' in trigger));
  assert.equal(trigger.kind, 'all_clicks');
});

test('a custom_event trigger keeps the event name it fires on', () => {
  const s = toChatSuggestion(
    { ...CTA, trigger: { name: 'CE - generate_lead', kind: 'custom_event', eventName: 'generate_lead' } },
    0,
  );
  assert.deepEqual(s.trigger.conditions, [
    { variable: 'Event name', operator: 'equals', value: 'generate_lead' },
  ]);
  assert.equal((s.createWith!.args.trigger as Record<string, unknown>).eventName, 'generate_lead');
});

test('a trigger arriving with `type` instead of `kind` keeps its type', () => {
  const s = toChatSuggestion({ ...CTA, trigger: { name: 'T', type: 'form_submit', formIdValue: 'contact' } }, 0);
  assert.equal(s.trigger.gtmType, 'Form Submission');
  assert.equal((s.createWith!.args.trigger as Record<string, unknown>).kind, 'form_submit');
});

// ── parameters that would arrive blank ─────────────────────────────────────

test('a parameter reading an uncreatable lookup variable is dropped and named', () => {
  const raw = {
    ...CTA,
    eventParameters: [
      { name: 'form_name', value: '{{Lookup - Form Name}}' },
      { name: 'page_path', value: '{{Page Path}}' },
    ],
    eventParamLookups: [{ variableName: 'Lookup - Form Name', input: '{{Page Path}}', rows: [] }],
  };
  const s = toChatSuggestion(raw, 0);
  // Kept, it would be accepted by GTM and record an empty string forever.
  assert.deepEqual(s.omittedParameters, [{ name: 'form_name', wouldRead: '{{Lookup - Form Name}}' }]);
  assert.deepEqual(s.createWith!.args.eventParameters, [{ name: 'page_path', value: '{{Page Path}}' }]);
});

test('a built-in reference is not mistaken for a missing variable', () => {
  const { kept, omitted } = splitEventParameters({
    eventParameters: [{ name: 'link_url', value: '{{Click URL}}' }],
    eventParamLookups: [{ variableName: 'Lookup - Something Else' }],
  });
  assert.equal(omitted.length, 0);
  assert.deepEqual(kept, [{ name: 'link_url', value: '{{Click URL}}' }]);
});

test('no parameters at all is not an error and adds no empty key', () => {
  const args = toChatSuggestion({ ...CTA, eventParameters: [] }, 0).createWith!.args;
  assert.ok(!('eventParameters' in args));
});

// ── platforms this chat cannot build ───────────────────────────────────────

test('a pixel platform is refused rather than built as GA4', () => {
  // Built as GA4 it would be a GA4 tag pointing at a Meta pixel id: created, correct-looking, wrong.
  const s = toChatSuggestion({ ...CTA, platform: 'meta_pixel', measurementId: '{{Meta Pixel ID}}' }, 0);
  assert.equal(s.createWith, null);
  assert.match(s.cannotCreate ?? '', /meta_pixel/);
});

test('google_tag and custom_html are creatable', () => {
  assert.ok(toChatSuggestion({ ...CTA, platform: 'google_tag', tagId: 'G-ABC' }, 0).createWith);
  assert.ok(toChatSuggestion({ ...CTA, platform: 'custom_html' }, 0).createWith);
});

// ── shaping the result ─────────────────────────────────────────────────────

test('what GA4 already collects by itself sinks below what it does not', () => {
  const ranked = rankSuggestions([
    toChatSuggestion({ ...CTA, id: 'auto', enhancedMeasurementOverlap: true, confidence: 'high' }, 0),
    toChatSuggestion({ ...CTA, id: 'real', confidence: 'medium' }, 1),
  ]);
  // Creating a tag for something Enhanced Measurement already sends is a double count, so it is the
  // first thing worth losing to the cap.
  assert.deepEqual(ranked.map((s) => s.id), ['real', 'auto']);
});

const scanResult = (suggestions: Record<string, unknown>[]): ScanResult => ({
  site: 'https://example.com',
  suggestions,
  warnings: [],
  scanned: 3,
  pages: [{ page: '/', forms: 1, elements: 4 }],
});

test('a capped list says it is partial instead of reading as complete', () => {
  const many = Array.from({ length: MAX_SUGGESTIONS_RETURNED + 4 }, (_, i) => ({ ...CTA, id: `s${i}` }));
  // A budget large enough that the COUNT ceiling is what bites, not the characters. The two limits
  // are separate and both have to work: the budget alone would happily return sixty short rows.
  const out = toChatScanResult(scanResult(many), 1_000_000);
  assert.equal(out.suggestionsFound, MAX_SUGGESTIONS_RETURNED + 4);
  assert.equal(out.suggestionsReturned, MAX_SUGGESTIONS_RETURNED);
  assert.match(String(out.truncated), /NOT in this list/);
});

test('the result is packed to fit the caller\'s cap, in whole rows', async () => {
  // Measured on a real two-page scan: 22 suggestions, 23,912 characters, against a 16,000 character
  // tool-result cap applied downstream. That cap cuts the JSON mid-object, so the model receives a
  // truncation notice attached to text it cannot parse. Dropping whole rows here is the fix.
  const many = Array.from({ length: 22 }, (_, i) => ({ ...CTA, id: `s${i}` }));
  let captured = '';
  const scanner = fakeScanner({ scan: async () => scanResult(many) });
  const r = await runSiteTool(scanner, SITE_SCAN_TRIGGERS, { url: 'https://example.com' }, 16_000);
  captured = r.text;

  assert.ok(captured.length < 16_000, `packed result was ${captured.length} chars`);
  const body = JSON.parse(captured); // The real assertion: it still parses.
  assert.equal(body.suggestionsFound, 22);
  assert.ok(body.suggestionsReturned < 22, 'some rows must have been left out');
  assert.match(String(body.truncated), /NOT in this list/);
});

test('one oversized suggestion is returned rather than an empty list', async () => {
  // "Nothing fitted" and "nothing was found" are opposite facts, and returning zero rows from a scan
  // that found one would report the second.
  const fat = { ...CTA, evidence: 'x'.repeat(5_000) };
  const scanner = fakeScanner({ scan: async () => scanResult([fat]) });
  const r = await runSiteTool(scanner, SITE_SCAN_TRIGGERS, { url: 'https://example.com' }, 500);
  const body = JSON.parse(r.text);
  assert.equal(body.suggestionsReturned, 1);
  // And the prose was capped on the way in, so one row cannot be arbitrarily large either.
  assert.ok(body.suggestions[0].evidence.length < 300);
});

test('a list that fits carries no truncation claim', () => {
  const out = toChatScanResult(scanResult([CTA]));
  assert.ok(!('truncated' in out));
  assert.equal(out.pagesScanned, 3);
  assert.deepEqual(out.pagesRead, ['/']);
});

test('the guidance tells the model not to rewrite the conditions', () => {
  const how = String(toChatScanResult(scanResult([CTA])).howToUse);
  assert.match(how, /Do NOT rewrite/);
  assert.match(how, /droppedOnCreate/);
  assert.match(how, /needsDeveloper/);
});

// ── bounds ─────────────────────────────────────────────────────────────────

test('the page budget defaults low and refuses to be talked upward', () => {
  assert.equal(clampPages(undefined), CHAT_DEFAULT_PAGES);
  assert.equal(clampPages(0), CHAT_DEFAULT_PAGES);
  assert.equal(clampPages('not a number'), CHAT_DEFAULT_PAGES);
  assert.equal(clampPages(-5), CHAT_DEFAULT_PAGES);
  assert.equal(clampPages(3), 3);
  // A scan that eats the whole turn budget leaves the user a timeout instead of an answer.
  assert.equal(clampPages(500), CHAT_MAX_PAGES);
  assert.equal(clampPages(2.9), 2);
});

// ── running the tools ──────────────────────────────────────────────────────

const fakeScanner = (impl: Partial<SiteScanner>): SiteScanner => impl as SiteScanner;

test('a missing url asks for one rather than scanning nothing', async () => {
  const r = await runSiteTool(fakeScanner({}), SITE_SCAN_TRIGGERS, {});
  assert.equal(r.ok, false);
  assert.match(r.text, /which website/i);
});

test('a scan passes the chosen pages through and caps them out loud', async () => {
  let seen: unknown;
  const scanner = fakeScanner({
    scan: async (_url, opts) => {
      seen = opts;
      return scanResult([CTA]);
    },
  });
  const pages = Array.from({ length: CHAT_MAX_PAGES + 3 }, (_, i) => `https://example.com/p${i}`);
  const r = await runSiteTool(scanner, SITE_SCAN_TRIGGERS, { url: 'https://example.com', pages });
  assert.equal(r.ok, true);
  assert.equal((seen as { pages: string[] }).pages.length, CHAT_MAX_PAGES);
  // Silently scanning 15 of 18 and reporting on all 18 would be the wrong kind of quiet.
  assert.match(String(JSON.parse(r.text).pagesDropped), /were NOT scanned/);
});

test('a crawl uses the page budget, and a chosen list overrides it', async () => {
  let seen: Record<string, unknown> = {};
  const scanner = fakeScanner({
    scan: async (_url, opts) => {
      seen = opts as Record<string, unknown>;
      return scanResult([]);
    },
  });
  await runSiteTool(scanner, SITE_SCAN_TRIGGERS, { url: 'https://example.com' });
  assert.equal(seen.maxPages, CHAT_DEFAULT_PAGES);
  assert.ok(!('pages' in seen));

  await runSiteTool(scanner, SITE_SCAN_TRIGGERS, { url: 'https://example.com', pages: ['https://example.com/a'] });
  assert.deepEqual(seen.pages, ['https://example.com/a']);
  assert.ok(!('maxPages' in seen), 'a chosen list must not also spend a crawl budget');
});

test('an overrun says not to retry it the same way', async () => {
  const scanner = fakeScanner({
    scan: async () => {
      throw new DeadlineError('too slow', 1);
    },
  });
  const r = await runSiteTool(scanner, SITE_SCAN_TRIGGERS, { url: 'https://example.com' });
  assert.equal(r.ok, false);
  // Repeating a 170-second failure is the expensive way to learn nothing.
  assert.match(r.text, /Do not\s+retry/i);
  assert.match(r.text, /Tag suggestions/);
});

test('a scanner that cannot start relays what would fix it', async () => {
  const scanner = fakeScanner({
    scan: async () => {
      throw new ScanError('The site scanner is not built. Run "npm ..." on the machine.', 'scanner_not_built');
    },
  });
  const r = await runSiteTool(scanner, SITE_SCAN_TRIGGERS, { url: 'https://example.com' });
  assert.equal(r.ok, false);
  assert.match(r.text, /not built/);
  assert.doesNotMatch(r.text, /scanner_not_built/, 'the code is for logs, the sentence is for the user');
});

test('an unexpected failure still comes back as a sentence', async () => {
  const scanner = fakeScanner({
    scan: async () => {
      throw new TypeError('fetch failed');
    },
  });
  const r = await runSiteTool(scanner, SITE_SCAN_TRIGGERS, { url: 'https://example.com' });
  assert.equal(r.ok, false);
  assert.match(r.text, /could not be read: fetch failed/);
});

test('listing pages reports how it found them and what it could not establish', async () => {
  const scanner = fakeScanner({
    discover: async () => ({
      site: 'https://example.com',
      pages: [{ url: 'https://example.com/', path: '/', source: 'sitemap' as const }],
      total: 1,
      // "unreachable" and "none" are opposite facts, and only one is safe to report as absence.
      sitemapStatus: 'unreachable' as const,
      sitemapsRead: [],
      viaCrawl: true,
      rejected: [],
    }),
  });
  const r = await runSiteTool(scanner, SITE_PAGES_LIST, { url: 'https://example.com' });
  assert.equal(r.ok, true);
  const body = JSON.parse(r.text);
  assert.equal(body.sitemapStatus, 'unreachable');
  assert.equal(body.foundVia, 'link crawl');
  assert.match(body.nextStep, new RegExp(SITE_SCAN_TRIGGERS));
});

// ── the tool surface itself ────────────────────────────────────────────────

test('both tools are read-only and recognised as the orchestrator\'s own', () => {
  const defs = siteToolDefs();
  assert.equal(defs.length, 2);
  for (const d of defs) {
    assert.equal(d.isWrite, false, `${d.name} must not be gated as a write`);
    assert.equal(d.isDelete, false);
    assert.equal(d.isDestructive, false);
    assert.ok(isSiteTool(d.name));
  }
  assert.ok(!isSiteTool('tags_create'));
  assert.ok(!isSiteTool(''));
});

test('the scan tool tells the model when to use it, in its own description', () => {
  const scan = siteToolDefs().find((d) => d.name === SITE_SCAN_TRIGGERS)!;
  // This text is read at the moment the model chooses between looking and guessing.
  assert.match(scan.description, /BEFORE BUILDING ANY CLICK OR FORM TRIGGER/);
  assert.match(scan.description, /never fires/);
});

test('nothing this file emits uses an em dash', () => {
  // Banned across every surface that reaches a user, and all of this text is written to be relayed.
  const surfaces = [
    ...siteToolDefs().map((d) => `${d.description} ${JSON.stringify(d.inputSchema)}`),
    JSON.stringify(toChatScanResult(scanResult([WITH_LOOKUP]))),
    JSON.stringify(toChatSuggestion({ ...CTA, platform: 'meta_pixel' }, 0)),
  ];
  for (const s of surfaces) assert.doesNotMatch(s, /—/);
});
