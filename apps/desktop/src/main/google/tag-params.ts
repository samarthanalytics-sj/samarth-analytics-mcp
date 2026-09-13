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

/* ── Server GA4 (sgtmgaaw) "Parameters / Properties to Add / Edit" ── */

/** The map key for a server GA4 (`sgtmgaaw`) "Parameters/Properties to Add / Edit" row's NAME column.
 *  Verified against a real server-container export: the native sgtmgaaw tag keys each add/edit row (AND
 *  each `epToExclude`/`upToExclude` row) by `fieldName` + `value` — NOT `name`. Using `name` here left
 *  the parameter name unread, so GTM silently dropped the row. */
export const SERVER_PARAM_NAME_KEY = 'fieldName';

function serverParamRow(name: string, value: string): GtmParam {
  return { type: 'map', map: [{ type: 'template', key: SERVER_PARAM_NAME_KEY, value: name }, { type: 'template', key: 'value', value }] };
}
const serverRowName = (m: GtmParam): string | undefined => (m.map ?? []).find((x) => x.key === SERVER_PARAM_NAME_KEY)?.value;

/** Build a fresh server GA4 add-list Param — `eventParameters` = "Event Parameters to Add / Edit",
 *  `userProperties` = "User Properties to Add / Edit" — from name/value rows (empty-name rows dropped).
 *  List keys verified against a real sgtmgaaw export (the earlier `epToAdd`/`upToAdd` keys did not exist
 *  on the native tag, so GTM ignored the whole list). PURE. */
export function serverGa4ParamList(listKey: 'eventParameters' | 'userProperties', rows: Array<{ name: string; value: string }>): GtmParam {
  return { type: 'list', key: listKey, list: rows.filter((r) => r.name && r.name.trim() !== '').map((r) => serverParamRow(r.name, r.value)) };
}

/** Add event parameters (`eventParameters`) and/or user properties (`userProperties`) to a server GA4
 *  (`sgtmgaaw`) tag, read-modify-write: an existing NAME has its value updated (not duplicated), a new
 *  name is appended, and every other field (measurementId, eventName, epToIncludeDropdown, epToExclude,
 *  triggers) is preserved. PURE — returns a NEW tag object the caller PUTs back. */
export function addServerGa4Params(
  tag: Record<string, unknown>,
  opts: { eventParameters?: Array<{ name: string; value: string }>; userProperties?: Array<{ name: string; value: string }> },
): Record<string, unknown> {
  let parameter: GtmParam[] = [...((tag.parameter as GtmParam[] | undefined) ?? [])];
  const upsert = (listKey: string, rows: Array<{ name: string; value: string }>): void => {
    const clean = rows.filter((r) => r.name && r.name.trim() !== '');
    if (!clean.length) return;
    const idx = parameter.findIndex((p) => p.key === listKey);
    const list: GtmParam[] = idx >= 0 ? [...(parameter[idx].list ?? [])] : [];
    for (const { name, value } of clean) {
      const at = list.findIndex((m) => serverRowName(m) === name);
      if (at >= 0) list[at] = { ...list[at], map: (list[at].map ?? []).map((x) => (x.key === 'value' ? { ...x, value } : x)) };
      else list.push(serverParamRow(name, value));
    }
    const table: GtmParam = { type: 'list', key: listKey, list };
    parameter = idx >= 0 ? parameter.map((p, i) => (i === idx ? table : p)) : [...parameter, table];
  };
  upsert('eventParameters', opts.eventParameters ?? []);
  upsert('userProperties', opts.userProperties ?? []);
  return { ...tag, parameter };
}
