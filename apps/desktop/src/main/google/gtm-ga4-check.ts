// Pure cross-product check: do the GA4 measurement ids CONFIGURED in a GTM
// container actually correspond to GA4 web streams the signed-in user can
// access? Catches typos, wrong ids, and ids that live on a different GA4
// account/login. No I/O — fully unit-testable. The registry tool supplies the
// container snapshot and the accessible measurement ids fetched from GA4.

import type { ContainerSnapshot } from './gtm-builders';

const GA4_ID = /\bG-[A-Z0-9]{4,}\b/i;

interface TagParam {
  key?: string;
  value?: string;
}

function paramValue(tag: { parameter?: Array<Record<string, unknown>> }, key: string): string | undefined {
  const p = (tag.parameter ?? []).find((x) => (x as TagParam).key === key && typeof (x as TagParam).value === 'string');
  const v = p ? String((p as TagParam).value) : undefined;
  // Treat an empty/whitespace value as ABSENT, so a present-but-empty
  // measurementIdOverride (a common GTM serialization) doesn't shadow the real
  // measurementId/tagId via the ?? chain below.
  return v && v.trim() ? v : undefined;
}

/** A GA4 measurement id a GTM tag is configured to send to. */
export interface ConfiguredGa4Id {
  /** The G-XXXXXXX id, uppercased. */
  id: string;
  /** The configuring tag's name. */
  tag: string;
}
export interface ConfiguredGa4Ids {
  ids: ConfiguredGa4Id[];
  /** Tags whose measurement id is a {{variable}} (can't be resolved statically). */
  variableRefs: Array<{ tag: string; reference: string }>;
}

/** Extract literal GA4 measurement ids (and {{variable}} references) from a
 *  container's GA4 tags: GA4 event (gaawe), GA4 config (gaawc), the unified
 *  Google tag (googtag), and Custom HTML gtag snippets. */
export function extractConfiguredGa4Ids(snapshot: ContainerSnapshot): ConfiguredGa4Ids {
  const ids: ConfiguredGa4Id[] = [];
  const variableRefs: Array<{ tag: string; reference: string }> = [];

  for (const tag of snapshot.tags) {
    const type = (tag.type ?? '').toLowerCase();
    const name = tag.name || type || '(unnamed tag)';
    const candidates: string[] = [];

    if (type === 'gaawe' || type === 'gaawc' || type === 'googtag') {
      const v = paramValue(tag, 'measurementIdOverride') ?? paramValue(tag, 'measurementId') ?? paramValue(tag, 'tagId');
      if (v) candidates.push(v);
    } else if (type === 'html') {
      const html = paramValue(tag, 'html') ?? '';
      // {4,} to match the GA4_ID validator; the gtag-config / ?id= context (not
      // arbitrary text) is what prevents false matches, so the length floor
      // need not differ between the two paths.
      const m = html.match(/(?:gtag\(\s*['"]config['"]\s*,\s*['"]|[?&]id=)(G-[A-Z0-9]{4,})/i);
      if (m) candidates.push(m[1]);
    }

    for (const v of candidates) {
      const literal = v.match(GA4_ID);
      if (literal) ids.push({ id: literal[0].toUpperCase(), tag: name });
      else if (v.includes('{{')) variableRefs.push({ tag: name, reference: v });
    }
  }

  // De-dupe by id+tag.
  const seen = new Set<string>();
  const dedupedIds = ids.filter((x) => {
    const k = `${x.id}|${x.tag}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  return { ids: dedupedIds, variableRefs };
}

/** Like extractConfiguredGa4Ids, but ALSO resolves a `{{variable}}` measurement-id reference
 *  that points at a CONSTANT variable (type 'c') to that constant's literal G- value — the
 *  GTM API CAN read a Constant's value (it lives in parameter[].value). Returns the distinct
 *  literal ids (direct + resolved) plus the references that still couldn't be resolved. */
export function resolveGa4MeasurementIds(snapshot: ContainerSnapshot): { ids: string[]; unresolvedRefs: string[] } {
  const { ids, variableRefs } = extractConfiguredGa4Ids(snapshot);
  const found = new Set(ids.map((x) => x.id));

  // Constant variable name (lowercased) → its literal value.
  const constants = new Map<string, string>();
  for (const v of snapshot.variables) {
    if ((v.type ?? '').toLowerCase() !== 'c') continue;
    const p = (v.parameter ?? []).find((x) => (x as TagParam).key === 'value');
    const val = p ? String((p as TagParam).value ?? '') : '';
    if (val) constants.set((v.name ?? '').toLowerCase(), val);
  }

  const unresolvedRefs: string[] = [];
  for (const ref of variableRefs) {
    let resolved = false;
    for (const m of ref.reference.matchAll(/\{\{([^}]+)\}\}/g)) {
      const val = constants.get(m[1].trim().toLowerCase());
      const lit = val ? val.match(GA4_ID) : null;
      if (lit) {
        found.add(lit[0].toUpperCase());
        resolved = true;
      }
    }
    if (!resolved) unresolvedRefs.push(ref.reference);
  }
  return { ids: Array.from(found), unresolvedRefs };
}

export interface AccessibleStream {
  measurementId: string;
  property: string;
  propertyDisplayName: string;
}

export interface MeasurementIdCrossCheck {
  /** Configured ids that match an accessible GA4 web stream. */
  matched: Array<{ id: string; tag: string; property: string; propertyDisplayName: string }>;
  /** Configured ids NOT found in any accessible GA4 stream. */
  notFound: Array<{ id: string; tag: string }>;
  /** Tags whose measurement id is a {{variable}} (not statically checkable). */
  usesVariable: Array<{ tag: string; reference: string }>;
  summary: { configured: number; matched: number; notFound: number; usesVariable: number };
}

/** Cross-check configured GA4 ids against the GA4 streams the user can access. */
export function crossCheckMeasurementIds(
  configured: ConfiguredGa4Ids,
  accessible: AccessibleStream[]
): MeasurementIdCrossCheck {
  const byId = new Map<string, AccessibleStream>();
  for (const s of accessible) {
    if (s.measurementId) byId.set(s.measurementId.toUpperCase(), s);
  }

  const matched: MeasurementIdCrossCheck['matched'] = [];
  const notFound: MeasurementIdCrossCheck['notFound'] = [];
  for (const c of configured.ids) {
    const hit = byId.get(c.id.toUpperCase());
    if (hit) matched.push({ id: c.id, tag: c.tag, property: hit.property, propertyDisplayName: hit.propertyDisplayName });
    else notFound.push({ id: c.id, tag: c.tag });
  }

  return {
    matched,
    notFound,
    usesVariable: configured.variableRefs,
    summary: {
      configured: configured.ids.length,
      matched: matched.length,
      notFound: notFound.length,
      usesVariable: configured.variableRefs.length,
    },
  };
}
