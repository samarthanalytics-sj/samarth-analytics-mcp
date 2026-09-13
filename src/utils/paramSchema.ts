/**
 * Shared GTM parameter schema — RECURSIVE so any tag/variable/trigger parameter
 * structure can be expressed, not just flat {type, key, value}.
 *
 * GTM parameters nest: a `type:"list"` param carries a `list` of params, and a
 * `type:"map"` param carries a `map` of params. The richest GA4/Ads tags depend on
 * this (e.g. a GA4 event tag's `eventSettingsTable` is a list of maps of
 * {parameter, parameterValue}; a Google tag's `configSettingsTable`; a lookup-table
 * variable's `map`). The previous flat schema couldn't express any of these, forcing
 * "use the GTM UI" — this removes that limitation.
 */

import { z } from 'zod';

/** A GTM parameter, possibly nested via `list`/`map`. */
export interface GtmParam {
  type: string;
  key?: string;
  value?: string;
  list?: GtmParam[];
  map?: GtmParam[];
}

export const gtmParameterSchema: z.ZodType<GtmParam> = z.lazy(() =>
  z.object({
    type: z.string().describe('template | integer | boolean | list | map | tagReference | triggerReference | template'),
    key: z.string().optional().describe('Parameter key/name (omit for entries inside a list).'),
    value: z.string().optional().describe('Scalar value (template/integer/boolean/reference). May be a GTM variable like {{Click Text}}.'),
    list: z.array(gtmParameterSchema).optional().describe('Child parameters when type="list".'),
    map: z.array(gtmParameterSchema).optional().describe('Child parameters when type="map".'),
  }),
);

/** An optional GTM parameter list that supports NESTED list/map params. */
export const gtmParameterArray = z
  .array(gtmParameterSchema)
  .optional()
  .describe(
    'GTM parameter list — supports NESTED list/map params. Example (a GA4 event parameter table): ' +
      '[{"type":"list","key":"eventSettingsTable","list":[{"type":"map","map":[' +
      '{"type":"template","key":"parameter","value":"click_text"},' +
      '{"type":"template","key":"parameterValue","value":"{{Click Text}}"}]}]}].',
  );
