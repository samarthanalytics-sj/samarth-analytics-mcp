/**
 * Corpus analyzer for a folder of GTM container/workspace export JSONs.
 *
 *   npx tsx scripts/analyze-gtm-corpus.ts "C:/path/to/exports"
 *
 * PRIVACY: prints ONLY aggregates — resource TYPE names, counts, and audit
 * finding categories. It never prints tag/variable names, parameter values,
 * URLs, or measurement IDs, so the output is safe to paste/commit. The raw
 * exports are never written anywhere.
 *
 * Purpose: harden + extend auditContainer against real-world containers —
 * surface tag/trigger/variable types the audit doesn't handle, quantify
 * anti-patterns worth turning into new rules, and catch any parser crashes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditContainer, normConsent } from '../src/main/google/gtm-builders';
import type { ContainerSnapshot } from '../src/main/google/gtm-builders';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: tsx scripts/analyze-gtm-corpus.ts <folder-of-exports>');
  process.exit(2);
}

// What auditContainer currently special-cases / treats as consent-relevant.
const AUDIT_SPECIAL_CASED = new Set(['gaawe', 'html']);
const CONSENT_RELEVANT = new Set(['gaawe', 'googtag', 'awct', 'sp', 'gclidw', 'flc', 'fls', 'baut', 'bzi', 'hjtc']);
// Collapse sandboxed custom-template type codes (cvt_<containerId>_<id>, cvt_XXXXX)
// to one bucket so no container-identifying id is ever printed.
const typeKey = (t: string) => (t.startsWith('cvt_') ? '(custom-template)' : t || '(none)');
// Data-sending types the audit does NOT yet treat as consent-relevant (candidates).
const SENDS_DATA_UNHANDLED = new Set(['googtag', 'gaawc', 'awct', 'sp', 'gclidw', 'flc', 'fls', 'baut', 'twitter_website_tag', 'ua']);

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
function toSnapshot(cv: any): ContainerSnapshot {
  return {
    tags: arr(cv.tag).map((t) => ({
      tagId: t.tagId ?? '', name: t.name ?? '', type: t.type ?? '',
      firingTriggerId: t.firingTriggerId ?? [], blockingTriggerId: t.blockingTriggerId ?? [],
      paused: t.paused ?? false, parameter: arr(t.parameter), consentSettings: t.consentSettings ?? null,
    })),
    triggers: arr(cv.trigger).map((t) => ({
      triggerId: t.triggerId ?? '', name: t.name ?? '', type: t.type ?? '',
      filter: t.filter, autoEventFilter: t.autoEventFilter, customEventFilter: t.customEventFilter, parameter: t.parameter,
    })),
    variables: arr(cv.variable).map((v) => ({
      variableId: v.variableId ?? '', name: v.name ?? '', type: v.type ?? '', parameter: v.parameter,
    })),
  };
}

const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const top = (m: Map<string, number>, n = 30) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}: ${v}`);

const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
let parseFail = 0;
let auditFail = 0;
const auditErrTypes = new Map<string, number>();
const tagTypes = new Map<string, number>();
const triggerTypes = new Map<string, number>();
const variableTypes = new Map<string, number>();
const findingCat = new Map<string, number>();
const findingSev = new Map<string, number>();

let totTags = 0, totTriggers = 0, totVars = 0;
let consentRelevantTags = 0, consentRelevantMissing = 0;
let googtagTotal = 0, googtagNoConsent = 0;
let gaaweTotal = 0;
let htmlTags = 0;
let cvtTags = 0; // sandboxed custom-template tags (cvt_...)
let cvtVars = 0;
let noFiringTrigger = 0;
let pausedTags = 0;
let containersAnalyzed = 0;
const unhandledSendsData = new Map<string, number>(); // data-sending types the audit ignores

for (const f of files) {
  let j: any;
  try {
    j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  } catch {
    parseFail++;
    continue;
  }
  const cv = j.containerVersion ?? j;
  const snap = toSnapshot(cv);
  containersAnalyzed++;
  totTags += snap.tags.length;
  totTriggers += snap.triggers.length;
  totVars += snap.variables.length;

  for (const t of snap.tags) {
    bump(tagTypes, typeKey(t.type));
    if (t.type.startsWith('cvt_')) cvtTags++;
    if (t.type === 'html') htmlTags++;
    if (t.type === 'googtag') {
      googtagTotal++;
      const cs = normConsent(t.consentSettings?.consentStatus);
      if (!cs || cs === 'notset') googtagNoConsent++;
    }
    if (t.type === 'gaawe') gaaweTotal++;
    if (!t.firingTriggerId || t.firingTriggerId.length === 0) noFiringTrigger++;
    if (t.paused) pausedTags++;
    if (CONSENT_RELEVANT.has(t.type)) {
      consentRelevantTags++;
      const cs = normConsent(t.consentSettings?.consentStatus);
      if (!cs || cs === 'notset') consentRelevantMissing++;
    }
    if (SENDS_DATA_UNHANDLED.has(t.type) && !CONSENT_RELEVANT.has(t.type) && !AUDIT_SPECIAL_CASED.has(t.type)) {
      bump(unhandledSendsData, t.type);
    }
  }
  for (const tr of snap.triggers) bump(triggerTypes, tr.type || '(none)');
  for (const v of snap.variables) {
    bump(variableTypes, typeKey(v.type));
    if (v.type.startsWith('cvt_')) cvtVars++;
  }

  try {
    const report = auditContainer(snap);
    for (const fd of report.findings) {
      bump(findingCat, fd.category);
      bump(findingSev, fd.severity);
    }
  } catch (e) {
    auditFail++;
    bump(auditErrTypes, (e as Error).message.slice(0, 80));
  }
}

const pct = (n: number, d: number) => (d > 0 ? ((n / d) * 100).toFixed(1) : '0.0');

console.log('\n=== GTM CORPUS ANALYSIS ===');
console.log(`files: ${files.length}  parsed: ${containersAnalyzed}  parseFail: ${parseFail}  auditCrash: ${auditFail}`);
if (auditFail) console.log('audit crash messages:', top(auditErrTypes, 10));
console.log(`totals — tags: ${totTags}  triggers: ${totTriggers}  variables: ${totVars}`);

console.log('\n-- TAG TYPES (top 30) --');
console.log(top(tagTypes).join('\n'));
console.log('\n-- TRIGGER TYPES --');
console.log(top(triggerTypes).join('\n'));
console.log('\n-- VARIABLE TYPES (top 30) --');
console.log(top(variableTypes).join('\n'));

console.log('\n-- ANTI-PATTERN / HARDENING SIGNALS --');
console.log(`tags with NO firing trigger: ${noFiringTrigger} (${pct(noFiringTrigger, totTags)}% of tags)`);
console.log(`paused tags: ${pausedTags} (${pct(pausedTags, totTags)}%)`);
console.log(`consent-relevant tags (known set): ${consentRelevantTags}, of which missing consent: ${consentRelevantMissing} (${pct(consentRelevantMissing, consentRelevantTags)}%)`);
console.log(`googtag (Google tag): ${googtagTotal}, of which missing consent: ${googtagNoConsent} (${pct(googtagNoConsent, googtagTotal)}%)  [NOT currently consent-checked]`);
console.log(`gaawe (GA4 event) tags: ${gaaweTotal}`);
console.log(`Custom HTML (html) tags: ${htmlTags}`);
console.log(`sandboxed custom-TEMPLATE tags (cvt_*): ${cvtTags}; custom-template variables: ${cvtVars}`);
console.log('data-sending tag types the audit does NOT handle (candidates for new rules):', top(unhandledSendsData, 20));

console.log('\n-- WHAT auditContainer CURRENTLY FINDS across the corpus --');
console.log('by severity:', top(findingSev));
console.log('by category:', top(findingCat));
console.log('\n(aggregates only — no names/values/IDs printed)\n');
