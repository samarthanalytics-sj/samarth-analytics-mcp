/**
 * GTM container → ConsentConfigInput bridge.
 *
 * Accepts a container export produced by the samarth-gtm-mcp `export_container`
 * tool with `format:"full"` (or any object exposing tags/triggers/variables
 * arrays of raw GTM API objects) and maps it to the shared consent engine's
 * CONFIG input. This is what unlocks the engine's "reconciled" coverage:
 * configured consent intent checked against observed runtime behaviour.
 *
 * The textBlob construction is a faithful port of collectTextBlob/walkParam in
 * apps/portal/api/gtm/audit.ts so findings match the portal's CONFIG layer:
 * lower-cased concatenation of every tag/variable name+type+param key/value
 * (triggers are intentionally excluded, as in the portal).
 */

import type { ConsentConfigInput } from '../../../portal/shared/consent-audit.js';

interface RawParam {
  key?: string;
  value?: string;
  list?: RawParam[];
  map?: RawParam[];
}
interface RawEntity {
  name?: string;
  type?: string;
  parameter?: RawParam[];
  /** Present only in the "summary"/"names_only" export formats (param stripped). */
  paramCount?: number;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Record<string, unknown>[]) : [];
}

function walkParam(p: RawParam, sink: string[]): void {
  if (p.key) sink.push(p.key);
  if (p.value) sink.push(p.value);
  for (const child of p.list ?? []) walkParam(child, sink);
  for (const child of p.map ?? []) walkParam(child, sink);
}

function collectTextBlob(tags: RawEntity[], variables: RawEntity[]): string {
  const parts: string[] = [];
  for (const t of tags) {
    parts.push(t.name ?? '', t.type ?? '');
    for (const p of t.parameter ?? []) walkParam(p, parts);
  }
  for (const v of variables) {
    parts.push(v.name ?? '', v.type ?? '');
    for (const p of v.parameter ?? []) walkParam(p, parts);
  }
  return parts.join('\n').toLowerCase();
}

/** Read container.usageContext (web/server) from wherever the export nests it. */
function readUsageContexts(obj: Record<string, unknown>, container: Record<string, unknown>): string[] {
  const candidates = [
    container.usageContext,
    (container.container as Record<string, unknown> | undefined)?.usageContext,
    (obj.workspace as Record<string, unknown> | undefined)?.usageContext,
    obj.usageContext,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      return c.map((u) => String(u).toLowerCase());
    }
  }
  return [];
}

/**
 * A "summary"/"names_only" export strips per-param data (keeping only
 * paramCount), which would silently weaken every CONFIG/reconcile rule. Detect
 * that case so the caller gets a clear instruction instead of hollow findings.
 */
function looksLikeSummaryExport(tags: RawEntity[]): boolean {
  if (tags.length === 0) return false;
  const anyParams = tags.some((t) => Array.isArray(t.parameter) && t.parameter.length > 0);
  const anyParamCount = tags.some((t) => typeof t.paramCount === 'number' && t.paramCount > 0);
  return !anyParams && anyParamCount;
}

export class GtmContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GtmContainerError';
  }
}

/**
 * Map a parsed GTM container export to ConsentConfigInput. Liberal in what it
 * accepts: the arrays may sit at the top level, under a `container` key, or
 * under a `workspace`-style wrapper.
 */
export function parseGtmContainer(raw: unknown): ConsentConfigInput {
  if (!raw || typeof raw !== 'object') {
    throw new GtmContainerError(
      'gtmContainer must be the parsed JSON object from export_container (format:"full").',
    );
  }
  const obj = raw as Record<string, unknown>;
  const container =
    obj.container && typeof obj.container === 'object' ? (obj.container as Record<string, unknown>) : obj;

  const tags = asArray(container.tags ?? obj.tags);
  const triggers = asArray(container.triggers ?? obj.triggers);
  const variables = asArray(container.variables ?? obj.variables);

  if (tags.length === 0 && triggers.length === 0 && variables.length === 0) {
    throw new GtmContainerError(
      'gtmContainer has no tags/triggers/variables. Pass the parsed export_container JSON (format:"full").',
    );
  }
  if (looksLikeSummaryExport(tags as RawEntity[])) {
    throw new GtmContainerError(
      'gtmContainer looks like a "summary" or "names_only" export (parameters stripped). ' +
        'Re-run export_container with format:"full" so consent settings and parameters are present.',
    );
  }

  return {
    tags: tags as unknown as ConsentConfigInput['tags'],
    triggers: triggers as unknown as ConsentConfigInput['triggers'],
    variables: variables as unknown as ConsentConfigInput['variables'],
    textBlob: collectTextBlob(tags as RawEntity[], variables as RawEntity[]),
    usageContexts: readUsageContexts(obj, container),
  };
}
