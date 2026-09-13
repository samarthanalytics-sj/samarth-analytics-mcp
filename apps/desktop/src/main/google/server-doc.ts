// Pure builders: SERVER container documentation (Markdown + CSV). Generated from the same
// config snapshot the audit reads - clients, tags (with destination, firing triggers, referenced
// variables), triggers, variables, transformations. SECURITY: secret-shaped parameter values
// (access tokens, API secrets) are NEVER echoed - only their presence is noted.

import type { AuditReport, AuditTag, AuditTrigger, ServerContainerSnapshot } from './gtm-builders';
import { serverTagParam, plainDashes } from './gtm-builders';
import { configurationScore, type ServerCoverageReport } from './server-coverage';

/** A published container version row for the doc's Versions section (header list only - the
 *  GTM version list carries NO publish dates; we never fabricate them). */
export interface ServerDocVersionRow {
  versionId: string;
  name: string;
  numTags: number;
  numTriggers: number;
  numVariables: number;
  deleted: boolean;
  /** True when this is the container's LIVE (published) version. */
  live: boolean;
}

/** Optional doc enrichments fetched by the IPC layer: version history and the web<->server
 *  coverage link (only when a web container was provided - never guessed). */
export interface ServerDocExtras {
  versions?: ServerDocVersionRow[] | null;
  coverage?: ServerCoverageReport | null;
}

export interface ServerDocMeta {
  containerName: string;
  publicId?: string;
  workspaceName?: string;
  generatedAt?: string;
  /** The container's LIVE (published) version id, when readable — the doc describes the DRAFT. */
  liveVersionId?: string | null;
}

const SECRET_KEYS = /token|secret|password|credential/i;

/** Human destination for a server tag - the id the tag forwards TO, never a credential. */
export function tagDestination(t: AuditTag): string {
  if (t.type === 'sgtmgaaw') return serverTagParam(t, 'measurementId').trim() || '(no Measurement ID)';
  const pixel = serverTagParam(t, 'pixelId').trim();
  if (pixel) return `pixel ${pixel}`;
  const conv = serverTagParam(t, 'conversionId').trim();
  if (conv) return conv;
  return '';
}

/** {{Variable}} names referenced anywhere in the tag's parameters. */
export function referencedVars(t: AuditTag): string[] {
  const out = new Set<string>();
  for (const m of JSON.stringify(t.parameter ?? []).matchAll(/\{\{([^}]+)\}\}/g)) out.add(m[1].trim());
  return [...out].sort();
}

/** Which entities reference {{name}} - the inverse of referencedVars, for the Variables table. */
export function variableUsedBy(s: ServerContainerSnapshot, name: string): string[] {
  const token = `{{${name}}}`;
  const has = (parameter: unknown[] | undefined): boolean => JSON.stringify(parameter ?? []).includes(token);
  const out: string[] = [];
  for (const t of s.tags) if (has(t.parameter)) out.push(`tag "${t.name}"`);
  for (const c of s.clients) if (has((c as { parameter?: unknown[] }).parameter)) out.push(`client "${c.name}"`);
  for (const x of s.transformations) if (has((x as { parameter?: unknown[] }).parameter)) out.push(`transformation "${x.name}"`);
  for (const v of s.variables ?? []) if (v.name !== name && has((v as { parameter?: unknown[] }).parameter)) out.push(`variable "${v.name}"`);
  return out;
}

/** The web<->server linkage summarized as plain sentences (shared by MD/CSV/XLSX and the
 *  on-screen view so every surface says the same thing). PURE. */
export function webLinkSummaryLines(cov: ServerCoverageReport): string[] {
  const L: string[] = [];
  const w = cov.webWiring;
  L.push(
    w.status === 'wired'
      ? `Web Google tag points at this server (server_container_url matches ${w.serverUrls.join(', ') || w.webUrl}).`
      : w.status === 'url_mismatch'
        ? `MISMATCH: the web Google tag points at ${w.webUrl}, but this container's tagging URL is ${w.serverUrls.join(', ') || '(unset)'}.`
        : w.status === 'not_wired'
          ? 'The web Google tag has NO server_container_url - the web container sends nothing to this server yet.'
          : 'Web wiring unknown - no web Google tag found to inspect.',
  );
  if (cov.ga4.idsMatch === true) L.push(`Measurement IDs match (${cov.ga4.webMeasurementIds.join(', ')}).`);
  else if (cov.ga4.idsMatch === false)
    L.push(`Measurement ID MISMATCH: web sends ${cov.ga4.webMeasurementIds.join(', ')}, the server relay forwards ${cov.ga4.serverMeasurementIds.join(', ')} - events land in a different property.`);
  L.push(
    cov.summary.coveragePct == null
      ? 'Coverage: no matchable web events to compare.'
      : `Coverage: ${cov.summary.covered} of ${cov.summary.covered + cov.summary.missing} web events covered (${cov.summary.coveragePct}%)${cov.summary.notMatchable ? `; ${cov.summary.notMatchable} not matchable from config (never guessed)` : ''}.`,
  );
  const miss = cov.rows.filter((r) => r.status === 'missing').slice(0, 10);
  if (miss.length)
    L.push(`Missing server-side: ${miss.map((r) => `${r.platform} ${r.event}`).join(', ')}${cov.summary.missing > miss.length ? ` and ${cov.summary.missing - miss.length} more` : ''}.`);
  L.push(`Score: configuration ${cov.score.configuration}${cov.score.coverage == null ? '' : ` / coverage ${cov.score.coverage}`} / overall ${cov.score.overall} out of 100.`);
  return L;
}

/** Whether the tag carries any secret-shaped parameter (documented as present, value never shown). */
export function hasSecret(t: AuditTag): boolean {
  return (t.parameter ?? []).some((p) => {
    const key = String((p as { key?: unknown }).key ?? '');
    const value = String((p as { value?: unknown }).value ?? '');
    return SECRET_KEYS.test(key) && value.trim() !== '' && !value.includes('{{');
  });
}

/** First literal event-name condition on a trigger, for the doc's "fires on" column. */
export function triggerCondition(tr: AuditTrigger): string {
  for (const arr of [tr.customEventFilter, tr.filter]) {
    for (const f of arr ?? []) {
      const params = ((f as { parameter?: Array<{ key?: string; value?: unknown }> }).parameter) ?? [];
      const arg0 = String(params.find((p) => p.key === 'arg0')?.value ?? '');
      const arg1 = String(params.find((p) => p.key === 'arg1')?.value ?? '');
      const op = String((f as { type?: unknown }).type ?? '');
      if (arg0 && arg1) return `${arg0} ${op} "${arg1}"`;
    }
  }
  return '(no condition - every claimed event)';
}

const mdCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Where data GOES from this container: distinct destinations with their feeding-tag counts. */
export function buildDestinationRows(s: ServerContainerSnapshot): Array<{ destination: string; types: string; tags: number; paused: number }> {
  const byDest = new Map<string, { types: Set<string>; tags: number; paused: number }>();
  for (const t of s.tags) {
    const dest = tagDestination(t);
    if (!dest || dest.startsWith('(no ')) continue;
    const d = byDest.get(dest) ?? { types: new Set<string>(), tags: 0, paused: 0 };
    d.types.add(t.type);
    d.tags += 1;
    if (t.paused) d.paused += 1;
    byDest.set(dest, d);
  }
  return [...byDest.entries()].map(([destination, d]) => ({ destination, types: [...d.types].sort().join(', '), tags: d.tags, paused: d.paused }));
}

/** The container's request flow as indented plain-text lines (renders identically in MD/PDF/Word):
 *  client claims -> trigger (condition) -> tags (destination). Orphan tags are called out. PURE. */
export function buildServerFlowLines(s: ServerContainerSnapshot): string[] {
  const lines: string[] = [];
  const url = s.taggingServerUrls[0] ?? '(tagging URL not set)';
  lines.push(`incoming request -> ${url}`);
  if (!s.clients.length) {
    lines.push('  (no client - nothing claims requests, the flow stops here)');
    return lines;
  }
  for (const c of s.clients) lines.push(`  client "${c.name}" (${c.type}) claims the request`);
  const triggers = s.triggers ?? [];
  const tagsByTrigger = new Map<string, AuditTag[]>();
  const orphans: AuditTag[] = [];
  for (const t of s.tags) {
    const ids = t.firingTriggerId ?? [];
    if (!ids.length) {
      orphans.push(t);
      continue;
    }
    for (const id of ids) {
      const arr = tagsByTrigger.get(id) ?? [];
      arr.push(t);
      tagsByTrigger.set(id, arr);
    }
  }
  for (const tr of triggers) {
    const firing = tagsByTrigger.get(tr.triggerId) ?? [];
    lines.push(`    trigger "${tr.name}" - ${triggerCondition(tr)}`);
    if (firing.length) {
      for (const t of firing) {
        const dest = tagDestination(t);
        lines.push(`      -> ${t.name}${dest ? ` (${dest})` : ''}${t.paused ? ' [PAUSED]' : ''}`);
      }
    } else {
      lines.push('      (fires no tag)');
    }
  }
  if (orphans.length) lines.push(`    tags with NO trigger (never fire): ${orphans.map((t) => `"${t.name}"`).join(', ')}`);
  if (!s.tags.length) lines.push('    (no server tags - claimed events are dropped, nothing is forwarded)');
  return lines;
}

/** JSON-safe documentation view for ON-SCREEN rendering (shape mirrors ServerDocView in
 *  shared/ipc.ts). Built from the SAME helpers the MD/CSV/XLSX exports use - destination,
 *  fires-on, referenced variables, flow lines - so the page and the files can't diverge.
 *  Secret-shaped values are never included; only the pinned presence note. PURE. */
export function buildServerDocView(s: ServerContainerSnapshot, meta: ServerDocMeta, audit?: AuditReport, extras?: ServerDocExtras): {
  meta: { containerName: string; publicId?: string; workspaceName?: string; generatedAt: string; liveVersionId: string | null };
  overview: { taggingServerUrls: string[]; counts: { clients: number; tags: number; triggers: number; variables: number; transformations: number }; configScore: number | null };
  findings: Array<{ severity: string; where: string; message: string; recommendation: string }>;
  destinations: Array<{ destination: string; types: string; tags: number; paused: number }>;
  flowLines: string[];
  clients: Array<{ name: string; type: string }>;
  tags: Array<{ name: string; type: string; destination: string; firesOn: string; vars: string; notes: string }>;
  triggers: Array<{ name: string; type: string; condition: string }>;
  variables: Array<{ name: string; type: string; usedBy: string }>;
  transformations: Array<{ name: string; type: string }>;
  versions: Array<{ versionId: string; name: string; tags: number; triggers: number; variables: number; live: boolean; deleted: boolean }>;
  webLink: { wiring: 'wired' | 'not_wired' | 'url_mismatch' | 'unknown'; idsMatch: boolean | null; coveragePct: number | null; score: { configuration: number; coverage: number | null; overall: number }; lines: string[] } | null;
} {
  const cov = extras?.coverage ?? null;
  const trigById = new Map((s.triggers ?? []).map((t) => [t.triggerId, t]));
  const firesOn = (t: AuditTag): string =>
    (t.firingTriggerId ?? []).map((id) => trigById.get(id)?.name ?? `#${id}`).join(', ') || '(none - never fires)';
  return {
    meta: {
      containerName: meta.containerName,
      publicId: meta.publicId,
      workspaceName: meta.workspaceName,
      generatedAt: meta.generatedAt ?? '',
      liveVersionId: meta.liveVersionId ?? null,
    },
    overview: {
      taggingServerUrls: s.taggingServerUrls,
      counts: {
        clients: s.clients.length,
        tags: s.tags.length,
        triggers: (s.triggers ?? []).length,
        variables: (s.variables ?? []).length,
        transformations: s.transformations.length,
      },
      configScore: audit ? configurationScore(audit.summary) : null,
    },
    findings: (audit?.findings ?? []).map((f) => ({
      severity: f.severity,
      where: f.resource ? `${f.resource.kind} "${f.resource.name}"` : 'container',
      message: f.message,
      recommendation: f.recommendation,
    })),
    destinations: buildDestinationRows(s),
    flowLines: buildServerFlowLines(s),
    clients: s.clients.map((c) => ({ name: c.name, type: c.type })),
    tags: s.tags.map((t) => ({
      name: t.name,
      type: t.type,
      destination: tagDestination(t),
      firesOn: firesOn(t),
      vars: referencedVars(t).join(', '),
      notes: [t.paused ? 'PAUSED' : '', hasSecret(t) ? 'credential configured (value not shown)' : ''].filter(Boolean).join('; '),
    })),
    triggers: (s.triggers ?? []).map((tr) => ({ name: tr.name, type: tr.type, condition: triggerCondition(tr) })),
    variables: (s.variables ?? []).map((v) => ({ name: v.name, type: v.type, usedBy: variableUsedBy(s, v.name).join(', ') })),
    transformations: s.transformations.map((x) => ({ name: x.name, type: x.type })),
    versions: (extras?.versions ?? []).map((v) => ({ versionId: v.versionId, name: v.name, tags: v.numTags, triggers: v.numTriggers, variables: v.numVariables, live: v.live, deleted: v.deleted })),
    webLink: cov
      ? { wiring: cov.webWiring.status, idsMatch: cov.ga4.idsMatch, coveragePct: cov.summary.coveragePct, score: cov.score, lines: webLinkSummaryLines(cov) }
      : null,
  };
}

export function serverContainerDocMarkdown(s: ServerContainerSnapshot, meta: ServerDocMeta, audit?: AuditReport, extras?: ServerDocExtras): string {
  const trigById = new Map((s.triggers ?? []).map((t) => [t.triggerId, t]));
  const firesOn = (t: AuditTag): string =>
    (t.firingTriggerId ?? []).map((id) => trigById.get(id)?.name ?? `#${id}`).join(', ') || '(none - never fires)';
  const lines: string[] = [];
  lines.push(`# Server container documentation: ${meta.containerName}${meta.publicId ? ` (${meta.publicId})` : ''}`);
  lines.push('');
  lines.push(`${meta.workspaceName ? `Workspace: ${meta.workspaceName} · ` : ''}${meta.generatedAt ? `Generated: ${meta.generatedAt} · ` : ''}Configuration-level documentation from the GTM API (no runtime data).`);
  if (meta.liveVersionId) {
    lines.push('');
    lines.push(`Live (published) version: ${meta.liveVersionId}. This document describes the ${meta.workspaceName ? `"${meta.workspaceName}"` : 'workspace'} DRAFT, which may differ from what is live.`);
  }
  lines.push('');
  lines.push('## Overview');
  lines.push('');
  lines.push(`- Tagging server URL(s): ${s.taggingServerUrls.length ? s.taggingServerUrls.join(', ') : '(not set - host not wired yet)'}`);
  lines.push(`- Clients: ${s.clients.length} · Tags: ${s.tags.length} · Triggers: ${(s.triggers ?? []).length} · Variables: ${(s.variables ?? []).length} · Transformations: ${s.transformations.length}`);
  if (audit) lines.push(`- Configuration score: ${configurationScore(audit.summary)}/100 (100 - 25 per critical - 10 per high - 3 per medium - 1 per low)`);
  lines.push('');
  if (audit) {
    const sm = audit.summary;
    lines.push('## Configuration issues');
    lines.push('');
    if (!audit.findings.length) {
      lines.push('None found - the configuration audit came back clean.');
    } else {
      lines.push(`${audit.findings.length} finding${audit.findings.length === 1 ? '' : 's'}: ${sm.critical} critical · ${sm.high} high · ${sm.medium} medium · ${sm.low} low · ${sm.info} info`);
      lines.push('');
      lines.push('| Severity | Where | Issue | Fix |');
      lines.push('| --- | --- | --- | --- |');
      for (const f of audit.findings) {
        const where = f.resource ? `${f.resource.kind} "${f.resource.name}"` : 'container';
        lines.push(`| ${f.severity.toUpperCase()} | ${mdCell(where)} | ${mdCell(f.message)} | ${mdCell(f.recommendation)} |`);
      }
    }
    lines.push('');
  }
  const dests = buildDestinationRows(s);
  lines.push('## Destinations (where data goes)');
  lines.push('');
  if (dests.length) {
    lines.push('| Destination | Tag type(s) | Tags | Notes |');
    lines.push('| --- | --- | --- | --- |');
    for (const d of dests) lines.push(`| ${mdCell(d.destination)} | ${mdCell(d.types)} | ${d.tags} | ${d.paused ? `${d.paused} paused` : ''} |`);
  } else {
    lines.push('None - no server tag forwards data anywhere yet.');
  }
  lines.push('');
  lines.push('## Request flow');
  lines.push('');
  lines.push('```text');
  lines.push(...buildServerFlowLines(s));
  lines.push('```');
  lines.push('');
  if (extras?.coverage) {
    lines.push('## Web link (web container <-> this server)');
    lines.push('');
    for (const l of webLinkSummaryLines(extras.coverage)) lines.push(`- ${l}`);
    lines.push('');
  }
  if (extras?.versions?.length) {
    lines.push('## Versions');
    lines.push('');
    lines.push('Version history from the GTM API (newest first; the version list carries no publish dates).');
    lines.push('');
    lines.push('| Version | Name | Tags | Triggers | Variables | Notes |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const v of extras.versions) {
      lines.push(`| #${v.versionId} | ${mdCell(v.name)} | ${v.numTags} | ${v.numTriggers} | ${v.numVariables} | ${[v.live ? 'LIVE' : '', v.deleted ? 'deleted' : ''].filter(Boolean).join(' · ')} |`);
    }
    lines.push('');
  }
  lines.push('## Clients (what claims incoming requests)');
  lines.push('');
  if (s.clients.length) {
    lines.push('| Client | Type |');
    lines.push('| --- | --- |');
    for (const c of s.clients) lines.push(`| ${mdCell(c.name)} | ${mdCell(c.type)} |`);
  } else {
    lines.push('None - nothing claims incoming requests, so no server tag can run.');
  }
  lines.push('');
  lines.push('## Server tags');
  lines.push('');
  if (s.tags.length) {
    lines.push('| Tag | Type | Destination | Fires on | Uses variables | Notes |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const t of s.tags) {
      const notes = [t.paused ? 'PAUSED' : '', hasSecret(t) ? 'credential configured (value not shown)' : ''].filter(Boolean).join('; ');
      lines.push(`| ${mdCell(t.name)} | ${mdCell(t.type)} | ${mdCell(tagDestination(t))} | ${mdCell(firesOn(t))} | ${mdCell(referencedVars(t).join(', '))} | ${mdCell(notes)} |`);
    }
  } else {
    lines.push('None.');
  }
  lines.push('');
  lines.push('## Triggers');
  lines.push('');
  if ((s.triggers ?? []).length) {
    lines.push('| Trigger | Type | Condition |');
    lines.push('| --- | --- | --- |');
    for (const tr of s.triggers ?? []) lines.push(`| ${mdCell(tr.name)} | ${mdCell(tr.type)} | ${mdCell(triggerCondition(tr))} |`);
  } else {
    lines.push('None.');
  }
  lines.push('');
  lines.push('## Variables');
  lines.push('');
  if ((s.variables ?? []).length) {
    lines.push('| Variable | Type | Used by |');
    lines.push('| --- | --- | --- |');
    for (const v of s.variables ?? []) lines.push(`| ${mdCell(v.name)} | ${mdCell(v.type)} | ${mdCell(variableUsedBy(s, v.name).join(', '))} |`);
  } else {
    lines.push('None.');
  }
  lines.push('');
  lines.push('## Transformations');
  lines.push('');
  if (s.transformations.length) {
    lines.push('| Transformation | Type |');
    lines.push('| --- | --- |');
    for (const x of s.transformations) lines.push(`| ${mdCell(x.name)} | ${mdCell(x.type)} |`);
  } else {
    lines.push('None configured - events pass through to destinations unmodified.');
  }
  lines.push('');
  return plainDashes(lines.join('\n'));
}

const csvCell = (v: unknown): string => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function serverContainerDocCsv(s: ServerContainerSnapshot, meta: ServerDocMeta, audit?: AuditReport, extras?: ServerDocExtras): string {
  const trigById = new Map((s.triggers ?? []).map((t) => [t.triggerId, t]));
  const lines: string[] = [];
  lines.push(['Server container documentation', meta.containerName, meta.publicId ?? ''].map(csvCell).join(','));
  if (meta.workspaceName) lines.push(['Workspace', meta.workspaceName].map(csvCell).join(','));
  lines.push(['Tagging server URL(s)', s.taggingServerUrls.join(' ')].map(csvCell).join(','));
  if (audit) lines.push(['Configuration score', `${configurationScore(audit.summary)}/100`].map(csvCell).join(','));
  for (const l of extras?.coverage ? webLinkSummaryLines(extras.coverage) : []) lines.push(['Web link', l].map(csvCell).join(','));
  lines.push('');
  lines.push(['Kind', 'Name', 'Type', 'Destination', 'Fires on', 'Uses variables', 'Notes'].join(','));
  for (const f of audit?.findings ?? []) {
    const where = f.resource ? `${f.resource.kind} "${f.resource.name}"` : 'container';
    lines.push(['Finding', where, f.severity.toUpperCase(), '', '', '', `${f.message} FIX: ${f.recommendation}`].map(csvCell).join(','));
  }
  for (const d of buildDestinationRows(s)) {
    lines.push(['Destination', d.destination, d.types, '', '', '', `${d.tags} tag(s)${d.paused ? `, ${d.paused} paused` : ''}`].map(csvCell).join(','));
  }
  for (const v of extras?.versions ?? []) {
    lines.push(['Version', v.name, `#${v.versionId}`, '', '', '', [`${v.numTags} tags`, `${v.numTriggers} triggers`, `${v.numVariables} variables`, v.live ? 'LIVE' : '', v.deleted ? 'deleted' : ''].filter(Boolean).join('; ')].map(csvCell).join(','));
  }
  for (const c of s.clients) lines.push(['Client', c.name, c.type, '', '', '', ''].map(csvCell).join(','));
  for (const t of s.tags) {
    const firesOn = (t.firingTriggerId ?? []).map((id) => trigById.get(id)?.name ?? `#${id}`).join('; ');
    const notes = [t.paused ? 'PAUSED' : '', hasSecret(t) ? 'credential configured (value not shown)' : ''].filter(Boolean).join('; ');
    lines.push(['Tag', t.name, t.type, tagDestination(t), firesOn, referencedVars(t).join('; '), notes].map(csvCell).join(','));
  }
  for (const tr of s.triggers ?? []) lines.push(['Trigger', tr.name, tr.type, '', triggerCondition(tr), '', ''].map(csvCell).join(','));
  for (const v of s.variables ?? []) {
    const ub = variableUsedBy(s, v.name);
    lines.push(['Variable', v.name, v.type, '', '', '', ub.length ? `used by: ${ub.join('; ')}` : 'no references in this workspace'].map(csvCell).join(','));
  }
  for (const x of s.transformations) lines.push(['Transformation', x.name, x.type, '', '', '', ''].map(csvCell).join(','));
  return plainDashes(lines.join('\r\n') + '\r\n');
}
