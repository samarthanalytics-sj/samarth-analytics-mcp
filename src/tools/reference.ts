/**
 * GTM's type vocabulary, so the chat can ANSWER questions about it instead of guessing.
 *
 * Why this is a tool and not prose in a description: the catalogue is long, and a tool description
 * is paid for on every single request whether or not anybody asks about tag types. As a tool it
 * costs nothing until the question is actually asked.
 *
 * PROVENANCE, because the three lists have very different standing:
 *
 *   Trigger types        OFFICIAL. Google publishes this as an enum on the Trigger resource, and
 *                        the list below is that enum in full.
 *   Built-in variables   OFFICIAL. Also a published enum; the server already carries it in
 *                        builtInVariables.ts, which stays the single source of truth.
 *   Tag + variable types NOT PUBLISHED. `Tag.type` and `Variable.type` are free strings in the API,
 *                        and Google documents the human names ("Lookup Table") without ever naming
 *                        the code that goes over the wire ("smm"). Blog posts that fill the gap
 *                        contradict each other, so every code below was decoded from the parameter
 *                        keys real containers carry, which identify a type unambiguously: a Lookup
 *                        Table has `input` + `map`, a RegEx Table has `fullMatch` + `ignoreCase`,
 *                        a Bing UET tag has `uetqName`. Where a code is uncertain it says so rather
 *                        than guessing.
 *
 * Keep entries free of em dashes: this text is written to be relayed to users verbatim.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult, errorResult } from '../utils/toolResponse.js';
import { GALLERY_TEMPLATES, GALLERY_SNAPSHOT_DATE } from './galleryCatalog.js';

/** Returned matches are capped: the point is to identify a template, not to page the whole gallery. */
const MAX_GALLERY_MATCHES = 25;

/**
 * Finds gallery templates by name.
 *
 * Ranked rather than filtered, because the useful answer to "hotjar" is the template actually called
 * Hotjar, not the first of nine alphabetically. Exact name beats prefix beats substring, and an
 * owner match is kept last so searching a vendor name still finds their templates.
 */
export function searchGallery(
  query: string,
  limit = MAX_GALLERY_MATCHES,
): { name: string; owner: string }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { name: string; owner: string; score: number }[] = [];
  for (const [name, owner] of GALLERY_TEMPLATES) {
    const n = name.toLowerCase();
    const o = owner.toLowerCase();
    let score = -1;
    if (n === q) score = 0;
    else if (n.startsWith(q)) score = 1;
    else if (n.includes(q)) score = 2;
    else if (o === q) score = 3;
    else if (o.includes(q)) score = 4;
    if (score >= 0) scored.push({ name, owner, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map(({ name, owner }) => ({ name, owner }));
}

export interface TypeEntry {
  /** The exact string the API expects. */
  code: string;
  /** What it is called in the GTM interface. */
  name: string;
  /** Where it applies, and anything that trips people up. */
  note?: string;
}

/**
 * Tag types.
 *
 * `web` runs in a browser container, `server` in a server container, `legacy` still resolves but
 * is no longer the way to build anything new.
 */
export const TAG_TYPES: Record<'web' | 'server' | 'legacy', TypeEntry[]> = {
  web: [
    { code: 'googtag', name: 'Google tag', note: 'Loads gtag.js and configures GA4 or Ads. A container needs exactly one, firing on All Pages. Key field: tagId.' },
    { code: 'gaawe', name: 'GA4 Event', note: 'The workhorse. Needs BOTH a measurementId tagReference and a measurementIdOverride, or the API rejects it.' },
    { code: 'html', name: 'Custom HTML', note: 'Arbitrary page script. Prefer a sandboxed gallery template when one exists: Custom HTML has no Consent Mode integration and no declared permissions.' },
    { code: 'img', name: 'Custom Image', note: 'A pixel fired as an image request.' },
    { code: 'awct', name: 'Google Ads Conversion Tracking', note: 'Fields: conversionId, conversionLabel.' },
    { code: 'awcc', name: 'Google Ads Call Conversion', note: 'For calls from a website. Field: phoneConversionNumber.' },
    { code: 'awud', name: 'Google Ads User-Provided Data', note: 'Feeds Enhanced Conversions. Field: userDataVariable.' },
    { code: 'sp', name: 'Google Ads Remarketing', note: 'Despite the code, this is remarketing, not a script tag.' },
    { code: 'gclidw', name: 'Conversion Linker', note: 'Stores ad-click information in first-party cookies. Usually All Pages.' },
    { code: 'flc', name: 'Floodlight Counter' },
    { code: 'fls', name: 'Floodlight Sales' },
    { code: 'baut', name: 'Microsoft Advertising UET', note: 'Bing UET. Field: uetqName, eventType.' },
    { code: 'bzi', name: 'LinkedIn Insight Tag', note: 'The BUILT-IN one. Field: id. LinkedIn Insight Tag 2.0 is a separate GALLERY template, not this.' },
    { code: 'hjtc', name: 'Hotjar Tracking Code', note: 'Field: hotjar_site_id.' },
    { code: 'asp', name: 'AdRoll Smart Pixel' },
    { code: 'cegg', name: 'Crazy Egg' },
    { code: 'qcm', name: 'Quantcast' },
    { code: 'cvt_<id>', name: 'Custom or Community Gallery template', note: 'Every third-party template resolves to one of these. Never assemble the code yourself: call templates_list and pass its tagType field through verbatim.' },
  ],
  server: [
    { code: 'sgtmgaaw', name: 'GA4 (server)', note: 'Server-container GA4 tag.' },
    { code: 'sgtmadsct', name: 'Google Ads Conversion Tracking (server)' },
    { code: 'sgtmadscl', name: 'Conversion Linker (server)' },
    { code: 'sgtmadsremarket', name: 'Google Ads Remarketing (server)' },
  ],
  legacy: [
    { code: 'ua', name: 'Universal Analytics', note: 'GA3. Stopped processing data; present only in old containers.' },
    { code: 'gaawc', name: 'GA4 Configuration', note: 'Superseded by googtag. Do not build new ones.' },
    { code: 'opt', name: 'Google Optimize', note: 'Optimize was sunset.' },
    { code: 'lcl', name: 'Link Click Listener', note: 'GTM v1 listener. Modern containers use a linkClick trigger instead.' },
  ],
};

/**
 * Trigger types, the complete published enum from the Trigger resource.
 *
 * CASING MATTERS AND CHANGES BY CONTEXT: the live API uses these camelCase strings, while an
 * exported container JSON writes the same values as UPPER_SNAKE (customEvent becomes CUSTOM_EVENT).
 * Reading a type off an export and posting it to the API is a real and easy mistake.
 */
export const TRIGGER_TYPES: Record<'web' | 'server' | 'amp' | 'mobile', TypeEntry[]> = {
  web: [
    { code: 'pageview', name: 'Page View' },
    { code: 'domReady', name: 'DOM Ready' },
    { code: 'windowLoaded', name: 'Window Loaded' },
    { code: 'click', name: 'Click, All Elements' },
    { code: 'linkClick', name: 'Click, Just Links' },
    { code: 'formSubmission', name: 'Form Submission' },
    { code: 'customEvent', name: 'Custom Event', note: 'The dataLayer path. customEventFilter must contain EXACTLY ONE condition on {{_event}}.' },
    { code: 'historyChange', name: 'History Change', note: 'Single-page app route changes.' },
    { code: 'jsError', name: 'JavaScript Error' },
    { code: 'scrollDepth', name: 'Scroll Depth' },
    { code: 'elementVisibility', name: 'Element Visibility' },
    { code: 'youTubeVideo', name: 'YouTube Video' },
    { code: 'timer', name: 'Timer', note: 'interval and limit are TOP-LEVEL fields, not entries in parameter. Putting them in parameter leaves the GTM interface blank.' },
    { code: 'triggerGroup', name: 'Trigger Group' },
    { code: 'init', name: 'Initialization' },
    { code: 'consentInit', name: 'Consent Initialization', note: 'Runs before everything else. Where a Consent Mode default belongs.' },
    { code: 'always', name: 'Always (All Pages)' },
  ],
  server: [{ code: 'serverPageview', name: 'Server Page View' }],
  amp: [
    { code: 'ampClick', name: 'AMP Click' },
    { code: 'ampTimer', name: 'AMP Timer' },
    { code: 'ampScroll', name: 'AMP Scroll' },
    { code: 'ampVisibility', name: 'AMP Visibility' },
  ],
  mobile: [
    { code: 'firebaseAppException', name: 'App Exception' },
    { code: 'firebaseAppUpdate', name: 'App Update' },
    { code: 'firebaseCampaign', name: 'Campaign' },
    { code: 'firebaseFirstOpen', name: 'First Open' },
    { code: 'firebaseInAppPurchase', name: 'In-App Purchase' },
    { code: 'firebaseNotificationDismiss', name: 'Notification Dismiss' },
    { code: 'firebaseNotificationForeground', name: 'Notification Foreground' },
    { code: 'firebaseNotificationOpen', name: 'Notification Open' },
    { code: 'firebaseNotificationReceive', name: 'Notification Receive' },
    { code: 'firebaseOsUpdate', name: 'OS Update' },
    { code: 'firebaseSessionStart', name: 'Session Start' },
    { code: 'firebaseUserEngagement', name: 'User Engagement' },
  ],
};

/** User-defined variable types. Codes decoded from the parameter keys real containers carry. */
export const VARIABLE_TYPES: TypeEntry[] = [
  { code: 'v', name: 'Data Layer Variable', note: 'The most common by far. Field: name, dot-notation for nested keys.' },
  { code: 'jsm', name: 'Custom JavaScript', note: 'An anonymous function that returns a value. Field: javascript.' },
  { code: 'j', name: 'JavaScript Variable', note: 'Reads a GLOBAL variable by name. Not the same as jsm.' },
  { code: 'c', name: 'Constant', note: 'A fixed reused value. The right home for a Measurement ID.' },
  { code: 'k', name: '1st Party Cookie', note: 'Field: name, decodeCookie.' },
  { code: 'u', name: 'URL Variable', note: 'Field: component (host, path, query, fragment), queryKey.' },
  { code: 'f', name: 'HTTP Referrer' },
  { code: 'e', name: 'Custom Event', note: 'The current event name.' },
  { code: 'd', name: 'DOM Element', note: 'Field: elementSelector, attributeName.' },
  { code: 'aev', name: 'Auto-Event Variable', note: 'Reads the element that triggered an auto-event. Field: varType.' },
  { code: 'vis', name: 'Element Visibility', note: 'Field: elementSelector, onScreenRatio.' },
  { code: 'smm', name: 'Lookup Table', note: 'Exact matching. Fields: input, map.' },
  { code: 'remm', name: 'RegEx Table', note: 'Pattern matching. Fields: input, map, fullMatch, ignoreCase.' },
  { code: 'gtcs', name: 'Google Tag: Configuration Settings', note: 'Field: configSettingsTable.' },
  { code: 'gtes', name: 'Google Tag: Event Settings', note: 'Field: eventSettingsTable.' },
  { code: 'awec', name: 'User-Provided Data', note: 'Enhanced Conversions. Fields: mode, email, phone_number.' },
  { code: 'ed', name: 'Event Data (server)', note: 'Server containers. Field: keyPath.' },
  { code: 'gas', name: 'Google Analytics Settings', note: 'Universal Analytics settings bundle. Legacy.' },
  { code: 'cid', name: 'Container ID' },
  { code: 'ctv', name: 'Container Version Number' },
  { code: 'dbg', name: 'Debug Mode' },
  { code: 'r', name: 'Random Number' },
  { code: 'uv', name: 'Undefined Value' },
  { code: 'cvt_<id>', name: 'Custom or Community Gallery template variable', note: 'Gallery templates can supply variables as well as tags.' },
];

/**
 * The Community Template Gallery, by category.
 *
 * Not an exhaustive index: the gallery has well over a thousand templates and changes constantly,
 * so freezing a full copy here would be wrong within a week. What this gives is the SHAPE, which is
 * what a question like "can you add Hotjar" actually needs: the category exists, it is reachable by
 * templates_import_from_gallery, and here is the owner/repository where it is known.
 *
 * The honest rule for anything not listed: the answer is still yes, but the exact owner/repository
 * has to be read off the template's page in the gallery, because guessing it returns a bare 404.
 */
export const GALLERY_CATEGORIES: { category: string; examples: string[]; known?: Record<string, string> }[] = [
  {
    category: 'Consent management platforms',
    examples: ['Cookiebot', 'OneTrust', 'CookieYes', 'Axeptio', 'Usercentrics', 'Osano', 'Clym', 'Commanders Act', 'Complianz', 'Consent Studio', 'iubenda', 'Sirdata (ABconsent)', 'BigID', 'Captain Compliance', 'Clickio', 'AdSimple', 'Avacy', 'Concord', '2BCookie', 'Acceptrics'],
  },
  {
    category: 'Consent Mode v2 handlers',
    examples: ['Advanced Consent Mode v2 Banner', 'Consent Mode (Free) by Toolz', 'Google + Microsoft Consent Mode', 'Orbee Consent Mode', 'Cookie Information Consent Mode'],
  },
  {
    category: 'Web and event analytics',
    examples: ['Matomo', 'Piwik PRO', 'Mixpanel', 'Plausible', 'Yandex Metrica', 'Countly', 'Datadog RUM', 'Cloudflare Web Analytics', 'Eulerian', 'Abralytics'],
  },
  {
    category: 'Session replay and UX',
    examples: ['Hotjar', 'Microsoft Clarity', 'Contentsquare', 'Fullstory', 'Mouseflow', 'Lucky Orange'],
    known: { Hotjar: 'built-in tag type hjtc, no import needed' },
  },
  {
    category: 'Ad networks and conversion pixels',
    examples: ['Meta (Facebook) Pixel and CAPI', 'TikTok', 'Pinterest', 'Snapchat', 'Criteo', 'Adform', 'ADCELL', 'Amazon Advertising', '6sense', 'Nextdoor', 'OpenAI Ads Measurement'],
    known: {
      'Meta Pixel': 'facebook/GoogleTagManager-WebTemplate-For-FacebookPixel',
      TikTok: 'tiktok/gtm-template-pixel',
      'Pinterest (web)': 'pinterest/ws-gtm-template',
      'Pinterest (server)': 'pinterest/ss-gtm-template',
      Snapchat: 'Snapchat/snapchat-google-tag-manager',
    },
  },
  {
    category: 'Professional networks',
    examples: ['LinkedIn Insight Tag 2.0'],
    known: { 'LinkedIn Insight Tag 2.0': 'linkedin/linkedin-gtm-community-template' },
  },
  {
    category: 'Affiliate and partner networks',
    examples: ['Awin', 'CJ Affiliate', 'Admitad', 'Affilae', 'Affirm', 'Daisycon', 'Partnerize'],
  },
  {
    category: 'Accessibility and compliance widgets',
    examples: ['UserWay', 'AudioEye', 'Accessibly', 'AccessiWeb', 'AAA WCAG 2.2 with adaptor.app', 'AAANOW ACM Panel Loader', 'Binclusive', 'CorpoWid', 'Inclusif'],
  },
  {
    category: 'Marketing automation and CRM',
    examples: ['HubSpot', 'Klaviyo', 'Intercom', 'Brevo', 'ActiveCampaign', 'Mailchimp', 'Drift', 'amoCRM'],
  },
  {
    category: 'Server-side (Stape and others)',
    examples: ['Stape Facebook', 'Stape TikTok', 'Stape LinkedIn', 'Stape Reddit', 'Stape Amazon', 'StackAdapt'],
    known: {
      'Stape Facebook': 'stape-io/facebook-tag',
      'Stape TikTok': 'stape-io/tiktok-tag',
      'Stape LinkedIn': 'stape-io/linkedin-tag',
      'Stape Reddit': 'stape-io/reddit-tag',
      'Stape Amazon': 'stape-io/amazon-tag',
      StackAdapt: 'StackAdapt/stackadapt-gtm-server-side-pixel',
    },
  },
];

/**
 * Vendors GTM ships a NATIVE tag template for, from Google's published "Supported tags" list.
 *
 * Names only, deliberately. Google documents that these vendors are built in but never publishes
 * the type code that goes over the wire for each, and no reliable third-party list exists either:
 * a search for them returns pages that contradict each other. Recording a guessed code would be
 * worse than recording nothing, because a wrong code is accepted by the API and then renders in GTM
 * as an unrecognised tag, so the failure is silent.
 *
 * The useful thing to say is therefore "GTM has this built in, read the exact code off the
 * container", which is what identifyTagType does.
 */
export const NATIVE_VENDORS: string[] = [
  'AB Tasty', 'AdRoll', 'AdAdvisor (Neustar)', 'Awin', 'Bizrate Insights', 'ClickTale',
  'Conversant', 'Crazy Egg', 'Criteo', 'DistroScale', 'Dstillery', 'Eulerian Technologies',
  'FoxMetrics', 'Hotjar', 'Infinity Call Tracking', 'K50', 'LeadLab by wiredminds', 'LinkedIn',
  'Lytics', 'Marin Software', 'Microsoft Advertising (Bing)', 'Mouseflow', 'Nielsen', 'Nudge',
  'Oktopost', 'Optimise Media', 'OwnerListens', 'Perfect Audience (SharpSpring Ads)',
  'Personali (Namogoo)', 'Pinterest', 'Placed', 'Pulse Insights', 'Quantcast', 'Quora',
  'Rawsoft', 'SaleCycle', 'Shareaholic', 'Survicate', 'TradeDoubler', 'Turn (Amobee)',
  'Twitter', 'UpSellIt', 'Ve Interactive', 'VisualDNA', 'Xtremepush', 'Yieldify',
];

const ALL_TAG_ENTRIES = [...TAG_TYPES.web, ...TAG_TYPES.server, ...TAG_TYPES.legacy];

/**
 * Tells a gallery-installed template apart from one authored in the container, from the code alone.
 *
 * The two shapes are genuinely different, so no lookup is needed to distinguish them:
 *
 *   cvt_MRQN8        gallery: the gallery's own id, which is short and alphanumeric
 *   cvt_1234567_12   local:   containerId + templateId, both numeric
 *
 * Only the numeric pair is treated as local. A gallery id could in principle contain an underscore,
 * and misreading a vendor template as home-grown would send someone hunting for source code that
 * does not exist, so anything that is not clearly the numeric pair falls back to gallery.
 */
export function customTemplateOrigin(code: string): 'gallery' | 'local' {
  const parts = (code ?? '').split('_');
  if (parts.length === 3 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2])) return 'local';
  return 'gallery';
}

/**
 * Names a tag type seen in a container.
 *
 * Three outcomes, and keeping them distinct is the whole point: a known built-in code is named
 * outright; a cvt_ code is reported as a custom or gallery template with the lookup that resolves
 * it; and anything else is reported as UNKNOWN rather than guessed at. An audit that invents a
 * vendor name is worse than one that admits it does not recognise a code.
 */
export function identifyTagType(type: string): {
  code: string;
  name: string;
  known: boolean;
  scope?: 'web' | 'server' | 'legacy';
  origin?: 'gallery' | 'local';
  howToResolve?: string;
} {
  const code = (type ?? '').trim();
  if (!code) return { code, name: 'Unknown', known: false };

  for (const scope of ['web', 'server', 'legacy'] as const) {
    const hit = TAG_TYPES[scope].find((e) => e.code === code);
    if (hit) return { code, name: hit.name, known: true, scope };
  }

  if (code.startsWith('cvt_')) {
    const origin = customTemplateOrigin(code);
    const resolve =
      'Call templates_list for this workspace and match this exact string against each entry\'s ' +
      'tagType; that template\'s name is the real answer, and it comes from the container itself so ' +
      'it works for every custom template, published or not.';
    if (origin === 'local') {
      return {
        code,
        name: 'Custom template authored in this container',
        known: true,
        origin,
        // Worth separating: an in-house template is a maintenance question (who owns this code,
        // is it still correct) rather than a vendor question.
        howToResolve:
          `${resolve} This one was written in this container rather than installed from the ` +
          'gallery, so it has no publisher to look up and no upstream version to compare against.',
      };
    }
    return {
      code,
      name: 'Community Gallery template',
      known: true,
      origin,
      howToResolve:
        `${resolve} Then search that name with gtm_type_reference to find its publisher. If the ` +
        'search misses, the template is simply newer than the index snapshot; say so rather than ' +
        'calling it unknown.',
    };
  }

  return {
    code,
    name: 'Unknown tag type',
    known: false,
    howToResolve:
      'Not a code this server recognises. GTM ships native templates for many vendors whose codes ' +
      'Google does not publish, so this is very likely one of those rather than anything broken. ' +
      'Open the tag in the GTM interface to see its real name. Do NOT guess a vendor from the code.',
  };
}

/** Resolves a custom-template NAME against the gallery index, to name its publisher. */
export function identifyGalleryTemplate(templateName: string): { name: string; owner: string } | null {
  const q = (templateName ?? '').trim().toLowerCase();
  if (!q) return null;
  for (const [name, owner] of GALLERY_TEMPLATES) {
    if (name.toLowerCase() === q) return { name, owner };
  }
  return null;
}

const KINDS = ['all', 'tag', 'trigger', 'variable', 'gallery'] as const;

export function registerReferenceTools(server: McpServer): void {
  server.registerTool(
    'gtm_type_reference',
    {
      description:
        'The catalogue of GTM TYPE CODES: tag types, trigger types and user-defined variable types, ' +
        'each with the exact string the API expects and the name it carries in the GTM interface. ' +
        'Call this to ANSWER a question about what types exist ("which tag types do you support?", ' +
        '"what triggers can you make?", "can you add Hotjar?"), and to look up the right code BEFORE ' +
        'calling tags_create, triggers_create or variables_create. Read-only, no API call, no ' +
        'container needed. Note that Google publishes an enum for TRIGGER types but not for tag or ' +
        'variable types, so those codes are recorded here rather than discoverable from the API. ' +
        'For built-in variables use built_in_variables_list, which carries the full published enum. ' +
        'For a specific gallery template that is already installed, templates_list returns its exact ' +
        'tagType, which is always more reliable than this list.',
      inputSchema: z.object({
        kind: z
          .enum(KINDS)
          .optional()
          .describe('Narrow the answer to one kind. Defaults to "all".'),
        search: z
          .string()
          .optional()
          .describe(
            'Look a Community Gallery template up by product or vendor name, e.g. "hotjar", ' +
              '"clarity", "klaviyo". Returns the template name and its GitHub OWNER, which is the ' +
              'half of an import that cannot be guessed. Use this to answer "can you add X?".',
          ),
        identify: z
          .string()
          .optional()
          .describe(
            'Name a tag type code seen in a container, e.g. "baut", "gclidw", "cvt_MRQN8". Use this ' +
              'when AUDITING a container to say what a tag actually is. Returns the human name, or ' +
              'says plainly that the code is unrecognised instead of guessing a vendor.',
          ),
      }),
    },
    async ({ kind, search, identify }) => {
      try {
        if (identify && identify.trim()) {
          return jsonResult(identifyTagType(identify));
        }

        // A search is a specific question, so answer only that rather than burying the hit in the
        // whole catalogue.
        if (search && search.trim()) {
          const matches = searchGallery(search);
          return jsonResult({
            query: search,
            matches,
            count: matches.length,
            truncated: matches.length === MAX_GALLERY_MATCHES,
            snapshotDate: GALLERY_SNAPSHOT_DATE,
            note:
              matches.length === 0
                ? 'No template of that name in this snapshot of the gallery. That means NOT FOUND HERE, not ' +
                  'unavailable: the gallery changes constantly. Check the gallery directly before telling the ' +
                  'user it does not exist.'
                : 'These give the OWNER only. templates_import_from_gallery also needs the REPOSITORY, which is ' +
                  'on the template page in the gallery. Do not invent one: a wrong pair returns a bare 404 that ' +
                  'looks like the template does not exist. After importing, use the tagType it returns as the ' +
                  'type for tags_create.',
          });
        }

        const want = kind ?? 'all';
        const body: Record<string, unknown> = {};

        if (want === 'all' || want === 'tag') {
          body['tagTypes'] = TAG_TYPES;
          body['nativeVendorsWithoutPublishedCodes'] = NATIVE_VENDORS;
          body['nativeVendorNote'] =
            'GTM ships a native template for each of these vendors, but Google does not publish the ' +
            'type code for them and no reliable third-party list exists. So if you meet an ' +
            'unrecognised code it is probably one of these. Pass it to this tool as `identify`, and ' +
            'never guess the vendor from the letters in the code.';
          body['tagTypeNote'] =
            'Tag.type is a FREE STRING in the API, so this list is the well-known set rather than a ' +
            'closed enum: any type GTM accepts works, including every gallery template as cvt_<id>. ' +
            'There is no "ga4" type; GA4 events are "gaawe".';
        }
        if (want === 'all' || want === 'trigger') {
          body['triggerTypes'] = TRIGGER_TYPES;
          body['triggerTypeNote'] =
            'This is the complete published enum. The live API uses these camelCase values; an ' +
            'exported container writes the same ones as UPPER_SNAKE, so do not copy a type straight ' +
            'from an export into an API call.';
        }
        if (want === 'all' || want === 'variable') {
          body['variableTypes'] = VARIABLE_TYPES;
          body['variableTypeNote'] =
            'User-defined variables only. For BUILT-IN variables (Page URL, Click Text, Form ID and ' +
            'the rest) call built_in_variables_list, and enable them with built_in_variables_enable.';
        }
        if (want === 'all' || want === 'gallery') {
          body['galleryCategories'] = GALLERY_CATEGORIES;
          body['galleryIndexed'] = GALLERY_TEMPLATES.length;
          body['gallerySnapshotDate'] = GALLERY_SNAPSHOT_DATE;
          body['galleryNote'] =
            `${GALLERY_TEMPLATES.length} templates are indexed by name and GitHub owner as of ` +
            `${GALLERY_SNAPSHOT_DATE}. Do NOT ask for them all: call this tool again with ` +
            '`search` set to the product or vendor name to look one up. The categories above are ' +
            'just the shape of what is in there. The index carries the OWNER, not the REPOSITORY, ' +
            'so read the repository off the template page in the gallery before importing.';
        }

        return jsonResult(body);
      } catch (err) {
        return errorResult('gtm_type_reference', err);
      }
    },
  );
}
