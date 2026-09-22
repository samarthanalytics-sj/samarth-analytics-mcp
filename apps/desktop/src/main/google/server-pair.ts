// The web + server PAIR, as findings the drift monitor can diff.
//
// A server container on its own can look perfect while doing nothing: on a real client the server
// held relays for eight regions and eleven of thirteen web Google tags sent straight to Google. The
// server audit cannot see that, and neither can a web audit. Only the pair shows it.
//
// The monitor alerts on NEW findings between runs, so every regression in the pair has to be
// expressed as a finding that APPEARS, not as a "covered" note that vanishes. Two such findings:
//
//   pair_wired_but_unforwarded (critical)  a web Google tag points at THIS server, but no active
//                                          relay forwards its Measurement ID and none inherits:
//                                          hits are claimed and dropped. Fires the moment a relay
//                                          is paused or deleted under a wired tag.
//   pair_relay_without_wiring  (high)      a server relay forwards a Measurement ID that a web
//                                          Google tag uses, but that tag sends direct. Fires the
//                                          moment a wired tag loses its server_container_url.
//
// It deliberately says nothing about web tags whose ids the server has no relay for: leaving a
// region direct is a legitimate decision (a client keeps only Australia server-side), not drift.
// The coverage engine's own cross-container findings (both legs feeding one property, duplicate
// configs) are carried through as findings too. PURE.

import type { AuditFinding, AuditReport, AuditTag, ContainerSnapshot, ServerContainerSnapshot } from './gtm-builders';
import { googleTagConfigValue, serverTagParam } from './gtm-builders';
import { buildServerCoverage } from './server-coverage';

const GA4_ID = /G-[A-Z0-9]{4,}/i;

const hostOf = (u: string): string => {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
};

/** `{{Constant}}` -> its literal, so a tag holding {{GA4 ID}} and one holding G-XXXX compare equal. */
function constantResolver(variables: Array<{ name: string; type: string; parameter?: unknown[] }>): (raw: string) => string {
  const map = new Map<string, string>();
  for (const v of variables) {
    if ((v.type ?? '').toLowerCase() !== 'c') continue;
    const val = String(((v.parameter ?? []) as Array<{ key?: string; value?: unknown }>).find((p) => p.key === 'value')?.value ?? '').trim();
    if (val) map.set(v.name.trim().toLowerCase(), val);
  }
  return (raw: string): string => {
    const m = raw.trim().match(/^\{\{([^}]+)\}\}$/);
    return m ? (map.get(m[1].trim().toLowerCase()) ?? raw) : raw;
  };
}

const literalId = (v: string): string | null => { const m = v.match(GA4_ID); return m ? m[0].toUpperCase() : null; };

export interface WebPair {
  containerId: string;
  name: string;
  snapshot: ContainerSnapshot;
}

/** The web containers whose active Google tags point at one of this server's tagging hosts. Strict:
 *  with no tagging URL recorded nothing can be paired, and that gap is already a high finding. */
export function pairedWebContainers(server: ServerContainerSnapshot, webs: readonly WebPair[]): WebPair[] {
  const hosts = new Set((server.taggingServerUrls ?? []).map(hostOf).filter(Boolean));
  if (hosts.size === 0) return [];
  return webs.filter((w) => w.snapshot.tags.some((t) =>
    (t.type === 'googtag' || t.type === 'gaawc') && !t.paused &&
    hosts.has(hostOf(googleTagConfigValue(t as unknown as Record<string, unknown>, 'server_container_url').trim()))));
}

interface WebGoogleTag { tag: AuditTag; id: string | null; wiredHost: string; container: string }

function webGoogleTags(w: WebPair): WebGoogleTag[] {
  const resolve = constantResolver(w.snapshot.variables);
  return w.snapshot.tags
    .filter((t) => (t.type === 'googtag' || t.type === 'gaawc') && !t.paused)
    .map((t) => {
      const raw = String(t.parameter.find((p) => (p.key === 'tagId' || p.key === 'tag_id' || p.key === 'measurementId') && p.value)?.value ?? '');
      return {
        tag: t,
        id: literalId(resolve(raw)),
        wiredHost: hostOf(googleTagConfigValue(t as unknown as Record<string, unknown>, 'server_container_url').trim()),
        container: w.name,
      };
    });
}

/** Findings about the pair. `webs` should be every web container in the GTM account: pairing is
 *  decided here, and unpaired containers still matter for pair_relay_without_wiring. PURE. */
export function pairDriftFindings(
  server: ServerContainerSnapshot,
  webs: readonly WebPair[],
  serverAuditSummary: { critical: number; high: number; medium: number; low: number },
): AuditFinding[] {
  const out: AuditFinding[] = [];
  const hosts = new Set((server.taggingServerUrls ?? []).map(hostOf).filter(Boolean));
  if (hosts.size === 0) return out;

  const resolveServer = constantResolver(server.variables ?? []);
  const relays = server.tags.filter((t) => t.type === 'sgtmgaaw' && !t.paused && (t.firingTriggerId ?? []).length > 0);
  const forwarded = new Set<string>();
  let inherits = false;
  for (const r of relays) {
    const raw = serverTagParam(r, 'measurementId').trim();
    if (!raw) { inherits = true; continue; }
    const id = literalId(resolveServer(raw));
    if (id) forwarded.add(id);
  }

  const allTags = webs.flatMap(webGoogleTags);

  // 1. Wired to this server, but nothing forwards it: the blackhole.
  for (const g of allTags) {
    if (!g.wiredHost || !hosts.has(g.wiredHost) || !g.id || inherits || forwarded.has(g.id)) continue;
    out.push({
      severity: 'critical',
      confidence: 'certain',
      category: 'coverage',
      checkId: 'pair_wired_but_unforwarded',
      resource: { kind: 'tag', id: g.tag.tagId, name: g.tag.name, type: g.tag.type },
      message: `Web Google tag "${g.tag.name}" (${g.container}) sends ${g.id} to this server, but no active GA4 relay forwards ${g.id} and none inherits the id. Its hits are claimed by the GA4 client and dropped, so that property receives nothing.`,
      recommendation: `Restore or unpause the server relay for ${g.id}, or point the web tag back at Google until one exists. Check GA4 DebugView for ${g.id}: it will be empty while this stands.`,
      autoFixable: false,
    });
  }

  // 2. The server would forward it, but the web tag sends direct: the relay is idle.
  for (const g of allTags) {
    if (!g.id || !forwarded.has(g.id) || g.wiredHost) continue;
    out.push({
      severity: 'high',
      confidence: 'certain',
      category: 'coverage',
      checkId: 'pair_relay_without_wiring',
      resource: { kind: 'tag', id: g.tag.tagId, name: g.tag.name, type: g.tag.type },
      message: `This server holds a GA4 relay for ${g.id}, but web Google tag "${g.tag.name}" (${g.container}) has no server container URL and sends ${g.id} straight to Google. The relay never receives anything, and none of the server-side benefits apply to that property.`,
      recommendation: `If ${g.id} is meant to be server-side, set the tag's server container URL to this tagging server. If it is meant to stay direct, remove the idle relay so the server reflects what it actually does.`,
      autoFixable: false,
    });
  }

  // 3. The coverage engine's own pair findings, for each paired web container.
  for (const w of pairedWebContainers(server, webs)) {
    const cov = buildServerCoverage(w.snapshot, server, serverAuditSummary);
    for (const f of cov.crossContainer) {
      out.push({
        severity: f.severity,
        confidence: 'certain',
        category: 'coverage',
        checkId: f.checkId,
        message: `${w.name}: ${f.message}`,
        recommendation: f.recommendation,
        autoFixable: false,
      });
    }
  }
  return out;
}

/** The server report with pair findings appended and its summary recounted. PURE. */
export function withPairFindings(report: AuditReport, extra: AuditFinding[]): AuditReport {
  if (extra.length === 0) return report;
  const findings = [...report.findings, ...extra];
  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) summary[f.severity] += 1;
  return { ...report, findings, summary, counts: { ...report.counts, findings: findings.length } };
}
