/**
 * Pure helpers for SAFELY editing a GTM tag's parameters.
 *
 * GTM's `tags.update` is a FULL replace (PUT) — any field omitted from the request
 * body is cleared. So a naive "send only the new parameter" update WIPES a GA4 event
 * tag's eventName / measurementId / measurementIdOverride / eventSettingsTable. These
 * helpers do the read-modify-write merge that keeps the rest of the tag intact.
 *
 * No runtime googleapis import — types only (erased at build).
 */

import type { tagmanager_v2 } from 'googleapis';

type Param = tagmanager_v2.Schema$Parameter;
type Tag = tagmanager_v2.Schema$Tag;

/** Merge `provided` parameters onto `existing` BY KEY: a provided param with the same
 *  key replaces the existing one; new keys are added; existing keys not provided are
 *  kept. Keyless params (rare for tags) are concatenated. PURE. */
export function mergeParametersByKey(existing: Param[], provided: Param[]): Param[] {
  const byKey = new Map<string, Param>();
  for (const p of existing) if (p.key) byKey.set(p.key, p);
  for (const p of provided) if (p.key) byKey.set(p.key, p);
  const keyless = [...existing.filter((p) => !p.key), ...provided.filter((p) => !p.key)];
  return [...byKey.values(), ...keyless];
}

/** The {parameter, parameterValue} map entry GA4 event params use inside the
 *  eventSettingsTable list (matches what GTM's UI + the create path produce). */
function eventParamMap(name: string, value: string): Param {
  return {
    type: 'map',
    map: [
      { type: 'template', key: 'parameter', value: name },
      { type: 'template', key: 'parameterValue', value: value },
    ],
  };
}

const mapName = (m: Param): string | undefined => (m.map ?? []).find((x) => x.key === 'parameter')?.value ?? undefined;

/** Add GA4 event parameters to a GA4 Event tag (type 'gaawe') by appending them to the
 *  tag's `eventSettingsTable` (the GTM-correct place — NOT top-level params), creating
 *  that table if absent. A param whose name already exists has its VALUE updated rather
 *  than duplicated. Every other field of the tag is preserved. PURE — returns a NEW tag
 *  resource (the caller PUTs it back). */
export function addEventParameters(tag: Tag, params: Array<{ name: string; value: string }>): Tag {
  const parameter: Param[] = [...(tag.parameter ?? [])];
  const idx = parameter.findIndex((p) => p.key === 'eventSettingsTable');
  const list: Param[] = idx >= 0 ? [...(parameter[idx].list ?? [])] : [];

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

  const table: Param = { type: 'list', key: 'eventSettingsTable', list };
  if (idx >= 0) parameter[idx] = table;
  else parameter.push(table);

  return { ...tag, parameter };
}
