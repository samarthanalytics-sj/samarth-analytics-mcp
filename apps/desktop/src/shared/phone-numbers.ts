// Phone-number detection, normalization and per-number planning for Google Ads call conversions.
//
// PURE + framework-free: no DOM, no network, no Electron. The scanner hands this module raw
// sightings (a tel: href, or a candidate found in visible text) and it returns the UNIQUE numbers,
// merged across pages, with a deterministic identity for each. Everything downstream - the chat
// tool, the implementation plan, the Ads conversion-action names, the GTM tag and trigger names -
// derives from that identity, so the same page always produces the same plan.
//
// Deliberately NO phone-number library. libphonenumber is ~500KB and would have to be bundled into
// the Electron main process for a feature that needs one thing: recognise the same number written
// several ways. The rules below cover E.164, international-prefixed and NANP-style numbers, and
// anything they cannot resolve is reported as unnormalized rather than guessed at. An honest
// "could not normalize" is worth more here than a confident wrong country code.
//
// House style: no em dashes anywhere in this file - every string here can reach the user.

/** Where a sighting came from. A tel: link is CLICKABLE (a GTM click trigger can fire on it);
 *  visible text is not, which changes what can be implemented for it. */
export type PhoneSource = 'tel_link' | 'text';

/** One raw observation of a phone number on one page. */
export interface RawPhoneSighting {
  /** Exactly as seen (href value or the matched text), for evidence and display. */
  raw: string;
  source: PhoneSource;
  /** The page URL it was seen on. */
  page: string;
  /** Link text or nearby label, when there is one. */
  label?: string;
  /** Page region (header / footer / main), when the scanner knows it. */
  region?: string;
}

export interface NormalizedPhone {
  /** E.164 ("+15551234567") when it could be derived WITHOUT guessing a country, else null. */
  e164: string | null;
  /** Digits only, no plus, no extension. The merge key's basis. */
  digits: string;
  /** True when e164 is present and came from an explicit international form. */
  confident: boolean;
  /** Why normalization stopped short, when it did. */
  reason?: string;
}

/** ITU E.164 allows at most 15 digits; fewer than 7 is not a dialable subscriber number. */
const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

/** Strip a tel: href down to the dialable part: drop the scheme, any ;ext=/;phone-context suffix,
 *  and URL escaping. Returns null when the href is not a tel: link. */
export function phoneFromTelHref(href: string): string | null {
  const h = String(href ?? '').trim();
  if (!/^tel:/i.test(h)) return null;
  let v = h.slice(4);
  try {
    v = decodeURIComponent(v);
  } catch {
    /* a malformed escape is not a reason to drop the number - use it as-is */
  }
  // ;ext=123, ;phone-context=+1, and a trailing ,,123 pause sequence are all dialing metadata.
  v = v.split(';')[0].split(',')[0].trim();
  return v || null;
}

/** Everything after an extension marker is NOT part of the subscriber number. Kept out of the
 *  digits so "555-1234 ext 9" and "555-1234" are recognised as the same line. */
// "x22" has no word boundary between the x and the digits, so the marker alternatives cannot all be
// \b-anchored on both sides: ext/extension/poste/durchwahl are whole words, bare x is a prefix.
const EXT_RE = /(?:\b(?:ext|extension|poste|durchwahl)\b|\bx)\.?\s*\d+\s*$/i;

/**
 * Normalize one raw phone string.
 *
 * The country is NEVER guessed. A bare 10-digit number is +1 only when the caller supplies a NANP
 * default (which the pipeline derives from other, explicitly international numbers on the same
 * site), because assuming +1 for a UK or Indian number would produce a conversion action wired to
 * the wrong line and no error anywhere.
 */
export function normalizePhone(raw: string, defaultCountry?: 'US' | 'CA' | null): NormalizedPhone {
  const input = String(raw ?? '').trim();
  const withoutExt = input.replace(EXT_RE, '').trim();
  // "00" is the international access prefix in most of the world; treat it exactly like "+".
  const international = /^\+/.test(withoutExt) || /^00\d/.test(withoutExt);
  const digits = withoutExt.replace(/\D/g, '').replace(/^00/, international && /^00\d/.test(withoutExt) ? '' : '');

  if (digits.length < MIN_DIGITS) {
    return { e164: null, digits, confident: false, reason: `Only ${digits.length} digits, too short to be a dialable number.` };
  }
  if (digits.length > MAX_DIGITS) {
    return { e164: null, digits, confident: false, reason: `${digits.length} digits exceeds the E.164 maximum of ${MAX_DIGITS}.` };
  }
  if (international) {
    return { e164: `+${digits}`, digits, confident: true };
  }
  // No country code in the string itself. Only a supplied NANP default can complete it.
  const nanp = defaultCountry === 'US' || defaultCountry === 'CA';
  if (nanp && digits.length === 10) return { e164: `+1${digits}`, digits: `1${digits}`, confident: false };
  if (nanp && digits.length === 11 && digits.startsWith('1')) return { e164: `+${digits}`, digits, confident: false };
  return {
    e164: null,
    digits,
    confident: false,
    reason: 'No country code, and none could be inferred from the rest of the page, so this number cannot be written in E.164.',
  };
}

/**
 * Pull phone-number candidates out of visible page text.
 *
 * Conservative on purpose. Page text is full of digit runs that are not phone numbers (prices, SKUs,
 * dates, order ids, addresses), and a false positive here becomes a live Google Ads conversion
 * action wired to nothing. So a candidate must LOOK like a phone number: an explicit country code,
 * or grouping punctuation, and it must not be embedded in a longer digit run or in a date.
 */
export function extractPhonesFromText(text: string): string[] {
  const src = String(text ?? '');
  if (!src) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // A candidate: optional +CC, then 7..20 characters of digits and phone punctuation. Anchored on
  // both sides by a non-digit so a match can never be a slice of a longer run.
  const RE = /(?<![\d])(\+?\d[\d\s().-]{5,20}\d)(?![\d])/g;
  for (const m of src.matchAll(RE)) {
    const candidate = m[1].trim();
    const digits = candidate.replace(/\D/g, '');
    if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) continue;
    // An ISO date, a version string or a decimal number is never a phone number.
    if (/^\d{4}-\d{2}-\d{2}/.test(candidate) || /\d\.\d/.test(candidate)) continue;
    // Require SOME phone shape: a country code, or grouping punctuation. A bare 9-digit run in
    // prose is far more often an id than a number worth spending ad budget on.
    const hasCountryCode = /^\+/.test(candidate);
    const hasGrouping = /[\s().-]/.test(candidate);
    if (!hasCountryCode && !hasGrouping) continue;
    // Long unbroken runs with no country code (order numbers, IMEIs) are rejected for the same reason.
    if (!hasCountryCode && digits.length > 12) continue;
    // Reject the surrounding-context giveaways: currency before, percent/unit after.
    const before = src.slice(Math.max(0, m.index - 2), m.index);
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 2);
    if (/[$£€¥₹]\s?$/.test(before)) continue;
    if (/^\s?%/.test(after)) continue;
    const key = digits;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

/** One unique phone number, merged across every page and every way it was written. */
export interface UniquePhone {
  /** Stable identity: the E.164 form when known, else "digits:<digits>". Deterministic. */
  key: string;
  e164: string | null;
  /** Best human form: E.164 when known, else the longest raw sighting. */
  display: string;
  digits: string;
  /** True when at least one sighting was a tel: link, which is what a GTM click trigger needs. */
  clickable: boolean;
  sources: PhoneSource[];
  /** Every page it appeared on, sorted, deduped. */
  pages: string[];
  /** Distinct link texts / labels, for naming and for the user to recognise it. */
  labels: string[];
  /** Total sightings across all pages. */
  occurrences: number;
  /** Every distinct way it was written, for the evidence line. */
  variants: string[];
  confident: boolean;
  note?: string;
}

/** Two numbers are the same line when one's digits end with the other's and the shorter form is a
 *  plausible subscriber number. This is what merges "+1 555 123 4567" with "(555) 123-4567". */
const sameLine = (a: string, b: string): boolean => {
  if (a === b) return true;
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  return short.length >= 10 && long.endsWith(short);
};

/**
 * Merge raw sightings into unique numbers.
 *
 * DETERMINISTIC: sightings are ordered before clustering (most complete form first, then
 * lexicographically), so the same page always produces the same clusters, the same canonical form
 * and the same order out. A plan built twice is byte-identical, which is what makes it safe to
 * show the user a plan and then act on it.
 *
 * The NANP default is DERIVED, not assumed: if the page carries any explicit +1 number, bare
 * 10-digit numbers on that same page are treated as +1 too. A site with no international evidence
 * leaves them unnormalized rather than guessing.
 */
export function mergePhoneSightings(sightings: readonly RawPhoneSighting[], opts: { defaultCountry?: 'US' | 'CA' | null } = {}): UniquePhone[] {
  // A tel_link sighting carries the whole href. Reduce it to the dialable part FIRST: "tel:+1555..."
  // has no leading "+", so normalizing the href verbatim would lose the country code and turn every
  // clickable number into an unnormalized one.
  const dialable = (s: RawPhoneSighting): string => phoneFromTelHref(s.raw) ?? s.raw;
  const parsed = sightings
    .map((s) => ({ s, value: dialable(s) }))
    .map((x) => ({ ...x, n: normalizePhone(x.value, null) }))
    .filter((x) => x.n.digits.length >= MIN_DIGITS && x.n.digits.length <= MAX_DIGITS);

  // Derive the country default from explicit evidence on the same site.
  const explicitNanp = parsed.some((x) => x.n.confident && x.n.digits.startsWith('1') && x.n.digits.length === 11);
  const country = opts.defaultCountry ?? (explicitNanp ? 'US' : null);

  // Re-normalize with the derived default, then order for deterministic clustering.
  const ordered = parsed
    .map((x) => ({ ...x, n: normalizePhone(x.value, country) }))
    .sort((a, b) =>
      b.n.digits.length - a.n.digits.length ||
      a.n.digits.localeCompare(b.n.digits) ||
      a.s.page.localeCompare(b.s.page) ||
      a.value.localeCompare(b.value));

  interface Cluster {
    digits: string;
    e164: string | null;
    confident: boolean;
    clickable: boolean;
    sources: Set<PhoneSource>;
    pages: Set<string>;
    labels: Set<string>;
    variants: Set<string>;
    occurrences: number;
  }
  const clusters: Cluster[] = [];
  for (const { s, n, value } of ordered) {
    let c = clusters.find((x) => sameLine(x.digits, n.digits));
    if (!c) {
      c = { digits: n.digits, e164: n.e164, confident: n.confident, clickable: false, sources: new Set(), pages: new Set(), labels: new Set(), variants: new Set(), occurrences: 0 };
      clusters.push(c);
    }
    // The most complete form wins as canonical: a later +1 sighting upgrades a bare 10-digit cluster.
    if (n.digits.length > c.digits.length) c.digits = n.digits;
    if (n.e164 && (!c.e164 || n.confident)) { c.e164 = n.e164; }
    c.confident = c.confident || n.confident;
    if (s.source === 'tel_link') c.clickable = true;
    c.sources.add(s.source);
    c.pages.add(s.page);
    if (s.label && s.label.trim()) c.labels.add(s.label.trim().slice(0, 80));
    c.variants.add(value.trim().slice(0, 40));
    c.occurrences += 1;
  }

  return clusters
    .map((c): UniquePhone => {
      const display = c.e164 ?? [...c.variants].sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? c.digits;
      const textOnly = !c.clickable;
      return {
        key: c.e164 ?? `digits:${c.digits}`,
        e164: c.e164,
        display,
        digits: c.digits,
        clickable: c.clickable,
        sources: [...c.sources].sort(),
        pages: [...c.pages].sort(),
        labels: [...c.labels].sort(),
        occurrences: c.occurrences,
        variants: [...c.variants].sort(),
        confident: c.confident,
        ...(textOnly || !c.e164
          ? {
              note: [
                textOnly ? 'Seen only as visible text, never as a tel: link, so no click event exists to fire a tag on.' : '',
                !c.e164 ? 'No country code could be established, so this number is not in E.164 form.' : '',
              ].filter(Boolean).join(' '),
            }
          : {}),
      };
    })
    // Deterministic output order: clickable first (they are implementable), then by key.
    .sort((a, b) => Number(b.clickable) - Number(a.clickable) || a.key.localeCompare(b.key));
}

// ── Deterministic naming ────────────────────────────────────────────────────────────────────

/** A filename-safe, stable slug for one number: the E.164 digits, or the raw digits. Two runs over
 *  the same page produce the same slug, which is what makes re-running the plan idempotent. */
export function phoneSlug(p: Pick<UniquePhone, 'e164' | 'digits'>): string {
  return p.e164 ? p.e164.replace(/^\+/, '') : p.digits;
}

/** The three names one phone number's implementation uses. Derived ONLY from the number (plus an
 *  optional label), never from scan order, so a re-scan reuses the same resources instead of
 *  creating parallel duplicates. */
export function phoneConversionNames(p: Pick<UniquePhone, 'e164' | 'digits' | 'display' | 'labels'>): {
  actionName: string;
  tagName: string;
  triggerName: string;
} {
  // A human label helps the user recognise the action in the Google Ads UI, but the NUMBER is what
  // makes the name unique - two lines labelled "Call us" must never collide.
  const label = (p.labels?.[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
  const suffix = label && !/^\+?[\d\s().-]+$/.test(label) ? ` (${label})` : '';
  const shown = p.e164 ?? p.display;
  return {
    actionName: `Phone call - ${shown}${suffix}`,
    tagName: `Google Ads - Phone Call - ${shown}`,
    triggerName: `Phone Click - ${shown} Trigger`,
  };
}

// ── The implementation plan ─────────────────────────────────────────────────────────────────

/** How one number will be tracked, decided from what the scan actually found. */
export type PhoneTrackingMethod =
  /** A tel: link exists: a click trigger scoped to THIS number plus a standard Ads conversion tag. */
  | 'click_to_call'
  /** Text only: there is no click to fire on. Needs a website-call (number swap) conversion action. */
  | 'website_call'
  /** Nothing can be implemented, and the plan says why instead of inventing a step. */
  | 'unsupported';

export interface PhoneConversionStep {
  phone: UniquePhone;
  method: PhoneTrackingMethod;
  /** The conversion action to reuse, when one already matches. */
  reuseActionId?: string;
  reuseActionName?: string;
  /** The action to create, when nothing matches. */
  createAction?: { name: string; category: string; type: 'WEBPAGE' | 'WEBSITE_CALL' };
  /** The GTM tag + trigger this number needs. Absent when the method is unsupported. */
  tag?: { name: string; platform: 'google_ads_conversion' | 'google_ads_call_conversion'; triggerName: string; clickUrlValue?: string; clickUrlOperator?: string; phoneNumber?: string };
  /** True when a tag carrying this number already exists in the container. */
  tagExists?: boolean;
  /** Why this number is handled the way it is, in plain words. */
  reason: string;
  blocked?: string;
}

export interface PhonePlanInput {
  phones: readonly UniquePhone[];
  /** Existing Ads conversion actions, as list_google_ads_conversion_actions returns them. */
  existingActions: ReadonlyArray<{ id: string; name: string; type?: string; category?: string; taggable: boolean; conversionId: string | null; conversionLabel: string | null }>;
  /** Existing GTM tag names in the working container (to detect an implementation already present). */
  existingTagNames: readonly string[];
  /** Whether the container already has a Conversion Linker (type gclidw). */
  hasConversionLinker: boolean;
  /** Whether creating WEBSITE_CALL actions is permitted in this session. OFF unless the caller
   *  opts in, because a website-call action changes how the number renders on the page. */
  allowWebsiteCall?: boolean;
}

export interface PhonePlan {
  steps: PhoneConversionStep[];
  /** Whether a Conversion Linker must be created (once for the whole container, not per number). */
  createConversionLinker: boolean;
  summary: { total: number; clickToCall: number; websiteCall: number; unsupported: number; reusingActions: number; creatingActions: number; tagsAlreadyPresent: number };
}

/** Does an existing conversion action already belong to this number? Matched on the DIGITS appearing
 *  in the action name, which is how this module names them, so a re-run reuses its own work. A name
 *  match is a strong hint, never a certainty, and the plan says so. */
function findExistingAction(p: UniquePhone, actions: PhonePlanInput['existingActions']): PhonePlanInput['existingActions'][number] | undefined {
  const digits = p.digits;
  const tail = digits.slice(-10);
  return actions.find((a) => {
    const nameDigits = String(a.name ?? '').replace(/\D/g, '');
    return nameDigits.length >= 10 && (nameDigits.includes(tail) || digits.includes(nameDigits.slice(-10)));
  });
}

/**
 * Build the complete, reviewable implementation plan. PURE: every decision comes from the inputs,
 * so the plan the user approves is exactly what the writes will do.
 */
export function buildPhoneConversionPlan(input: PhonePlanInput): PhonePlan {
  const steps: PhoneConversionStep[] = [];
  for (const p of input.phones) {
    const names = phoneConversionNames(p);
    const existing = findExistingAction(p, input.existingActions);
    const tagExists = input.existingTagNames.some((n) => n.replace(/\s+/g, ' ').trim() === names.tagName);

    if (p.clickable) {
      // The number is a tel: link: a click trigger scoped to it is exact, and a standard Google Ads
      // conversion tag fires on it. This is the fully supported path.
      const reusable = existing && existing.taggable && existing.conversionId && existing.conversionLabel;
      steps.push({
        phone: p,
        method: 'click_to_call',
        ...(reusable ? { reuseActionId: existing.id, reuseActionName: existing.name } : { createAction: { name: names.actionName, category: 'PHONE_CALL_LEAD', type: 'WEBPAGE' } }),
        tag: {
          name: names.tagName,
          platform: 'google_ads_conversion',
          triggerName: names.triggerName,
          // The trigger is scoped to THIS number's own tel: href, which is what makes each tag fire
          // only for its own line. contains (not equals) because the same line is written with and
          // without punctuation across a site.
          clickUrlValue: `tel:${p.e164 ?? p.digits}`,
          clickUrlOperator: 'contains',
        },
        tagExists,
        reason: existing && !reusable
          ? `An action named "${existing.name}" looks related but carries no usable conversion id and label, so a new one is needed.`
          : reusable
            ? 'A conversion action for this number already exists and will be reused.'
            : 'No conversion action matches this number, so one will be created.',
      });
      continue;
    }

    // Text only: there is no click event, so click-to-call cannot work. The honest alternatives are
    // a website-call (number swap) action, or nothing.
    if (!input.allowWebsiteCall) {
      steps.push({
        phone: p,
        method: 'unsupported',
        reason: 'This number appears only as visible text, so there is no click to fire a tag on.',
        blocked: 'Tracking it needs a website-call (number swap) conversion action, which is not enabled for this plan. Re-run with website-call tracking allowed, or turn the number into a tel: link on the site.',
      });
      continue;
    }
    const reusableCall = existing && existing.taggable && existing.conversionId && existing.conversionLabel && String(existing.type ?? '').toUpperCase() === 'WEBSITE_CALL';
    steps.push({
      phone: p,
      method: 'website_call',
      ...(reusableCall ? { reuseActionId: existing.id, reuseActionName: existing.name } : { createAction: { name: names.actionName, category: 'PHONE_CALL_LEAD', type: 'WEBSITE_CALL' } }),
      tag: {
        name: names.tagName,
        platform: 'google_ads_call_conversion',
        triggerName: 'All Pages',
        phoneNumber: p.e164 ?? p.display,
      },
      tagExists,
      reason: reusableCall
        ? 'A website-call conversion action for this number already exists and will be reused.'
        : 'This number is text only, so it will be tracked with a website-call (number swap) action: Google replaces the displayed number with a forwarding number and counts the call.',
    });
  }

  const summary = {
    total: steps.length,
    clickToCall: steps.filter((s) => s.method === 'click_to_call').length,
    websiteCall: steps.filter((s) => s.method === 'website_call').length,
    unsupported: steps.filter((s) => s.method === 'unsupported').length,
    reusingActions: steps.filter((s) => s.reuseActionId).length,
    creatingActions: steps.filter((s) => s.createAction).length,
    tagsAlreadyPresent: steps.filter((s) => s.tagExists).length,
  };
  return {
    steps,
    // The linker is a container-level prerequisite: needed once when anything at all will be tagged.
    createConversionLinker: !input.hasConversionLinker && steps.some((s) => s.method !== 'unsupported'),
    summary,
  };
}
