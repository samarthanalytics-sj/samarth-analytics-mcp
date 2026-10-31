/**
 * A minimal DOM for running the in-page extractors (extractFormsInPage, collectPageInBrowser,
 * gatherCtaFacts) in plain Node. Those functions are stringified into the scanned page, so the only
 * other way to exercise them is a real browser, and CI installs none: a regression in them would pass
 * CI unseen. This is test scaffolding, not a DOM: it implements just what those functions touch.
 *
 *  - The tree is built with el(); text children are plain strings.
 *  - Selectors: compound selectors only (tag, *, #id, .class, [attr], [attr=|*=|^=|$=|~= "v" i], :not())
 *    and comma lists. A combinator or anything else throws, so a test can never silently match wrong.
 *  - Layout comes from the test: each element's viewport rect, computed-style overrides, client border.
 *  - Frames: an <iframe> given a contentDocument is linked as that document's window.frameElement.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ElOpts {
  /** getBoundingClientRect, relative to the owning document's viewport. Default 100x20 at (0, 0). */
  rect?: Box;
  /** getComputedStyle overrides (display, visibility, paddingTop, ...). */
  style?: Record<string, string>;
  clientLeft?: number;
  clientTop?: number;
  /** For an <iframe>: the framed (same-origin) document. */
  contentDocument?: MiniDocument;
}

type Child = MiniElement | string;

// ── selectors ──────────────────────────────────────────────────────────────────────────────────────────

interface AttrSel {
  name: string;
  op: string;
  value: string;
  ci: boolean;
}
interface Compound {
  tag: string | null;
  ids: string[];
  classes: string[];
  attrs: AttrSel[];
  nots: Compound[][];
}

function splitTop(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of sel) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** The index just past the bracket that closes the one at `start`, skipping quoted text. */
function closeOf(s: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quote = '';
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i + 1;
  }
  throw new Error(`mini-dom: unbalanced selector "${s}"`);
}

const ATTR_RE = /^\[\s*([\w-]+)\s*(?:([*^$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*(i)?)?\s*\]$/i;
const IDENT_RE = /^[\w-]+/;

function parseCompound(raw: string): Compound {
  const s = raw.trim();
  const c: Compound = { tag: null, ids: [], classes: [], attrs: [], nots: [] };
  let i = 0;
  const lead = /^(\*|[a-zA-Z][\w-]*)/.exec(s);
  if (lead) {
    c.tag = lead[1];
    i = lead[1].length;
  }
  while (i < s.length) {
    const rest = s.slice(i);
    if (rest[0] === '#' || rest[0] === '.') {
      const m = IDENT_RE.exec(rest.slice(1));
      if (!m) break;
      (rest[0] === '#' ? c.ids : c.classes).push(m[0]);
      i += 1 + m[0].length;
    } else if (rest[0] === '[') {
      const end = closeOf(rest, 0, '[', ']');
      const m = ATTR_RE.exec(rest.slice(0, end));
      if (!m) break;
      c.attrs.push({ name: m[1].toLowerCase(), op: m[2] ?? '', value: m[3] ?? m[4] ?? m[5] ?? '', ci: !!m[6] });
      i += end;
    } else if (rest.toLowerCase().startsWith(':not(')) {
      const end = closeOf(rest, 4, '(', ')');
      c.nots.push(splitTop(rest.slice(5, end - 1)).map(parseCompound));
      i += end;
    } else {
      break;
    }
  }
  if (i !== s.length || s.length === 0) throw new Error(`mini-dom: unsupported selector "${raw}"`);
  return c;
}

const parsed = new Map<string, Compound[]>();
function parseList(sel: string): Compound[] {
  let list = parsed.get(sel);
  if (!list) {
    list = splitTop(sel).map(parseCompound);
    parsed.set(sel, list);
  }
  return list;
}

function attrMatches(el: MiniElement, a: AttrSel): boolean {
  const raw = el.getAttribute(a.name);
  if (raw === null) return false;
  if (!a.op) return true;
  const v = a.ci ? raw.toLowerCase() : raw;
  const want = a.ci ? a.value.toLowerCase() : a.value;
  switch (a.op) {
    case '=':
      return v === want;
    case '*=':
      return want !== '' && v.includes(want);
    case '^=':
      return want !== '' && v.startsWith(want);
    case '$=':
      return want !== '' && v.endsWith(want);
    case '~=':
      return v.split(/\s+/).includes(want);
    default:
      throw new Error(`mini-dom: unsupported attribute operator "${a.op}"`);
  }
}

function compoundMatches(el: MiniElement, c: Compound): boolean {
  if (c.tag && c.tag !== '*' && el.tagName !== c.tag.toUpperCase()) return false;
  if (c.ids.some((id) => el.getAttribute('id') !== id)) return false;
  const classes = (el.getAttribute('class') || '').split(/\s+/);
  if (c.classes.some((cls) => !classes.includes(cls))) return false;
  if (!c.attrs.every((a) => attrMatches(el, a))) return false;
  return !c.nots.some((list) => list.some((n) => compoundMatches(el, n)));
}

// ── nodes ──────────────────────────────────────────────────────────────────────────────────────────────

const FORM_CONTROLS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

export class MiniElement {
  readonly tagName: string;
  parentElement: MiniElement | null = null;
  ownerDocument!: MiniDocument;
  readonly childNodes: Child[];
  private readonly attrs = new Map<string, string>();

  constructor(tag: string, attrs: Record<string, string>, children: Child[], readonly opts: ElOpts) {
    this.tagName = tag.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k.toLowerCase(), v);
    this.childNodes = children;
    for (const ch of children) if (ch instanceof MiniElement) ch.parentElement = this;
  }

  get children(): MiniElement[] {
    return this.childNodes.filter((c): c is MiniElement => c instanceof MiniElement);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name.toLowerCase()) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name.toLowerCase(), String(value));
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name.toLowerCase());
  }

  // Reflected IDL properties the extractors read.
  get id(): string {
    return this.getAttribute('id') ?? '';
  }
  get name(): string {
    return this.getAttribute('name') ?? '';
  }
  get placeholder(): string {
    return this.getAttribute('placeholder') ?? '';
  }
  get autocomplete(): string {
    return this.getAttribute('autocomplete') ?? '';
  }
  get required(): boolean {
    return this.hasAttribute('required');
  }
  get checked(): boolean {
    return this.hasAttribute('checked');
  }
  get value(): string {
    return this.getAttribute('value') ?? '';
  }
  get type(): string | undefined {
    const t = (this.getAttribute('type') ?? '').toLowerCase();
    if (this.tagName === 'INPUT') return t || 'text';
    if (this.tagName === 'BUTTON') return t || 'submit';
    if (this.tagName === 'TEXTAREA') return 'textarea';
    if (this.tagName === 'SELECT') return 'select-one';
    return undefined;
  }
  get form(): MiniElement | null | undefined {
    return FORM_CONTROLS.has(this.tagName) ? this.closest('form') : undefined;
  }
  get options(): MiniElement[] | undefined {
    return this.tagName === 'SELECT' ? this.querySelectorAll('option') : undefined;
  }
  get href(): string {
    const h = this.getAttribute('href');
    return h === null ? '' : new URL(h, this.ownerDocument.location.href).href;
  }
  get src(): string {
    const s = this.getAttribute('src');
    return s === null ? '' : new URL(s, this.ownerDocument.location.href).href;
  }
  get classList(): string[] {
    return (this.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  }
  get textContent(): string {
    return this.childNodes.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  get innerText(): string {
    return this.textContent;
  }
  get contentDocument(): MiniDocument | null {
    return this.opts.contentDocument ?? null;
  }
  get clientLeft(): number {
    return this.opts.clientLeft ?? 0;
  }
  get clientTop(): number {
    return this.opts.clientTop ?? 0;
  }

  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number; x: number; y: number } {
    const b = this.opts.rect ?? { x: 0, y: 0, w: 100, h: 20 };
    return { left: b.x, top: b.y, right: b.x + b.w, bottom: b.y + b.h, width: b.w, height: b.h, x: b.x, y: b.y };
  }

  closest(sel: string): MiniElement | null {
    const list = parseList(sel);
    for (let n: MiniElement | null = this; n; n = n.parentElement) {
      if (list.some((c) => compoundMatches(n as MiniElement, c))) return n;
    }
    return null;
  }
  /** Descendants in document order (not the element itself). */
  descendants(): MiniElement[] {
    const out: MiniElement[] = [];
    const walk = (n: MiniElement): void => {
      for (const c of n.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelectorAll(sel: string): MiniElement[] {
    const list = parseList(sel);
    return this.descendants().filter((n) => list.some((c) => compoundMatches(n, c)));
  }
  querySelector(sel: string): MiniElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  contains(other: MiniElement | null): boolean {
    for (let n = other; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  /** DOCUMENT_POSITION_FOLLOWING (4) / PRECEDING (2), plus CONTAINED_BY (16) / CONTAINS (8). */
  compareDocumentPosition(other: MiniElement): number {
    if (other === this) return 0;
    const order = this.ownerDocument.all();
    const follows = order.indexOf(other) > order.indexOf(this);
    if (this.contains(other)) return 16 | 4;
    if (other.contains(this)) return 8 | 2;
    return follows ? 4 : 2;
  }
}

export interface MiniWindow {
  document: MiniDocument;
  scrollX: number;
  scrollY: number;
  innerWidth: number;
  innerHeight: number;
  frameElement: MiniElement | null;
  parent: MiniWindow;
  getComputedStyle(el: MiniElement): Record<string, string>;
}

const BASE_STYLE: Record<string, string> = {
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  backgroundColor: 'rgba(0, 0, 0, 0)',
  paddingLeft: '0px',
  paddingRight: '0px',
  paddingTop: '0px',
  paddingBottom: '0px',
  borderTopWidth: '0px',
  borderTopStyle: 'none',
};

export class MiniDocument {
  readonly defaultView: MiniWindow;
  readonly location: { href: string };

  constructor(
    readonly documentElement: MiniElement,
    view: { url?: string; scrollX?: number; scrollY?: number; innerWidth?: number; innerHeight?: number } = {},
  ) {
    this.location = { href: view.url ?? 'https://acme.example/' };
    const win: MiniWindow = {
      document: this,
      scrollX: view.scrollX ?? 0,
      scrollY: view.scrollY ?? 0,
      innerWidth: view.innerWidth ?? 1366,
      innerHeight: view.innerHeight ?? 900,
      frameElement: null,
      parent: undefined as unknown as MiniWindow,
      getComputedStyle: (el: MiniElement) => ({ ...BASE_STYLE, ...(el.opts.style ?? {}) }),
    };
    win.parent = win;
    this.defaultView = win;
    for (const n of this.all()) {
      n.ownerDocument = this;
      const framed = n.opts.contentDocument;
      if (n.tagName === 'IFRAME' && framed) {
        framed.defaultView.frameElement = n;
        framed.defaultView.parent = win;
      }
    }
  }

  /** Every element in document order, the root included. */
  all(): MiniElement[] {
    return [this.documentElement, ...this.documentElement.descendants()];
  }
  get body(): MiniElement | null {
    return this.documentElement.children.find((c) => c.tagName === 'BODY') ?? null;
  }
  querySelectorAll(sel: string): MiniElement[] {
    const list = parseList(sel);
    return this.all().filter((n) => list.some((c) => compoundMatches(n, c)));
  }
  querySelector(sel: string): MiniElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  getElementById(id: string): MiniElement | null {
    return this.all().find((n) => n.getAttribute('id') === id) ?? null;
  }
}

export function el(tag: string, attrs: Record<string, string> = {}, children: Child[] = [], opts: ElOpts = {}): MiniElement {
  return new MiniElement(tag, attrs, children, opts);
}

/** A document whose root is `<html attrs><body bodyAttrs>...children</body></html>`. */
export function miniPage(
  children: Child[],
  over: { html?: Record<string, string>; body?: Record<string, string>; view?: ConstructorParameters<typeof MiniDocument>[1] } = {},
): MiniDocument {
  return new MiniDocument(el('html', over.html ?? {}, [el('body', over.body ?? {}, children)]), over.view);
}

/**
 * Run `fn` with `doc` installed as the page's globals (document, window, getComputedStyle, location,
 * CSS), then put the previous globals back. Synchronous only: the extractors are.
 */
export function inPage<T>(doc: MiniDocument, fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const view = doc.defaultView;
  const globals: Record<string, unknown> = {
    document: doc,
    window: view,
    location: doc.location,
    getComputedStyle: view.getComputedStyle,
    CSS: { escape: (s: string) => s.replace(/["\\]/g, '\\$&') },
  };
  const saved = Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  for (const [k, value] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete g[k];
    }
  }
}
