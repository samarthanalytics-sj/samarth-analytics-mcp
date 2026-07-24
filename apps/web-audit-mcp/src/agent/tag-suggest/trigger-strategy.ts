// WHICH GTM click condition to use for a detected interaction, and when one condition is not enough.
//
// The choice used to be implicit: the engine emitted {{Click Text}} for CTAs and {{Click URL}} for
// contact links because those were the fields it happened to have, not because they were the most
// durable signal available. An element carrying a clean semantic class (dealer-phone, book-a-demo)
// was tracked by its visible copy, which marketing edits without telling anyone.
//
// PURE + framework-free, so the ladder is testable without GTM or a browser.
//
// ── THE TWO FACTS THAT DRIVE EVERYTHING ─────────────────────────────────────────
//
// 1. WHAT THE CLICK VARIABLES REFER TO DEPENDS ON THE TRIGGER TYPE.
//    On "Just Links" (link_click) GTM resolves the click up to the <a>, so {{Click ID}},
//    {{Click Classes}} and {{Click URL}} describe the ANCHOR no matter which child was clicked.
//    On "All Elements" (all_clicks) they describe the EXACT node clicked, which for
//    `<button class="book-demo"><svg/><span>Book</span></button>` is the svg or the span - neither
//    carries `book-demo`, so a {{Click Classes}} condition silently never fires. For all_clicks the
//    descendant-safe form is {{Click Element}} matching the CSS selector `.book-demo, .book-demo *`.
//    This is the single biggest source of tags that look configured and collect nothing.
//
// 2. {{Click Classes}} IS THE WHOLE CLASS ATTRIBUTE, AS ONE STRING.
//    So `equals` is wrong whenever the element has more than one class, and `contains "btn"` also
//    matches `btn-primary`, `btn-lg` and `newsletter-btn`. The precise form is a word-boundary
//    regex, `(^|\s)btn(\s|$)`, which is what this module emits.
//
// ── THE LADDER ───────────────────────────────────────────────────────────────────
// Most durable first. The first rung that is present and distinctive wins.
//
//   1. Click ID       - an author deliberately named this element. Strongest signal there is.
//   2. Click Classes  - a SEMANTIC class. Rejected when it looks build-generated (looksGenerated)
//                       or is a generic wrapper (isGenericClass), because `.btn` fires everywhere.
//   3. Click URL      - durable for tel:/mailto:/outbound schemes; weaker for internal paths, which
//                       get reorganised; unavailable for a JS control with no href.
//   4. Click Text     - copy changes for marketing reasons without anyone thinking about analytics.
//                       Last resort, and page-scoped whenever it is not unique.
//
// ── WHEN ONE CONDITION IS NOT ENOUGH ─────────────────────────────────────────────
// GTM ANDs the conditions within a trigger. There is no OR inside a single trigger: an OR is
// expressed by attaching several triggers to the tag, or by one matchRegex alternation. A second
// condition is added only when the first is not unique on its own - a second semantic class to
// narrow a component family, or {{Page Path}} to cut a sitewide match down to the page that matters.
// Page-scoping is suppressed for header/footer components, where firing everywhere is correct.

export type ClickSignal = 'clickId' | 'clickClasses' | 'clickUrl' | 'clickText';

export interface TriggerCondition {
  /** GTM built-in variable, e.g. '{{Click Classes}}'. */
  variable: string;
  operator: 'equals' | 'contains' | 'startsWith' | 'endsWith' | 'matchRegex' | 'cssSelector';
  value: string;
  /** Why this condition is here, surfaced in the UI's trigger-strategy line. */
  because: string;
}

export interface ElementFacts {
  /** 'link_click' resolves to the anchor; 'all_clicks' reports the exact node clicked. */
  triggerKind: 'link_click' | 'all_clicks';
  id?: string;
  /** The class attribute, verbatim. */
  classes?: string;
  href?: string;
  text?: string;
  /** How many elements share the winning signal. >1 means a second condition is needed. */
  occurrences?: number;
  /** Page path the element was found on, for scoping. */
  page?: string;
  /** True for header/footer/nav components, which must keep firing sitewide. */
  sitewide?: boolean;
}

export interface StrategyResult {
  signal: ClickSignal | null;
  conditions: TriggerCondition[];
}

/** Layout/utility tokens (Tailwind, Bootstrap grid) - never identify an interaction. */
const UTILITY_RE = /^(flex|grid|block|inline|inline-block|hidden|relative|absolute|fixed|sticky|static|container|row|col|w|h|min|max|p[xytblr]?|m[xytblr]?|gap|space|items|justify|content|self|text|font|leading|tracking|bg|border|rounded|shadow|cursor|group|transition|duration|ease|transform|opacity|z|overflow|float|clear)([-:].*)?$/i;

/** Runtime STATE tokens. These toggle as the user interacts, so half the clicks would miss. */
const STATE_RE = /(^|[-_])(collapsed?|collapsing|open(ed)?|closed?|active|expanded|selected|current|show(n)?|hover|focus|disabled|loading)$/i;

/** Generic component wrappers. Real classes, but shared by every button/card on the site. */
const GENERIC_RE = /^(btn|button|card|cta|link|box|tile|wrap|wrapper|widget|module|component|block|content|section|nav|menu|header|footer|elementor|col|row|container|list|item|entry|node|field|group|inner|outer|main|body|title|label|icon|img|image|text|wpb|vc|e|el|ui|js)([-_].*)?$/i;

/** A plain CSS class identifier. A Tailwind arbitrary-variant token like `[&>svg]:rotate-180` is a
 *  valid attribute value but throws in querySelector, so it can never scope a trigger. */
const CSS_IDENT_RE = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Classes a build tool generated, which change without anyone deciding they should.
 *
 * Matching one produces a trigger that passes testing and dies at the next deploy, which is worse
 * than offering nothing: a tag that never fires looks correctly configured until someone checks the
 * data weeks later.
 */
export function looksGenerated(cls: string): boolean {
  const c = cls.trim();
  if (!c) return true;
  return (
    /^css-[a-z0-9]{5,}$/i.test(c) ||          // emotion / styled-jsx
    /^sc-[A-Za-z0-9]{6,}$/.test(c) ||         // styled-components
    /^jss\d+$/.test(c) ||                     // MUI v4
    /^[a-z]+_[a-z0-9]{5,}$/i.test(c) ||       // CSS modules: button_a1b2c3
    /^_[A-Za-z0-9]{5,}$/.test(c) ||           // leading-underscore hashes
    /^ng-tns-c\d/i.test(c) ||                 // Angular emulated-encapsulation scope
    /^_ng(content|host)-/i.test(c) ||
    /^ng-(star-inserted|untouched|touched|pristine|dirty|valid|invalid|submitted)$/i.test(c) ||
    /^v-[a-f0-9]{6,}$/i.test(c) ||            // Vue scope id
    /^wpgb-block-\d+$/.test(c) ||             // WP Grid Builder positional blocks
    /^elementor-element-[a-z0-9]{6,}$/i.test(c) ||
    /^et_pb_[a-z_]*\d+$/i.test(c) ||          // Divi positional modules
    /^[a-f0-9]{8,}$/i.test(c)                 // bare hashes
  );
}

/** Ids frameworks mint per render, no more durable than a generated class. */
export function looksGeneratedId(id: string): boolean {
  const v = id.trim();
  if (!v) return true;
  return (
    /^(react|mui|radix|headlessui|aria|downshift)-/i.test(v) ||
    /^[a-f0-9-]{20,}$/i.test(v) ||            // raw GUIDs
    /\d{6,}$/.test(v) ||                      // long numeric suffixes
    /^:r[a-z0-9]+:$/.test(v) ||               // React 18 useId
    !CSS_IDENT_RE.test(v)
  );
}

/** True for a wrapper/utility class that would fire on unrelated elements sitewide. */
export function isGenericClass(cls: string): boolean {
  return GENERIC_RE.test(cls) || UTILITY_RE.test(cls);
}

/**
 * The classes worth keying a trigger on: generated, utility, state and generic-wrapper tokens
 * removed. Ordered most-distinctive first (longest, then alphabetical) so the pick is stable across
 * runs regardless of the order the DOM happened to list them in.
 */
export function semanticClasses(classAttr: string | undefined): string[] {
  return (classAttr ?? '')
    .split(/\s+/)
    .map((c) => c.trim())
    .filter(
      (c) =>
        c.length >= 3 &&
        CSS_IDENT_RE.test(c) &&
        !looksGenerated(c) &&
        !isGenericClass(c) &&
        !STATE_RE.test(c),
    )
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/** Word-boundary regex for one class inside the {{Click Classes}} attribute string. */
export function classRegex(cls: string): string {
  return `(^|\\s)${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`;
}

const CONTACT_SCHEME_RE = /^(tel|mailto|sms|whatsapp):/i;

/**
 * Pick the click conditions for one detected interaction.
 *
 * Returns the conditions to AND together, most durable first, and the signal that won. An EMPTY
 * result means nothing durable was found: the caller must not invent a trigger, because a guessed
 * condition that never matches is indistinguishable from a working one until the data is audited.
 */
export function chooseClickConditions(el: ElementFacts): StrategyResult {
  const conditions: TriggerCondition[] = [];
  const shared = (el.occurrences ?? 1) > 1;
  const nested = el.triggerKind === 'all_clicks';

  const scopeToPage = (): void => {
    // Suppressed for sitewide components: page-scoping a header link would stop it firing on every
    // other page where it legitimately appears.
    if (el.page && !el.sitewide) {
      conditions.push({
        variable: '{{Page Path}}',
        operator: el.page.replace(/[^a-z0-9]/gi, '').length >= 3 ? 'contains' : 'equals',
        value: el.page,
        because: 'the signal above is not unique on its own, so the trigger is narrowed to the page this element was found on',
      });
    }
  };

  // 1. Click ID.
  if (el.id && !looksGeneratedId(el.id)) {
    conditions.push(
      nested
        ? {
            variable: '{{Click Element}}',
            operator: 'cssSelector',
            value: `#${el.id}, #${el.id} *`,
            because: 'the element has an author-given id; on an All Elements trigger it is matched as a CSS selector so a click on an inner icon or span still counts',
          }
        : {
            variable: '{{Click ID}}',
            operator: 'equals',
            value: el.id,
            because: 'the element has an author-given id, the most durable signal available',
          },
    );
    if (shared) scopeToPage();
    return { signal: 'clickId', conditions };
  }

  // 2. Click Classes.
  const sem = semanticClasses(el.classes);
  if (sem.length > 0) {
    const cls = sem[0];
    conditions.push(
      nested
        ? {
            variable: '{{Click Element}}',
            operator: 'cssSelector',
            value: `.${cls}, .${cls} *`,
            because: `".${cls}" is a semantic class; on an All Elements trigger it is matched as a CSS selector, because {{Click Classes}} would report the inner element's classes and never match`,
          }
        : {
            variable: '{{Click Classes}}',
            operator: 'matchRegex',
            value: classRegex(cls),
            because: `"${cls}" is a semantic class, which survives copy and URL changes; matched on a word boundary so it does not also fire on "${cls}-alt"`,
          },
    );
    // A second semantic class narrows a class shared across a component family; else scope by page.
    if (shared && sem.length > 1) {
      const second = sem[1];
      conditions.push(
        nested
          ? { variable: '{{Click Element}}', operator: 'cssSelector', value: `.${second}, .${second} *`, because: 'a second class narrows a component shared by several elements' }
          : { variable: '{{Click Classes}}', operator: 'matchRegex', value: classRegex(second), because: 'a second class narrows a component shared by several elements' },
      );
    } else if (shared) {
      scopeToPage();
    }
    return { signal: 'clickClasses', conditions };
  }

  // 3. Click URL. Durable for contact/outbound schemes, weaker for internal paths.
  if (el.href && CONTACT_SCHEME_RE.test(el.href)) {
    const scheme = (/^([a-z]+):/i.exec(el.href)?.[1] ?? '').toLowerCase();
    conditions.push({
      variable: '{{Click URL}}',
      operator: 'startsWith',
      value: `${scheme}:`,
      because: `a ${scheme}: link is identified by its scheme, which does not change with copy or layout`,
    });
    return { signal: 'clickUrl', conditions };
  }
  if (el.href && /^https?:\/\//i.test(el.href)) {
    let host = '';
    try {
      host = new URL(el.href).hostname;
    } catch {
      host = '';
    }
    if (host) {
      conditions.push({ variable: '{{Click URL}}', operator: 'contains', value: host, because: 'an outbound link is identified by its destination host' });
      return { signal: 'clickUrl', conditions };
    }
  }
  if (el.href) {
    conditions.push({ variable: '{{Click URL}}', operator: 'contains', value: el.href, because: 'an internal path is the only durable signal available; it breaks if the URL is reorganised' });
    if (shared) scopeToPage();
    return { signal: 'clickUrl', conditions };
  }

  // 4. Click Text. Last, because copy is edited without anyone thinking about analytics.
  const text = (el.text ?? '').replace(/\s+/g, ' ').trim();
  if (text) {
    conditions.push({
      variable: '{{Click Text}}',
      operator: 'equals',
      value: text,
      because: 'no id, semantic class or href was available, so the visible text is the only signal; it breaks if the copy is edited',
    });
    if (shared) scopeToPage();
    return { signal: 'clickText', conditions };
  }

  // Nothing durable. Say so rather than inventing a condition.
  return { signal: null, conditions: [] };
}

/** How brittle the chosen strategy is, for ranking and for the UI. */
export function strategyStability(r: StrategyResult): 'high' | 'medium' | 'low' | 'none' {
  if (!r.signal) return 'none';
  if (r.signal === 'clickId' || r.signal === 'clickClasses') return 'high';
  if (r.signal === 'clickUrl') return r.conditions[0]?.operator === 'startsWith' ? 'high' : 'medium';
  return 'low';
}

/** One line for the UI, explaining the trigger the way an operator would want it explained. */
export function describeStrategy(r: StrategyResult): string {
  if (!r.signal || r.conditions.length === 0) {
    return 'No durable click signal found (no id, no semantic class, no href, no stable text). A trigger built on what is here would break on the next deploy, so none is suggested.';
  }
  const parts = r.conditions.map((c) => `${c.variable} ${c.operator} "${c.value}"`);
  return `Fires when ${parts.join(' AND ')}. ${r.conditions[0].because}.`;
}
