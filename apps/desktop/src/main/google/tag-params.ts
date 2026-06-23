/**
 * Pure helpers for SAFELY editing a GTM tag's parameters from the desktop tools.
 *
 * GTM's tags.update is a FULL replace (PUT) — any field omitted from the request body
 * is cleared. So sending only the new parameters WIPES a GA4 event tag's eventName /
 * measurementId / measurementIdOverride (GTM then rejects with "value must not be
 * empty"). These helpers do the read-modify-write merge that keeps the rest intact.
 *
 * Mirrors src/utils/tagParams.ts in the MCP server (separate package — kept in sync).
 */

export interface GtmParam {
  type?: string;
  key?: string;
  value?: string;
  list?: GtmParam[];
  map?: GtmParam[];
}

/** Merge `provided` params onto `existing` BY KEY: same key replaces, new keys add,
 *  untouched keys are kept. Keyless params are concatenated. PURE. */
export function mergeParametersByKey(existing: GtmParam[], provided: GtmParam[]): GtmParam[] {
  const byKey = new Map<string, GtmParam>();
  for (const p of existing) if (p.key) byKey.set(p.key, p);
  for (const p of provided) if (p.key) byKey.set(p.key, p);
  const keyless = [...existing.filter((p) => !p.key), ...provided.filter((p) => !p.key)];
  return [...byKey.values(), ...keyless];
}

/** Set a single TEMPLATE parameter (by key) on a tag, preserving everything else.
 *  Used to point a GA4 event tag's `measurementIdOverride` — or a Google tag's
 *  `tagId` — at a Measurement ID or a {{Variable}}, without the model hand-building
 *  the parameter JSON (the source of the "template key" errors). PURE. */
export function setTemplateParam(
  tag: Record<string, unknown>,
  key: string,
  value: string,
): Record<string, unknown> {
  const existing = (tag.parameter as GtmParam[] | undefined) ?? [];
  return { ...tag, parameter: mergeParametersByKey(existing, [{ type: 'template', key, value }]) };
}

function eventParamMap(name: string, value: string): GtmParam {
  return {
    type: 'map',
    map: [
      { type: 'template', key: 'parameter', value: name },
      { type: 'template', key: 'parameterValue', value: value },
    ],
  };
}

const mapName = (m: GtmParam): string | undefined => (m.map ?? []).find((x) => x.key === 'parameter')?.value;

/** Append GA4 event parameters to a GA4 Event tag by adding them to its
 *  `eventSettingsTable` (the GTM-correct place — top-level params are ignored by GA4
 *  event tags), creating that table if absent. A param whose name already exists has
 *  its VALUE updated instead of duplicated. Every other field is preserved. PURE —
 *  returns a NEW tag object (the caller PUTs it back). */
export function addEventParameters(
  tag: Record<string, unknown>,
  params: Array<{ name: string; value: string }>,
): Record<string, unknown> {
  const parameter: GtmParam[] = [...((tag.parameter as GtmParam[] | undefined) ?? [])];
  const idx = parameter.findIndex((p) => p.key === 'eventSettingsTable');
  const list: GtmParam[] = idx >= 0 ? [...(parameter[idx].list ?? [])] : [];

  for (const { name, value } of params) {
    if (!name) continue;
    const existing = list.findIndex((m) => mapName(m) === name);
    if (existing >= 0) {
      const map = (list[existing].map ?? []).map((x) => (x.key === 'parameterValue' ? { ...x, value } : x));
      list[existing] = { ...list[existing], map };
    } else {
      list.push(eventParamMap(name, value));
    }
  }

  const table: GtmParam = { type: 'list', key: 'eventSettingsTable', list };
  if (idx >= 0) parameter[idx] = table;
  else parameter.push(table);

  return { ...tag, parameter };
}
