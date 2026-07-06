// A composite scraping engine: run several PageDrivers on each page and MERGE
// their results — a detection found by more than one engine is kept ONCE, a
// detection unique to one engine is still kept. This unions coverage across
// complementary engines (Electron renders JS + same-origin iframes; Cheerio sees
// the raw server HTML) without the user having to pick one.
//
// It is itself a PageDriver, so crawlAndSuggest (driver-injected) is unchanged.

import type { PageDriver, DrivenPage } from './scan-core';
import type { ScanDebug } from '../../shared/ipc';
import type { RawElement } from '../../../../web-audit-mcp/src/agent/tag-suggest/collect.js';
import type { RawForm } from '../../../../web-audit-mcp/src/agent/forms.js';

const elKey = (e: RawElement): string => `${e.tag}|${e.href}|${e.text}`.toLowerCase();
const formKey = (f: RawForm): string =>
  `${f.action}|${f.method}|${f.fields.map((x) => x.name || x.id || x.type).join(',')}`.toLowerCase();

/** Merge several per-page results into one, deduping elements + forms. */
export function mergeDriven(results: DrivenPage[]): DrivenPage {
  const ok = results.filter((r) => r.ok);
  if (ok.length === 0) {
    return results.find((r) => r.error) ?? { ok: false, httpStatus: null, finalUrl: null, error: 'all engines failed' };
  }
  // Primary (drives status/finalUrl): the first engine that actually read content.
  const primary = ok.find((r) => r.raw) ?? ok[0];

  const elements: RawElement[] = [];
  const seenEl = new Set<string>();
  const scriptSrcs = new Set<string>();
  const classNames = new Set<string>();
  const selectorsPresent = new Set<string>();
  const iframeSrcs = new Set<string>();
  const forms: RawForm[] = [];
  const seenForm = new Set<string>();

  for (const r of ok) {
    if (r.raw) {
      for (const e of r.raw.elements) {
        const k = elKey(e);
        if (!seenEl.has(k)) {
          seenEl.add(k);
          elements.push(e);
        }
      }
      for (const s of r.raw.signals.scriptSrcs) scriptSrcs.add(s);
      for (const c of r.raw.signals.classNames) classNames.add(c);
      for (const s of r.raw.signals.selectorsPresent) selectorsPresent.add(s);
      for (const s of r.raw.signals.iframeSrcs ?? []) iframeSrcs.add(s);
    }
    if (r.rawForms) {
      for (const f of r.rawForms) {
        const k = formKey(f);
        if (!seenForm.has(k)) {
          seenForm.add(k);
          forms.push({ ...f, index: forms.length });
        }
      }
    }
  }

  return {
    ok: true,
    httpStatus: primary.httpStatus,
    finalUrl: primary.finalUrl,
    raw: {
      elements,
      signals: { scriptSrcs: [...scriptSrcs].slice(0, 300), classNames: [...classNames].slice(0, 600), selectorsPresent: [...selectorsPresent], iframeSrcs: [...iframeSrcs].slice(0, 80) },
    },
    rawForms: forms,
  };
}

/** Wrap N drivers; open() runs them in parallel and merges, close() closes all. */
export function createMultiDriver(drivers: PageDriver[]): PageDriver {
  return {
    async open(url: string): Promise<DrivenPage> {
      const results = await Promise.all(
        drivers.map((d) =>
          d.open(url).catch(
            (e): DrivenPage => ({ ok: false, httpStatus: null, finalUrl: null, error: e instanceof Error ? e.message : String(e) }),
          ),
        ),
      );
      return mergeDriven(results);
    },
    diagnostics(): ScanDebug | undefined {
      const parts = drivers.map((d) => d.diagnostics?.()).filter((x): x is ScanDebug => Boolean(x));
      if (parts.length === 0) return undefined;
      return {
        driver: parts.map((p) => p.driver).join('+'),
        settleMode: parts[0].settleMode,
        pages: parts.flatMap((p) => p.pages),
        consoleErrors: parts.flatMap((p) => p.consoleErrors),
        pageErrors: parts.flatMap((p) => p.pageErrors),
      };
    },
    async close(): Promise<void> {
      await Promise.all(drivers.map((d) => d.close().catch(() => undefined)));
    },
  };
}
