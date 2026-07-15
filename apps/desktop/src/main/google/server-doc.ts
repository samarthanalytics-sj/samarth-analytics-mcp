// Pure builders: SERVER container documentation (Markdown + CSV). Generated from the same
// config snapshot the audit reads - clients, tags (with destination, firing triggers, referenced
// variables), triggers, variables, transformations. SECURITY: secret-shaped parameter values
// (access tokens, API secrets) are NEVER echoed - only their presence is noted.

import type { AuditTag, AuditTrigger, ServerContainerSnapshot } from './gtm-builders';
import { serverTagParam } from './gtm-builders';

export interface ServerDocMeta {
  containerName: string;
  publicId?: string;
  workspaceName?: string;
  generatedAt?: string;
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

export function serverContainerDocMarkdown(s: ServerContainerSnapshot, meta: ServerDocMeta): string {
  const trigById = new Map((s.triggers ?? []).map((t) => [t.triggerId, t]));
  const firesOn = (t: AuditTag): string =>
    (t.firingTriggerId ?? []).map((id) => trigById.get(id)?.name ?? `#${id}`).join(', ') || '(none - never fires)';
  const lines: string[] = [];
  lines.push(`# Server container documentation: ${meta.containerName}${meta.publicId ? ` (${meta.publicId})` : ''}`);
  lines.push('');
  lines.push(`${meta.workspaceName ? `Workspace: ${meta.workspaceName} · ` : ''}${meta.generatedAt ? `Generated: ${meta.generatedAt} · ` : ''}Configuration-level documentation from the GTM API (no runtime data).`);
  lines.push('');
  lines.push('## Overview');
  lines.push('');
  lines.push(`- Tagging server URL(s): ${s.taggingServerUrls.length ? s.taggingServerUrls.join(', ') : '(not set - host not wired yet)'}`);
  lines.push(`- Clients: ${s.clients.length} · Tags: ${s.tags.length} · Triggers: ${(s.triggers ?? []).length} · Variables: ${(s.variables ?? []).length} · Transformations: ${s.transformations.length}`);
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

export function serverContainerDocCsv(s: ServerContainerSnapshot, meta: ServerDocMeta): string {
  const trigById = new Map((s.triggers ?? []).map((t) => [t.triggerId, t]));
  const lines: string[] = [];
  lines.push(['Server container documentation', meta.containerName, meta.publicId ?? ''].map(csvCell).join(','));
  if (meta.workspaceName) lines.push(['Workspace', meta.workspaceName].map(csvCell).join(','));
  lines.push(['Tagging server URL(s)', s.taggingServerUrls.join(' ')].map(csvCell).join(','));
  lines.push('');
  lines.push(['Kind', 'Name', 'Type', 'Destination', 'Fires on', 'Uses variables', 'Notes'].join(','));
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
