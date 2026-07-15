// Pure builders: SERVER container documentation (Markdown + CSV). Generated from the same
// config snapshot the audit reads - clients, tags (with destination, firing triggers, referenced
// variables), triggers, variables, transformations. SECURITY: secret-shaped parameter values
// (access tokens, API secrets) are NEVER echoed - only their presence is noted.

import type { AuditReport, AuditTag, AuditTrigger, ServerContainerSnapshot } from './gtm-builders';
import { serverTagParam } from './gtm-builders';

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

export function serverContainerDocMarkdown(s: ServerContainerSnapshot, meta: ServerDocMeta, audit?: AuditReport): string {
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
    lines.push('| Variable | Type |');
    lines.push('| --- | --- |');
    for (const v of s.variables ?? []) lines.push(`| ${mdCell(v.name)} | ${mdCell(v.type)} |`);
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
  return lines.join('\n');
}

const csvCell = (v: unknown): string => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function serverContainerDocCsv(s: ServerContainerSnapshot, meta: ServerDocMeta, audit?: AuditReport): string {
  const trigById = new Map((s.triggers ?? []).map((t) => [t.triggerId, t]));
  const lines: string[] = [];
  lines.push(['Server container documentation', meta.containerName, meta.publicId ?? ''].map(csvCell).join(','));
  if (meta.workspaceName) lines.push(['Workspace', meta.workspaceName].map(csvCell).join(','));
  lines.push(['Tagging server URL(s)', s.taggingServerUrls.join(' ')].map(csvCell).join(','));
  lines.push('');
  lines.push(['Kind', 'Name', 'Type', 'Destination', 'Fires on', 'Uses variables', 'Notes'].join(','));
  for (const f of audit?.findings ?? []) {
    const where = f.resource ? `${f.resource.kind} "${f.resource.name}"` : 'container';
    lines.push(['Finding', where, f.severity.toUpperCase(), '', '', '', `${f.message} FIX: ${f.recommendation}`].map(csvCell).join(','));
  }
  for (const d of buildDestinationRows(s)) {
    lines.push(['Destination', d.destination, d.types, '', '', '', `${d.tags} tag(s)${d.paused ? `, ${d.paused} paused` : ''}`].map(csvCell).join(','));
  }
  for (const c of s.clients) lines.push(['Client', c.name, c.type, '', '', '', ''].map(csvCell).join(','));
  for (const t of s.tags) {
    const firesOn = (t.firingTriggerId ?? []).map((id) => trigById.get(id)?.name ?? `#${id}`).join('; ');
    const notes = [t.paused ? 'PAUSED' : '', hasSecret(t) ? 'credential configured (value not shown)' : ''].filter(Boolean).join('; ');
    lines.push(['Tag', t.name, t.type, tagDestination(t), firesOn, referencedVars(t).join('; '), notes].map(csvCell).join(','));
  }
  for (const tr of s.triggers ?? []) lines.push(['Trigger', tr.name, tr.type, '', triggerCondition(tr), '', ''].map(csvCell).join(','));
  for (const v of s.variables ?? []) lines.push(['Variable', v.name, v.type, '', '', '', ''].map(csvCell).join(','));
  for (const x of s.transformations) lines.push(['Transformation', x.name, x.type, '', '', '', ''].map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}
