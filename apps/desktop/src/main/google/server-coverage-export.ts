// Pure builders: WEB <-> SERVER coverage report exports (CSV + print-styled HTML for the PDF
// pipeline). Renders exactly what the coverage page shows - score, wiring/id warnings, the
// per-event table, unused server tags - with the same honest wording. No em dashes (house rule).

import type { ServerCoverageView } from '../../shared/ipc';

export interface CoverageExportMeta {
  webName: string;
  serverName: string;
  webWorkspace?: string;
  serverWorkspace?: string;
  generatedAt?: string;
}

const csvCell = (v: unknown): string => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const STATUS_LABEL: Record<string, string> = { covered: 'Covered', missing: 'Missing', not_matchable: 'Not matchable' };

function wiringLine(v: ServerCoverageView): string | null {
  if (v.webWiring.status === 'not_wired') {
    return 'The web Google tag has NO server_container_url - the web container sends nothing to this server container.';
  }
  if (v.webWiring.status === 'url_mismatch') {
    return `The web Google tag points at ${v.webWiring.webUrl}, but this server container's tagging URL is ${v.webWiring.serverUrls.join(', ') || '(unset)'} - different hosts.`;
  }
  return null;
}

function idsLine(v: ServerCoverageView): string | null {
  if (v.ga4.idsMatch !== false) return null;
  return `Measurement ID mismatch: web sends ${v.ga4.webMeasurementIds.join(', ')} but the server relay forwards ${v.ga4.serverMeasurementIds.join(', ')} - events land in a different property.`;
}

export function serverCoverageToCsv(v: ServerCoverageView, meta: CoverageExportMeta): string {
  const lines: string[] = [];
  lines.push(['Web <-> Server coverage', `${meta.webName} vs ${meta.serverName}`].map(csvCell).join(','));
  if (meta.generatedAt) lines.push(['Generated', meta.generatedAt].map(csvCell).join(','));
  lines.push(['Overall score', String(v.score.overall)].map(csvCell).join(','));
  lines.push(['Configuration score', String(v.score.configuration)].map(csvCell).join(','));
  lines.push(['Coverage', v.score.coverage == null ? 'n/a (nothing matchable)' : `${v.score.coverage}%`].map(csvCell).join(','));
  lines.push(['Summary', `${v.summary.covered} covered, ${v.summary.missing} missing, ${v.summary.notMatchable} not matchable (excluded from %)`].map(csvCell).join(','));
  const wiring = wiringLine(v);
  if (wiring) lines.push(['Warning', wiring].map(csvCell).join(','));
  const ids = idsLine(v);
  if (ids) lines.push(['Warning', ids].map(csvCell).join(','));
  lines.push('');
  lines.push(['Event', 'Platform', 'Web tag', 'Server', 'Covered by / fix'].join(','));
  for (const r of v.rows) {
    lines.push([r.event, r.platform.toUpperCase(), r.webTag, STATUS_LABEL[r.status] ?? r.status, r.by ?? r.recommendation ?? ''].map(csvCell).join(','));
  }
  for (const u of v.unusedServer) {
    lines.push([u.event, u.platform.toUpperCase(), '', 'Server-only', `server tag "${u.tag}" matches no web event - server-only by design, or a cleanup candidate`].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

const escHtml = (x: unknown): string =>
  String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STATUS_COLOR: Record<string, string> = { covered: '#15803d', missing: '#dc2626', not_matchable: '#64748b' };

/** Self-contained print-styled document (light theme, no scripts) for the printToPDF pipeline. */
export function serverCoverageToHtml(v: ServerCoverageView, meta: CoverageExportMeta): string {
  const warn = [wiringLine(v), idsLine(v)].filter(Boolean) as string[];
  const rows = v.rows
    .map(
      (r) =>
        `<tr><td class="ev">${escHtml(r.event)}</td><td class="pf">${escHtml(r.platform.toUpperCase())}</td><td>${escHtml(r.webTag)}</td>` +
        `<td class="st" style="color:${STATUS_COLOR[r.status] ?? '#64748b'}">${escHtml(STATUS_LABEL[r.status] ?? r.status)}</td>` +
        `<td>${escHtml(r.by ?? r.recommendation ?? '')}</td></tr>`
    )
    .join('');
  const unused = v.unusedServer.length
    ? `<h2>Server tags with no matching web event (${v.unusedServer.length})</h2><p>${v.unusedServer.map((u) => `"${escHtml(u.tag)}" (${escHtml(u.event)})`).join(', ')} - server-only by design, or cleanup candidates.</p>`
    : '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>${escHtml(meta.webName)} vs ${escHtml(meta.serverName)} - coverage</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1e293b; margin: 36px 44px; font-size: 12.5px; line-height: 1.55; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  h2 { font-size: 13.5px; margin: 22px 0 8px; text-transform: uppercase; letter-spacing: .6px; color: #475569; }
  .meta { color: #64748b; font-size: 11.5px; margin-bottom: 14px; }
  .scores { display: flex; gap: 28px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
  .scores b { display: block; font-size: 20px; }
  .scores span { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: #64748b; }
  .warn { border: 1px solid #fde68a; background: #fffbeb; color: #92400e; border-radius: 8px; padding: 8px 12px; margin: 8px 0; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .5px; color: #64748b; border-bottom: 1px solid #e2e8f0; padding: 6px 10px 6px 0; }
  td { border-bottom: 1px solid #f1f5f9; padding: 7px 10px 7px 0; vertical-align: top; }
  td.ev { font-weight: 600; }
  td.pf, td.st { white-space: nowrap; font-weight: 700; font-size: 11px; }
  .foot { margin-top: 24px; color: #94a3b8; font-size: 10.5px; }
</style></head><body>
  <h1>Web &harr; Server coverage: ${escHtml(meta.webName)} vs ${escHtml(meta.serverName)}</h1>
  <div class="meta">${meta.webWorkspace ? `Web workspace ${escHtml(meta.webWorkspace)} · ` : ''}${meta.serverWorkspace ? `server workspace ${escHtml(meta.serverWorkspace)} · ` : ''}${meta.generatedAt ? `generated ${escHtml(meta.generatedAt)} · ` : ''}configuration-level comparison (GTM API data, no runtime logs)</div>
  <div class="scores">
    <div><span>Overall</span><b>${v.score.overall}</b></div>
    <div><span>Configuration</span><b>${v.score.configuration}</b></div>
    <div><span>Coverage</span><b>${v.score.coverage == null ? 'n/a' : `${v.score.coverage}%`}</b></div>
    <div style="align-self:center;color:#64748b;font-size:11.5px">${v.summary.covered} covered · ${v.summary.missing} missing${v.summary.notMatchable ? ` · ${v.summary.notMatchable} not matchable (excluded from %)` : ''}</div>
  </div>
  ${warn.map((w) => `<div class="warn">${escHtml(w)}</div>`).join('')}
  <h2>Event coverage (${v.rows.length})</h2>
  <table><thead><tr><th>Event</th><th>Platform</th><th>Web tag</th><th>Server</th><th>Covered by / fix</th></tr></thead><tbody>${rows}</tbody></table>
  ${unused}
  <div class="foot">Generated by Samarth Analytics - GA4 events are covered as a group by the GA4 client + relay; CAPI destinations are matched per event; pixels on non-custom-event triggers have no event name to match and are excluded from the coverage %.</div>
</body></html>`;
}
