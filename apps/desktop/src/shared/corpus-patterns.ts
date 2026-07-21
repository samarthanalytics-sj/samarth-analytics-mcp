// GTM corpus pattern mining (Phase 1) — the PURE engine that turns raw GTM container exports into an
// ANONYMIZED, portable pattern library: canonical tag/trigger/variable shapes with per-container
// frequency counts. The 562-export corpus itself never ships; only this derived artifact does, so any
// machine gets the "learned from real containers" knowledge without the source files.
//
// Anonymization is layered:
//   1. VALUE REDACTION — every parameter value is reduced to a class (<id>, <url>, <num>, <path>,
//      <text>, {{var}}); only designated knowledge keys (GA4 event names, dataLayer keyPaths,
//      custom-event names) may keep a raw value, and ONLY via the allowlist below.
//   2. TOKEN ALLOWLIST — a kept knowledge value must consist ENTIRELY of tokens from a curated
//      generic analytics vocabulary (GENERIC_TOKENS). This is the primary defense: an adversarial
//      audit of a blocklist version proved real client brand names, product lines, a person's name
//      and an Ads conversion label all pass any "reject known-bad shapes" filter, because one
//      client's multiple containers defeat container-count k-anonymity. Allowlist inverts the
//      posture: nothing outside the vocabulary can ship, no matter how many containers carry it.
//   3. K-ANONYMITY BY FREQUENCY — a pattern is kept only when seen in >= MIN_CONTAINERS DISTINCT
//      containers, keyed by the container's publicId (never the export-file index, which double
//      counts duplicate export files of the same container).
//   4. LEAK SCAN — scanForLeaks() runs over the final artifact (and again in a unit test over the
//      committed file) rejecting concrete measurement ids (case-insensitive), URLs, emails, webhook
//      fragments and 8+ digit runs (contiguous or separator-broken).
//
// Export-JSON reality (verified against the corpus): enums are UPPER_SNAKE ('CUSTOM_EVENT',
// 'NOT_SET', 'EQUALS', 'TEMPLATE') unlike the live API's camelCase — normEnum() bridges that.

import { detectTagBrand, type TagBrand } from './tag-brand';

// ── Input (the subset of a GTM container export this engine reads; structural) ──────────────────────
export interface CorpusParam {
  key?: string;
  value?: string;
  type?: string;
  list?: unknown[];
  map?: unknown[];
}
export interface CorpusFilter {
  type?: string;
  parameter?: CorpusParam[];
}
export interface CorpusTag {
  name?: string;
  type?: string;
  parameter?: CorpusParam[];
  firingTriggerId?: string[];
  paused?: boolean;
  consentSettings?: { consentStatus?: string } | null;
}
export interface CorpusTrigger {
  triggerId?: string;
  name?: string;
  type?: string;
  filter?: CorpusFilter[];
  customEventFilter?: CorpusFilter[];
}
export interface CorpusVariable {
  name?: string;
  type?: string;
  parameter?: CorpusParam[];
}
export interface CorpusExport {
  containerVersion?: {
    container?: { publicId?: string; usageContext?: string[] };
    tag?: CorpusTag[];
    trigger?: CorpusTrigger[];
    variable?: CorpusVariable[];
  };
}

// ── Output (the artifact schema, version 1) ─────────────────────────────────────────────────────────
export interface TagPattern {
  type: string;
  /** Vendor brand (from the type code, else name hints) — 'tag' when unknown. */
  brand: TagBrand;
  /** The configured event name, when the tag type carries one and the value survived redaction. */
  eventName?: string;
  /** Sorted top-level parameter keys — the tag's structural shape. */
  paramKeys: string[];
  /** Normalized consent status ('needed' | 'notSet' | 'notNeeded'), or null when absent. */
  consent: string | null;
  /** Sorted, de-duplicated firing-trigger kinds (normalized trigger types; built-ins → 'builtIn'). */
  triggerKinds: string[];
  /** Distinct containers this exact shape appears in / total occurrences across the corpus. */
  containers: number;
  occurrences: number;
}
export interface TriggerPattern {
  type: string;
  /** For custom-event triggers: the dataLayer event name (k-anonymity protected). */
  event?: string;
  /** Each condition as "lhs op rhsClass" (e.g. "{{Page Path}} contains <path>"), sorted. */
  conditions: string[];
  containers: number;
  occurrences: number;
}
export interface VariablePattern {
  type: string;
  paramKeys: string[];
  /** For dataLayer variables: the keyPath (k-anonymity protected) — the reusable knowledge. */
  keyPath?: string;
  containers: number;
  occurrences: number;
}
export interface VendorStat {
  brand: TagBrand;
  containers: number;
}
export interface PatternLibrary {
  version: 1;
  /** Date only (YYYY-MM-DD) — never a precise timestamp. */
  minedAt: string;
  containersScanned: number;
  /** The k-anonymity threshold every pattern met (distinct containers). */
  minContainers: number;
  tagPatterns: TagPattern[];
  triggerPatterns: TriggerPattern[];
  variablePatterns: VariablePattern[];
  vendorStats: VendorStat[];
}

// ── Tunables ────────────────────────────────────────────────────────────────────────────────────────
/** K-anonymity: a pattern must appear in at least this many DISTINCT containers to be emitted. */
export const MIN_CONTAINERS = 2;
/** Per-kind caps keep the artifact compact (patterns are sorted by container frequency first). */
export const MAX_TAG_PATTERNS = 4000;
export const MAX_TRIGGER_PATTERNS = 2500;
export const MAX_VARIABLE_PATTERNS = 2500;

// ── Normalization + redaction ───────────────────────────────────────────────────────────────────────
/** UPPER_SNAKE export enum → the live API's camelCase ('CUSTOM_EVENT' → 'customEvent', 'NOT_SET' →
 *  'notSet'). Already-camel values pass through unchanged. */
export function normEnum(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (!/^[A-Z0-9_]+$/.test(s)) return s; // already camelCase / mixed — leave it
  const parts = s.toLowerCase().split('_').filter(Boolean);
  return parts[0] + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/** GTM built-in variable names whose {{reference}} is generic knowledge, safe to keep verbatim. */
const BUILTIN_VARS = new Set([
  '_event', 'event', 'page path', 'page url', 'page hostname', 'referrer',
  'click text', 'click url', 'click element', 'click classes', 'click id', 'click target',
  'form id', 'form classes', 'form element', 'form target', 'form url', 'form text',
  'scroll depth threshold', 'scroll depth units', 'scroll direction',
  'video current time', 'video duration', 'video percent', 'video provider', 'video status',
  'video title', 'video url', 'video visible',
  'container id', 'container version', 'environment name', 'random number', 'html id',
  'client name', 'event name', 'error message', 'error url', 'error line', 'debug mode',
  'new history fragment', 'old history fragment', 'new history state', 'old history state', 'history source',
]);

const ID_RE = /^(G|GT|AW|UA|DC|GTM)-[A-Z0-9-]+$/i;

/** Reduce a raw parameter value to an anonymized CLASS. Only the classes below can ever reach the
 *  artifact through this path — never the raw value. */
export function classifyValue(raw: unknown): string {
  const v = String(raw ?? '').trim();
  if (!v) return '<empty>';
  if (v === 'true' || v === 'false') return v;
  const varRef = /^\{\{(.+)\}\}$/.exec(v);
  if (varRef) return BUILTIN_VARS.has(varRef[1].trim().toLowerCase()) ? `{{${varRef[1].trim()}}}` : '{{var}}';
  if (ID_RE.test(v)) return '<id>';
  if (/^https?:\/\//i.test(v) || v.startsWith('//')) return '<url>';
  if (/\S+@\S+\.\S+/.test(v)) return '<email>';
  if (/^[-+]?\d+(\.\d+)?$/.test(v)) return '<num>';
  if (v.startsWith('/')) return '<path>';
  return '<text>';
}

/** Real corpus exports occasionally carry NON-ARRAY values where arrays are expected (odd/legacy
 *  exporters) — every list access goes through this guard so one malformed file never kills the mine. */
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Gallery/custom-template type codes EMBED the source container's numeric id (cvt_<containerId>_<n>)
 *  — a direct client identifier. Collapse them all to 'cvt'; the pattern's brand + paramKeys still
 *  distinguish the vendor templates. */
const normType = (t: string): string => (/^cvt_/i.test(t) ? 'cvt' : t);

/** Read a flat parameter value by key. */
const param = (params: CorpusParam[] | undefined, key: string): string => {
  for (const p of arr<CorpusParam>(params)) if (p && p.key === key) return String(p.value ?? '');
  return '';
};

/** The curated generic-analytics vocabulary. A knowledge value (event name / dataLayer keyPath) ships
 *  ONLY when every alphabetic token it contains is in this set — brand names, product lines, personal
 *  names and opaque tokens are excluded by construction because they are not in the vocabulary. Erring
 *  on the side of dropping is the design: a lost generic name costs a little knowledge; a kept branded
 *  name identifies a client in a committed artifact. */
const GENERIC_TOKENS = new Set(([
  // glue
  'a', 'an', 'and', 'all', 'any', 'at', 'by', 'for', 'from', 'in', 'is', 'my', 'new', 'of', 'off', 'on',
  'or', 'our', 'out', 'per', 'the', 'this', 'to', 'up', 'with', 'your', 'you', 'us', 'we', 'it', 'its',
  // actions
  'accept', 'add', 'apply', 'begin', 'book', 'browse', 'buy', 'call', 'cancel', 'change', 'chat', 'check',
  'checkout', 'clear', 'click', 'close', 'compare', 'complete', 'confirm', 'contact', 'continue', 'copy',
  'create', 'customize', 'delete', 'donate', 'download', 'downloads', 'drive', 'edit', 'engage', 'enter',
  'expand', 'explore', 'fill', 'filter', 'find', 'finish', 'generate', 'get', 'give', 'go', 'hide', 'hover',
  'install', 'join', 'learn', 'like', 'load', 'lock', 'log', 'login', 'logout', 'mail', 'navigate', 'open',
  'order', 'pause', 'pay', 'play', 'print', 'purchase', 'read', 'redeem', 'refund', 'register', 'remove',
  'request', 'reserve', 'reset', 'resume', 'save', 'schedule', 'scroll', 'search', 'see', 'select', 'send',
  'share', 'show', 'sign', 'signup', 'sort', 'start', 'started', 'stop', 'submit', 'submitted', 'subscribe',
  'swipe', 'tap', 'toggle', 'track', 'try', 'unsubscribe', 'update', 'upgrade', 'upload', 'view', 'visit',
  'watch', 'zoom',
  // objects / analytics nouns
  'about', 'account', 'address', 'agreement', 'alert', 'answer', 'appointment', 'article', 'availability',
  'banner', 'blog', 'booking', 'brochure', 'button', 'calculator', 'calendar', 'campaign', 'card', 'career',
  'careers', 'cart', 'catalog', 'catalogue', 'category', 'chatbot', 'city', 'code', 'comment', 'company',
  'consent', 'consultation', 'content', 'conversion', 'country', 'coupon', 'course', 'currency', 'custom',
  'customer', 'data', 'date', 'dealer', 'demo', 'department', 'description', 'detail', 'details', 'dialog',
  'directions', 'discount', 'doc', 'document', 'ebook', 'ecommerce', 'element', 'email', 'engagement',
  'enquiry', 'error', 'event', 'events', 'external', 'faq', 'faqs', 'favorite', 'favourite', 'feedback',
  'field', 'file', 'finance', 'financing', 'first', 'follow', 'footer', 'form', 'forms',
  'funnel', 'gallery', 'gift', 'guide', 'header', 'help', 'hero', 'home', 'homepage', 'id', 'image', 'info',
  'information', 'inquiry', 'internal', 'item', 'items', 'job', 'label', 'landing', 'language', 'last',
  'lead', 'leads', 'link', 'list', 'listing', 'location', 'make', 'map', 'member', 'membership', 'menu',
  'message', 'method', 'micro', 'model', 'modal', 'more', 'name', 'nav', 'navigation', 'newsletter', 'next',
  'notification', 'number', 'offer', 'option', 'outbound', 'page', 'pages', 'panel', 'password', 'payment',
  'phone', 'photo', 'plan', 'popup', 'position', 'post', 'preference', 'press', 'preview', 'previous',
  'price', 'pricing', 'product', 'products', 'profile', 'progress', 'promo', 'promotion', 'quantity',
  'question', 'quiz', 'quote', 'rating', 'reason', 'recipe', 'referral', 'region', 'registration',
  'resource', 'resources', 'result', 'results', 'resume', 'review', 'reviews', 'sales', 'sample', 'section',
  'service', 'services', 'session', 'settings', 'shipping', 'shop', 'site', 'size', 'slide', 'slider',
  'social', 'source', 'state', 'status', 'step', 'store', 'story', 'submission', 'subscription', 'success',
  'support', 'survey', 'tab', 'table', 'team', 'terms', 'test', 'text', 'thank', 'thankyou', 'ticket',
  'time', 'title', 'tool', 'top', 'total', 'tour', 'trade', 'trial', 'type', 'url', 'user', 'value',
  'variant', 'vehicle', 'video', 'videos', 'webinar', 'website', 'whitepaper', 'widget', 'wishlist', 'year',
  'zip',
  // ga4 / measurement standard terms
  'added', 'cta', 'dl', 'dlv', 'ga', 'ga4', 'gtm', 'impression', 'items',
  'measurement', 'pageview', 'pdf', 'pixel', 'refunded', 'scrolled', 'seo', 'shared', 'timer', 'tracking',
  'transaction', 'utm', 'viewed', 'virtual',
  // platform/vendor names (products, not clients)
  'android', 'app', 'apple', 'bing', 'chrome', 'facebook', 'gmail', 'google', 'instagram', 'ios',
  'linkedin', 'meta', 'messenger', 'outlook', 'pinterest', 'snapchat', 'spotify', 'telegram', 'tiktok',
  'twitter', 'whatsapp', 'x', 'youtube',
] as string[]).map((t) => t.toLowerCase()));

/** Split a candidate knowledge value into tokens: underscores, hyphens, spaces, dots, digit runs and
 *  camelCase boundaries all separate. Returns the ALPHABETIC tokens (digit runs are checked separately). */
export function knowledgeTokens(v: string): { words: string[]; digitRuns: string[] } {
  const spaced = v.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2');
  const parts = spaced.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return {
    words: parts.filter((p) => /[A-Za-z]/.test(p)),
    digitRuns: parts.filter((p) => /^\d+$/.test(p)),
  };
}

/** A raw knowledge value (event name / keyPath) is kept ONLY when EVERY alphabetic token is in the
 *  curated generic vocabulary and every digit run is short — else it is dropped (absent, not redacted).
 *  Allowlist by design: see the header. */
export function keepKnowledgeValue(raw: string): string | undefined {
  const v = raw.trim();
  if (!v || v.length > 60) return undefined;
  if (v.includes('{') || v.includes('}')) return undefined; // variable references are not concrete names
  if (ID_RE.test(v) || /^https?:/i.test(v) || /@/.test(v)) return undefined;
  const { words, digitRuns } = knowledgeTokens(v);
  if (!words.length) return undefined;
  if (digitRuns.some((d) => d.length >= 8)) return undefined; // an account/container id is not knowledge
  if (!words.every((w) => GENERIC_TOKENS.has(w.toLowerCase()))) return undefined;
  return v;
}

// GTM's reserved built-in trigger ids (All Pages, Consent Init, Init, DOM Ready, Window Loaded).
const isBuiltInTriggerId = (id: string): boolean => Number(id) >= 2147479553;

// ── Extraction ──────────────────────────────────────────────────────────────────────────────────────
/** Locale-free string compare so the artifact is byte-identical across machines/ICU builds. */
const byCodepoint = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

const stableStringify = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
};

function tagPatternOf(t: CorpusTag, triggerTypeById: Map<string, string>): Omit<TagPattern, 'containers' | 'occurrences'> {
  const type = String(t.type ?? '');
  const paramKeys = [...new Set(arr<CorpusParam>(t.parameter).map((p) => String(p?.key ?? '')).filter(Boolean))].sort();
  const kinds = [...new Set(arr<string>(t.firingTriggerId).map((id) =>
    isBuiltInTriggerId(String(id)) ? 'builtIn' : (triggerTypeById.get(String(id)) ?? 'unknown')))].sort();
  const rawConsent = normEnum(t.consentSettings?.consentStatus);
  const eventName = keepKnowledgeValue(param(t.parameter, 'eventName'));
  return {
    type: normType(type),
    brand: detectTagBrand(type, t.name),
    ...(eventName ? { eventName } : {}),
    paramKeys,
    consent: rawConsent || null,
    triggerKinds: kinds,
  };
}

/** One filter condition as "lhs op rhsClass" — values redacted, operands classified. */
function conditionOf(f: CorpusFilter): string {
  const op = normEnum(f.type);
  const lhs = classifyValue(param(f.parameter, 'arg0'));
  const rhs = classifyValue(param(f.parameter, 'arg1'));
  return `${lhs} ${op} ${rhs}`;
}

function triggerPatternOf(t: CorpusTrigger): Omit<TriggerPattern, 'containers' | 'occurrences'> {
  const type = normEnum(t.type);
  // The custom-event NAME is knowledge (which dataLayer events sites fire); the {{_event}} equality
  // filter carries it in arg1. Any other custom-event filter shape falls back to a plain condition.
  let event: string | undefined;
  const conditions: string[] = [];
  for (const f of arr<CorpusFilter>(t.customEventFilter)) {
    const lhsRaw = param(f.parameter, 'arg0');
    if (!event && lhsRaw === '{{_event}}' && normEnum(f.type) === 'equals') {
      event = keepKnowledgeValue(param(f.parameter, 'arg1'));
      if (event) continue;
    }
    conditions.push(conditionOf(f));
  }
  for (const f of arr<CorpusFilter>(t.filter)) conditions.push(conditionOf(f));
  conditions.sort();
  return { type, ...(event ? { event } : {}), conditions };
}

function variablePatternOf(v: CorpusVariable): Omit<VariablePattern, 'containers' | 'occurrences'> {
  const type = String(v.type ?? '');
  const paramKeys = [...new Set(arr<CorpusParam>(v.parameter).map((p) => String(p?.key ?? '')).filter(Boolean))].sort();
  // dataLayer keyPath ('name' on type v / 'keyPath' server-side) is the reusable knowledge.
  const keyPath = type === 'v' ? keepKnowledgeValue(param(v.parameter, 'name'))
    : type === 'ed' ? keepKnowledgeValue(param(v.parameter, 'keyPath'))
    : undefined;
  return { type: normType(type), paramKeys, ...(keyPath ? { keyPath } : {}) };
}

// ── Aggregation ─────────────────────────────────────────────────────────────────────────────────────
interface Agg<T> {
  pattern: T;
  /** DISTINCT container identities (publicId when present — never the export-file index, which double
   *  counts duplicate export files of the same container). */
  containers: Set<string>;
  occurrences: number;
}

/**
 * Mine the corpus: one call with every parsed export. Returns the complete anonymized library.
 * `minedAt` is injected (date string) so the caller controls it and tests stay deterministic.
 */
export function minePatternLibrary(exports_: CorpusExport[], minedAt: string, minContainers = MIN_CONTAINERS): PatternLibrary {
  const tags = new Map<string, Agg<Omit<TagPattern, 'containers' | 'occurrences'>>>();
  const triggers = new Map<string, Agg<Omit<TriggerPattern, 'containers' | 'occurrences'>>>();
  const variables = new Map<string, Agg<Omit<VariablePattern, 'containers' | 'occurrences'>>>();
  const vendorContainers = new Map<TagBrand, Set<string>>();
  let scanned = 0;

  exports_.forEach((exp, idx) => {
    const cv = exp?.containerVersion;
    if (!cv) return;
    scanned += 1;
    // Container identity = publicId; a duplicate export file of the same container must not count twice.
    const cid = String(cv.container?.publicId ?? '').trim() || `file:${idx}`;
    const triggerTypeById = new Map<string, string>(arr<CorpusTrigger>(cv.trigger).map((t) => [String(t?.triggerId ?? ''), normEnum(t?.type)]));
    const add = <T>(store: Map<string, Agg<T>>, pattern: T): void => {
      const key = stableStringify(pattern);
      const cur = store.get(key);
      if (cur) {
        cur.containers.add(cid);
        cur.occurrences += 1;
      } else {
        store.set(key, { pattern, containers: new Set([cid]), occurrences: 1 });
      }
    };
    for (const t of arr<CorpusTag>(cv.tag)) {
      if (!t || typeof t !== 'object') continue;
      if (t?.paused) continue; // a paused tag is not a practiced pattern
      const p = tagPatternOf(t, triggerTypeById);
      add(tags, p);
      if (p.brand !== 'tag' && p.brand !== 'html' && p.brand !== 'img') {
        const set = vendorContainers.get(p.brand) ?? new Set<string>();
        set.add(cid);
        vendorContainers.set(p.brand, set);
      }
    }
    for (const t of arr<CorpusTrigger>(cv.trigger)) if (t && typeof t === 'object') add(triggers, triggerPatternOf(t));
    for (const v of arr<CorpusVariable>(cv.variable)) if (v && typeof v === 'object') add(variables, variablePatternOf(v));
  });

  const finish = <T>(store: Map<string, Agg<T>>, cap: number): Array<T & { containers: number; occurrences: number }> =>
    [...store.values()]
      .filter((a) => a.containers.size >= minContainers)
      .sort((a, b) => b.containers.size - a.containers.size || b.occurrences - a.occurrences || byCodepoint(stableStringify(a.pattern), stableStringify(b.pattern)))
      .slice(0, cap)
      .map((a) => ({ ...a.pattern, containers: a.containers.size, occurrences: a.occurrences }));

  return {
    version: 1,
    minedAt,
    containersScanned: scanned,
    minContainers,
    tagPatterns: finish(tags, MAX_TAG_PATTERNS),
    triggerPatterns: finish(triggers, MAX_TRIGGER_PATTERNS),
    variablePatterns: finish(variables, MAX_VARIABLE_PATTERNS),
    vendorStats: [...vendorContainers.entries()]
      .map(([brand, set]) => ({ brand, containers: set.size }))
      .filter((v) => v.containers >= minContainers)
      .sort((a, b) => b.containers - a.containers),
  };
}

// ── Leak scan ───────────────────────────────────────────────────────────────────────────────────────
/** Patterns that must NEVER appear in the shipped artifact: concrete tracking ids, URLs, emails,
 *  webhook fragments, or a long digit run (account/container ids). Run over the SERIALIZED artifact by
 *  the miner (hard fail) and again by a unit test over the committed file. */
const LEAK_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'measurement/ads id', re: /\b(G|GT|AW|UA|DC|GTM)-[A-Z0-9]{4,}\b/i },
  { name: 'url', re: /https?:\/\//i },
  { name: 'email', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { name: 'slack webhook', re: /hooks\.slack\.com/i },
  { name: 'long digit run (account/container id)', re: /\d{8,}/ },
  { name: 'separator-broken digit run (phone/account number)', re: /\d(?:[\s().-]{0,2}\d){9,}/ },
];

export function scanForLeaks(artifactJson: string): Array<{ name: string; sample: string }> {
  const found: Array<{ name: string; sample: string }> = [];
  for (const { name, re } of LEAK_PATTERNS) {
    const m = re.exec(artifactJson);
    if (m) found.push({ name, sample: artifactJson.slice(Math.max(0, m.index - 30), m.index + 40) });
  }
  return found;
}
