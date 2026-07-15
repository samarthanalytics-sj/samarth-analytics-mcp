// IPC for the "GA4 Audit" panel: list GA4 properties (the picker) and run a
// READ-ONLY config + data-quality audit on a chosen property/window. Mirrors
// gtm-audit-ipc.ts, but GA4 has no fixes (every finding is advisory).

import { ipcMain, dialog, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import type { GoogleDataService } from './data-service';
import { auditGa4 } from './ga4-audit';
import { plainDashes } from './gtm-builders';
import { auditGa4DataQuality } from './ga4-data-quality';
import { buildGa4AuditReport, buildGa4ExecSummary, buildGa4Visuals, buildGa4Sections } from './ga4-report';
import { auditGa4Growth } from './ga4-growth';
import { rankGa4Campaigns } from './ga4-campaigns';
import { auditGa4EventDeltas, auditGa4Transactions } from './ga4-integrity';
import { auditGa4EventHygiene } from './ga4-event-hygiene';
import { auditGa4ParamMatrix } from './ga4-param-matrix';
import { auditGa4DeadDimensions } from './ga4-dead-dimensions';
import { auditGa4EventCoverage, ECOMMERCE_RECOMMENDED_EVENTS } from './ga4-event-coverage';
import { summarizeGa4Retention } from './ga4-retention';
import { reportHtmlDocument, dedupedReportPath } from './ga4-report-export';
import { execSummaryHtml } from '../../shared/ga4-exec-html';
import { ga4VisualsHtml, stripDuplicateCharts } from '../../shared/ga4-visuals-html';
import { ga4SectionsHtml } from '../../shared/ga4-sections-html';
import { withQuotaRetry } from './quota-retry';
import type { Ga4ExecSummaryView, Ga4PropertyAuditResult, Ga4PropertyListItem, Ga4VisualsView, Ga4SectionsView } from '../../shared/ipc';

// A prior download of the same report is often still open in a PDF/Word viewer, which locks the file so
// overwriting it fails with EBUSY/EPERM/EACCES. Rather than error, fall back to a fresh name
// ("report (1).pdf", "report (2).pdf", …) so a re-download always succeeds. Returns the path written.
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
async function writeReportFile(filePath: string, data: string | Uint8Array): Promise<string> {
  for (let i = 0; i <= 50; i++) {
    const target = dedupedReportPath(filePath, i);
    try {
      // Text exports (md/csv/doc-html) follow house style: plain hyphens, never em/en dashes.
      await writeFile(target, typeof data === 'string' ? plainDashes(data) : data);
      return target;
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (!LOCK_CODES.has(code) || i === 50) throw err;
      // locked → try the next suffixed name
    }
  }
  throw new Error('unreachable');
}

/** The FULL read-only audit pipeline (config + data quality + integrity + baseline + growth +
 *  campaigns + retention -> markdown/exec/visuals/sections), extracted from the IPC handler so the
 *  monitoring scheduler can run WEEKLY AUDITS with the exact same computation as the panel. `win`
 *  must already be validated (trailing days clamped, or a checked YYYY-MM-DD range). */
export async function runGa4AuditPipeline(
  data: GoogleDataService,
  p: string,
  win: number | { startDate: string; endDate: string }
): Promise<Ga4PropertyAuditResult> {
  const [snap, dqCounts] = await Promise.all([
    withQuotaRetry(() => data.getGa4PropertySnapshot(p)),
    withQuotaRetry(() => data.getGa4DataQuality(p, win)),
  ]);
  // Dead custom-dimension probe (best-effort, read-only): which registered dimensions receive no data
  // over a wide 90-day window. Fired here so it overlaps the enrichment queries below; its finding is
  // seeded into auditGa4 so the Custom-definitions area/summary/counts stay consistent. category
  // 'customdef' → feeds Event Tracking, never gates channel-attribution trust.
  const registeredDims = snap.customDimensions ?? [];
  const dimUsageP = registeredDims.length
    ? data.getGa4CustomDimensionUsage(p, registeredDims).catch(() => null)
    : Promise.resolve(null);
  // Weekly retention cohorts (best-effort): its OWN backward window, independent of the audit window,
  // so fire it here to overlap everything else. A headline is derived below.
  const retentionP = data.getGa4RetentionCohorts(p).catch(() => null);
  let dataQuality = auditGa4DataQuality(dqCounts);
  // Data-integrity (reporting data): per-event regressions (a key event dropped to 0 = broken tag)
  // and — for ecommerce properties — duplicate / unlabelled transactions (double-counted revenue).
  // Best-effort; a failed query just omits those findings. Merged into the data-quality findings so
  // they flow through the whole report; the "no issues" all-clear is dropped when a real one appears.
  const ecom = (snap.keyEvents ?? []).some((k) => /purchase|add_to_cart|begin_checkout|view_item|add_payment_info/i.test(k.eventName));
  const sd = dqCounts.startDate ?? '';
  const ed = dqCounts.endDate ?? '';
  const [deltas, txn, presentRec, paramSignals] = await Promise.all([
    sd && ed ? withQuotaRetry(() => data.getGa4EventDeltas(p, sd, ed)).catch(() => null) : Promise.resolve(null),
    ecom && sd && ed ? withQuotaRetry(() => data.getGa4Transactions(p, sd, ed)).catch(() => null) : Promise.resolve(null),
    // Which of GA4's recommended online-sales events are actually sent — for the coverage check. The
    // engine gates on observed anchor events, so this is safe to run on every property (a non-
    // ecommerce site simply returns none and gets no finding).
    sd && ed ? data.getGa4PresentEvents(p, sd, ed, ECOMMERCE_RECOMMENDED_EVENTS).catch(() => null) : Promise.resolve(null),
    // Predefined-signal readings for the event-parameter matrix (value/items/search_term coverage).
    // Best-effort like everything else - a failed read just omits those findings.
    sd && ed ? withQuotaRetry(() => data.getGa4EventParamSignals(p, sd, ed)).catch(() => null) : Promise.resolve(null),
  ]);
  const integrityFindings = [
    ...(deltas ? auditGa4EventDeltas({ events: deltas.events, keyEventNames: (snap.keyEvents ?? []).map((k) => k.eventName) }) : []),
    ...(txn ? auditGa4Transactions({ hasEcommerce: true, transactions: txn.transactions, notSetShare: txn.notSetShare }) : []),
    // Event-name HYGIENE over the same fetched deltas (no extra API calls): naming-convention
    // violations with exact renames, high-cardinality name families, key events that never fired.
    ...(deltas
      ? auditGa4EventHygiene({
          events: deltas.events,
          keyEventNames: (snap.keyEvents ?? []).map((k) => k.eventName),
          // The deltas query caps at 500 rows per window - at the cap, absence is not evidence.
          possiblyTruncated: deltas.events.length >= 500,
          windowDays: dqCounts.windowDays,
        })
      : []),
    // Event-PARAMETER matrix: required vs present vs missing per recommended event, grounded in the
    // predefined API signals (eventValue, items* metrics, searchTerm) - honest not-verifiable rows
    // for parameters the API cannot see.
    ...(paramSignals
      ? auditGa4ParamMatrix({
          ...paramSignals,
          txnNotSetShare: txn?.notSetShare ?? null,
          registeredParams: (snap.customDimensions ?? []).map((d) => d.parameterName),
        })
      : []),
  ];
  if (integrityFindings.length) {
    const base = dataQuality.findings.filter((f) => !(f.severity === 'info' && /No major data-quality issues/.test(f.message)));
    dataQuality = { ...dataQuality, findings: [...base, ...integrityFindings] };
  }
  // Best-effort enrichments for the report doc — a failure just degrades that section to
  // Not Verified, it never fails the audit (config + data quality always return).
  const baseline = await withQuotaRetry(() => data.getGa4Baseline(p, dqCounts.startDate ?? '', dqCounts.endDate ?? '')).catch(() => null);
  const attribution = await data.getGa4AttributionSettings(p).catch(() => null);
  const audienceList = await data.listGa4Audiences(p).catch(() => null);
  const audienceCount = audienceList === null ? null : audienceList.length;
  // Marketing-campaign performance (best-effort): rank the tagged utm_campaign traffic and surface the
  // untagged share. A failed query just leaves the section out (null), never fails the audit.
  const campaigns = await withQuotaRetry(() => data.getGa4CampaignPerformance(p, win)).then(rankGa4Campaigns).catch(() => null);
  // Growth/anomaly: correlate the session change with the outcomes that should move with real
  // growth (key events, revenue). Only when we have a baseline; the largest channel names the driver,
  // returning-user share weighs bot-vs-real, and the no-source share links the spike to attribution loss.
  const topChannel = [...dqCounts.channelGroups].sort((x, y) => y.sessions - x.sessions)[0]?.name ?? null;
  let growth = null;
  if (baseline) {
    const nvrTotal = baseline.newVsReturning.reduce((a, r) => a + r.sessions, 0);
    const returning = baseline.newVsReturning.find((r) => /return/i.test(r.name))?.sessions ?? 0;
    const dqTotal = dqCounts.totalSessions || 0;
    const unassigned = dqCounts.channelGroups.filter((c) => /unassigned/i.test(c.name)).reduce((a, c) => a + c.sessions, 0);
    const notSet = dqCounts.sourceMediums.filter((c) => /\(not set\)/i.test(c.name)).reduce((a, c) => a + c.sessions, 0);
    growth = auditGa4Growth({
      sessions: baseline.sessions,
      priorSessions: baseline.priorSessions,
      keyEvents: baseline.keyEvents,
      priorKeyEvents: baseline.priorKeyEvents,
      revenue: baseline.revenue,
      priorRevenue: baseline.priorRevenue,
      topChannel,
      returningSharePct: nvrTotal > 0 ? (returning / nvrTotal) * 100 : null,
      // Clamp: numerator (dimensioned) and denominator (no-dimension total) are separate GA4 queries.
      noSourceSharePct: dqTotal > 0 ? Math.min(100, (Math.max(unassigned, notSet) / dqTotal) * 100) : null,
    });
  }
  // Resolve the dead-dimension probe (overlapped with the queries above) and fold its advisory into
  // the config audit. `activelyMeasuring` gates it: with no traffic every dimension looks empty.
  const dimUsage = await dimUsageP;
  const deadDimensionFindings = dimUsage
    ? auditGa4DeadDimensions({ usage: dimUsage, activelyMeasuring: (dqCounts.totalSessions || 0) > 0, windowDays: 90 })
    : [];
  // Recommended-event coverage: which GA4 recommended online-sales events an ecommerce property does
  // not emit (an 'info' opportunity). The engine self-gates on observed anchor events, so a non-
  // ecommerce property yields nothing. Seeded into the config audit alongside the dead-dim findings.
  const coverageFindings = presentRec ? auditGa4EventCoverage({ presentRecommended: presentRec }) : [];
  const config = auditGa4(snap, [...deadDimensionFindings, ...coverageFindings]);
  // Resolve retention (overlapped above) into an honest one-line headline; null when there isn't
  // enough reliable cohort data (small/immature cohorts are excluded, not shown as 0%).
  const retentionCohorts = await retentionP;
  const retentionSummary = retentionCohorts ? summarizeGa4Retention({ cohorts: retentionCohorts, minCohortSize: 100 }) : null;
  // The transaction pass ALREADY ran above (txn) - hand its verdict to the report so the Ecommerce
  // area (and therefore the Revenue trust gate) is graded on evidence instead of staying Partial.
  const ecomVerification = ecom && txn
    ? { transactionsChecked: txn.transactions.length, duplicateIds: txn.transactions.filter((t) => t.purchases > 1).length, notSetSharePct: txn.notSetShare }
    : null;
  const reportInput = {
    property: p,
    displayName: snap.displayName,
    generatedAt: new Date().toISOString(),
    snapshot: snap,
    config,
    dataQuality,
    dqCounts,
    baseline,
    growth,
    attribution,
    audienceCount,
    audienceDetails: audienceList === null ? null : audienceList.map((a) => ({ displayName: a.displayName, membershipDurationDays: a.membershipDurationDays ?? null })),
    campaigns,
    retentionSummary,
    ecomVerification,
  };
  const markdown = buildGa4AuditReport(reportInput);
  const exec = buildGa4ExecSummary(reportInput);
  const visuals = buildGa4Visuals(reportInput);
  const sections = buildGa4Sections(reportInput);
  return { config, dataQuality, markdown, exec, visuals, sections };
}

export function registerGa4AuditIpc(data: GoogleDataService): void {
  // Flat list of every GA4 property (id + name + parent account) the active user can
  // reach, for the panel's search/select picker — one accountSummaries call (no per-account
  // fan-out). An auth/scope/transport failure propagates so the panel shows the real error
  // instead of a misleading empty "no properties" state.
  ipcMain.handle('ga4:listProperties', async (): Promise<Ga4PropertyListItem[]> => {
    const list = await withQuotaRetry(() => data.listGa4PropertySummaries());
    return [...list].sort((x, y) => x.displayName.localeCompare(y.displayName));
  });

  // Run the audit: the CONFIG pass (auditGa4) is window-independent; the DATA-QUALITY pass runs
  // over the chosen window — either trailing N days (clamped to [1, 365], default 28) or an
  // explicit { startDate, endDate } custom range (YYYY-MM-DD, start <= end). Read-only.
  ipcMain.handle('ga4:audit', async (_e, property: unknown, window: unknown): Promise<Ga4PropertyAuditResult> => {
    const p = String(property ?? '');
    if (!p) throw new Error('Pick a GA4 property first.');
    let win: number | { startDate: string; endDate: string };
    if (window && typeof window === 'object') {
      const w = window as { startDate?: unknown; endDate?: unknown };
      const sd = String(w.startDate ?? '');
      const ed = String(w.endDate ?? '');
      const ymd = /^\d{4}-\d{2}-\d{2}$/;
      if (!ymd.test(sd) || !ymd.test(ed)) throw new Error('Custom range needs a valid start and end date (YYYY-MM-DD).');
      if (sd > ed) throw new Error('The start date must be on or before the end date.');
      win = { startDate: sd, endDate: ed };
    } else {
      const n = Math.floor(Number(window));
      win = window != null && Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 28;
    }
    return runGa4AuditPipeline(data, p, win);
  });

  // Save the (renderer-displayed) GA4 audit report to a user-chosen file in the requested format:
  //   md  → the raw Markdown
  //   doc → a styled HTML document with the MS-Office namespaces (Word / Google Docs open it)
  //   pdf → the same HTML rendered in a hidden, script-free window via Electron printToPDF
  // A save dialog picks the path; returns the path or null if cancelled.
  ipcMain.handle('ga4:exportReport', async (e, format: unknown, defaultName: unknown, markdown: unknown, exec: unknown, visuals: unknown, sections: unknown): Promise<string | null> => {
    const fmt = format === 'pdf' ? 'pdf' : format === 'doc' ? 'doc' : 'md';
    const md = String(markdown ?? '');
    const base = String(defaultName ?? 'GA4 audit report')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\.(md|pdf|docx?|txt)$/i, '')
      .trim() || 'GA4 audit report';
    // PDF/Word lead with the DESIGNED Executive Summary (cards + scorecard + trust matrix); the
    // rest of the report follows as styled HTML from the markdown body (sections 2 onward). The PDF
    // also embeds the SVG charts (Word can't render SVG, so it's skipped there). The .md download
    // keeps the full plain-text markdown unchanged.
    const execHtml = exec ? execSummaryHtml(exec as Ga4ExecSummaryView) : '';
    // Charts panel for pdf AND doc: the styled section-6 card omits the device/channel bars (the panel
    // carries them), so Word needs the panel too or that data would be lost. (Only the inline line-chart
    // SVGs don't render in Word; the device/channel bars + insights are HTML and do.)
    const visualsHtml = (fmt === 'pdf' || fmt === 'doc') && visuals ? ga4VisualsHtml(visuals as Ga4VisualsView) : '';
    // Sections 2-9 render as styled HTML cards (pure HTML, safe for Word too); when present they ARE
    // the whole body, so no markdown body follows. Without them, fall back to the full markdown body.
    const sectionsHtml = sections ? ga4SectionsHtml(sections as Ga4SectionsView) : '';
    const topHtml = execHtml + visualsHtml + sectionsHtml;
    const bodyIdx = md.indexOf('## 2 ·');
    let bodyMd = sectionsHtml ? '' : topHtml && bodyIdx >= 0 ? md.slice(bodyIdx) : md;
    // PDF renders the colourful visuals panel, so strip the duplicate Unicode device/channel bars
    // from its body. Word/.md keep them (no panel there).
    if (visualsHtml && bodyMd) bodyMd = stripDuplicateCharts(bodyMd);
    const win = BrowserWindow.fromWebContents(e.sender);
    const filterName = fmt === 'pdf' ? 'PDF' : fmt === 'doc' ? 'Word document' : 'Markdown';
    const opts = { title: 'Save GA4 audit report', defaultPath: `${base}.${fmt}`, filters: [{ name: filterName, extensions: [fmt] }] };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return null;

    if (fmt === 'md') {
      return await writeReportFile(filePath, md);
    } else if (fmt === 'doc') {
      return await writeReportFile(filePath, reportHtmlDocument(base, bodyMd, { word: true, execHtml: topHtml }));
    } else {
      // PDF — render the report HTML in a hidden, script-disabled window and print it to PDF.
      const pdfWin = new BrowserWindow({
        show: false,
        webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      try {
        await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(reportHtmlDocument(base, bodyMd, { execHtml: topHtml })));
        const pdf = await pdfWin.webContents.printToPDF({ printBackground: true });
        return await writeReportFile(filePath, pdf);
      } finally {
        if (!pdfWin.isDestroyed()) pdfWin.destroy();
      }
    }
  });
}
