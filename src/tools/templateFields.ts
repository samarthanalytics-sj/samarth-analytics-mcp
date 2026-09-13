/**
 * Learning how to BUILD a tag type nobody documented.
 *
 * Creating a vendor tag needs two undocumented things: the string that goes in `type`, and the
 * parameter keys that tag expects. Google publishes neither for its ~68 native vendor templates,
 * and every gallery template invents its own field names. Recording guesses for all of that would
 * be worse than useless, because GTM accepts a tag with wrong keys and then renders it blank.
 *
 * So the server discovers both instead, from two sources that cannot be wrong:
 *
 *   templates_describe_fields   For a CUSTOM or GALLERY template. Every such template carries its
 *                               own source in `templateData`, and inside it the
 *                               ___TEMPLATE_PARAMETERS___ block declares every field the template
 *                               accepts, by name and type. That is the authoritative schema, and it
 *                               ships with the template itself.
 *
 *   tags_type_profile           For a NATIVE vendor template, where no templateData exists because
 *                               the template is built into GTM. If a container already has one of
 *                               these tags, that tag IS the documentation: its `type` is the real
 *                               code and its parameter keys are the real schema. This groups a
 *                               workspace's tags by type and reports both.
 *
 * Between them, a tag type can go from "unknown code" to "buildable" without anybody inventing a
 * field name.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { paginate } from '../utils/pagination.js';
import { jsonResult, errorResult, errorText } from '../utils/toolResponse.js';

const wsBase = z.object({
  accountId: z.string().describe('The GTM account ID.'),
  containerId: z.string().describe('The GTM container ID.'),
  workspaceId: z.string().describe('The GTM workspace ID.'),
});

export interface TemplateField {
  /** The key to use in a tag's `parameter` array. */
  name: string;
  /** GTM's field widget type, e.g. TEXT, SELECT, CHECKBOX, SIMPLE_TABLE. */
  type: string;
  /** The label shown in the GTM interface, when the template gives one. */
  displayName?: string;
  /** True when the field must be filled for the tag to validate. */
  required?: boolean;
  /** Allowed values, for SELECT fields. */
  options?: string[];
  /** Column keys, for table fields, since those nest their own parameters. */
  subFields?: string[];
}

/**
 * Pulls the field declarations out of a template's own source.
 *
 * A .tpl file is a sequence of ___SECTION___ blocks, one of which is a JSON array of field
 * descriptors. The parse is deliberately forgiving: templates in the wild carry trailing commas,
 * comments and unusual whitespace, and a template whose schema cannot be read should degrade to
 * "could not read the fields" rather than throw and lose the rest of the answer.
 */
export function parseTemplateParameters(templateData: string): TemplateField[] | null {
  const src = templateData ?? '';
  const start = src.indexOf('___TEMPLATE_PARAMETERS___');
  if (start < 0) return null;

  const after = src.slice(start + '___TEMPLATE_PARAMETERS___'.length);
  // The block ends at the next section marker, or at end of file for the last section.
  const end = after.search(/\n___[A-Z0-9_]+___/);
  const block = (end >= 0 ? after.slice(0, end) : after).trim();
  if (!block) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    // Trailing commas are the common cause and are safe to strip; anything else stays a failure.
    try {
      parsed = JSON.parse(block.replace(/,\s*([\]}])/g, '$1'));
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;

  const fields: TemplateField[] = [];
  const collect = (list: unknown[]): void => {
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      const type = typeof p['type'] === 'string' ? (p['type'] as string) : 'UNKNOWN';
      const subParams = Array.isArray(p['subParams']) ? (p['subParams'] as Record<string, unknown>[]) : [];

      // A GROUP is a purely visual container in the template interface. GTM stores its children as
      // TOP-LEVEL entries in a tag's `parameter` array and never stores the group's own name, and
      // groups nest. Emitting the group as a field pointed callers at a key GTM ignores while
      // hiding the children, and any NON_EMPTY validator on them, that the template really
      // requires, so recurse into it and report only the real fields.
      if (type === 'GROUP') {
        collect(subParams);
        continue;
      }

      const name = typeof p['name'] === 'string' ? p['name'] : '';
      if (!name) continue;

      const validators = Array.isArray(p['valueValidators']) ? (p['valueValidators'] as Record<string, unknown>[]) : [];
      const required = validators.some((v) => v && v['type'] === 'NON_EMPTY');

      const selectItems = Array.isArray(p['selectItems']) ? (p['selectItems'] as Record<string, unknown>[]) : [];
      const options = selectItems
        .map((s) => (typeof s?.['value'] === 'string' ? (s['value'] as string) : null))
        .filter((v): v is string => Boolean(v));

      const subFields = subParams
        .map((s) => (typeof s?.['name'] === 'string' ? (s['name'] as string) : null))
        .filter((v): v is string => Boolean(v));

      fields.push({
        name,
        type,
        ...(typeof p['displayName'] === 'string' ? { displayName: p['displayName'] as string } : {}),
        ...(required ? { required: true } : {}),
        ...(options.length ? { options } : {}),
        ...(subFields.length ? { subFields } : {}),
      });
    }
  };
  collect(parsed);
  return fields;
}

export interface TagTypeProfile {
  type: string;
  count: number;
  /** Parameter keys seen on tags of this type, most common first. */
  parameterKeys: string[];
  /** Keys present on EVERY tag of this type, so almost certainly required. */
  alwaysPresent: string[];
  /** A real tag name using this type, to look at in the interface. */
  exampleTagName: string;
}

/**
 * Summarises the tag types actually present in a workspace.
 *
 * The value is in `alwaysPresent`: a key that appears on every single tag of a type is one the tag
 * cannot do without, which is as close to a required-field list as an undocumented template gets.
 * Keys seen on only some tags are optional, and reporting the two separately stops a caller
 * treating an optional field as mandatory or the reverse.
 */
export function summariseTagTypes(
  tags: { type?: string | null; name?: string | null; parameter?: unknown }[],
): TagTypeProfile[] {
  const byType = new Map<string, { count: number; keys: Map<string, number>; example: string }>();

  for (const tag of tags) {
    const type = (tag?.type ?? '').trim();
    if (!type) continue;
    if (!byType.has(type)) byType.set(type, { count: 0, keys: new Map(), example: tag?.name || '(unnamed)' });
    const entry = byType.get(type)!;
    entry.count++;

    // A single-parameter resource can arrive as an object rather than an array.
    const params = Array.isArray(tag.parameter) ? tag.parameter : tag.parameter ? [tag.parameter] : [];
    const seen = new Set<string>();
    for (const p of params as Record<string, unknown>[]) {
      const key = typeof p?.['key'] === 'string' ? (p['key'] as string) : '';
      if (key) seen.add(key);
    }
    for (const key of seen) entry.keys.set(key, (entry.keys.get(key) ?? 0) + 1);
  }

  return [...byType.entries()]
    .map(([type, e]) => ({
      type,
      count: e.count,
      parameterKeys: [...e.keys.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
      alwaysPresent: [...e.keys.entries()].filter(([, n]) => n === e.count).map(([k]) => k).sort(),
      exampleTagName: e.example,
    }))
    .sort((a, b) => b.count - a.count);
}

export function registerTemplateFieldTools(server: McpServer, getClient: () => GtmClient): void {
  // ── templates_describe_fields ────────────────────────────────────────────
  server.registerTool(
    'templates_describe_fields',
    {
      description:
        'Read the FIELDS a custom or Community Gallery template accepts, straight from the ' +
        'template\'s own source. Call this after templates_import_from_gallery and BEFORE ' +
        'tags_create, so the tag is built with that template\'s real parameter keys instead of ' +
        'guessed ones. Returns each field\'s name (the key for the tag\'s `parameter` array), its ' +
        'widget type, its label, whether it is required, and any fixed options. Also returns the ' +
        'template\'s tagType, so one call gives everything tags_create needs. Read-only. ' +
        'Only works for custom and gallery templates: GTM\'s ~68 BUILT-IN vendor templates carry no ' +
        'source, so for those use tags_type_profile against a container that already has one.',
      inputSchema: wsBase.extend({
        templateId: z.string().describe('The template ID, from templates_list.'),
      }),
    },
    async ({ accountId, containerId, workspaceId, templateId }) => {
      try {
        const client = getClient();
        const api = client.accounts.containers.workspaces.templates as unknown as {
          get: (p: { path: string }) => Promise<{ data: Record<string, unknown> }>;
        };
        const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/templates/${templateId}`;
        const res = await api.get({ path });
        const tpl = res.data ?? {};

        const gallery = tpl['galleryReference'] as { galleryTemplateId?: string } | undefined;
        const tagType = gallery?.galleryTemplateId
          ? `cvt_${gallery.galleryTemplateId}`
          : `cvt_${(tpl['containerId'] as string) || containerId}_${(tpl['templateId'] as string) ?? templateId}`;

        const data = typeof tpl['templateData'] === 'string' ? (tpl['templateData'] as string) : '';
        const fields = parseTemplateParameters(data);

        if (fields === null) {
          return jsonResult({
            templateId,
            name: tpl['name'] ?? null,
            tagType,
            fields: null,
            note:
              'This template declares no readable ___TEMPLATE_PARAMETERS___ block, so its fields ' +
              'could not be read. Open it in the GTM interface to see them, or copy the parameter ' +
              'keys from an existing tag built on it. Do not guess field names: GTM accepts a tag ' +
              'with wrong keys and then renders it blank.',
          });
        }

        return jsonResult({
          templateId,
          name: tpl['name'] ?? null,
          tagType,
          fieldCount: fields.length,
          required: fields.filter((f) => f.required).map((f) => f.name),
          fields,
          note:
            'Use `tagType` as the tag\'s `type` and these `name` values as the keys in its ' +
            '`parameter` array. Fields listed under `required` must be present or the tag will not ' +
            'validate.',
        });
      } catch (err) {
        return errorResult('templates_describe_fields', err);
      }
    },
  );

  // ── tags_type_profile ────────────────────────────────────────────────────
  server.registerTool(
    'tags_type_profile',
    {
      description:
        'Group a workspace\'s existing tags by TYPE and report, for each, the parameter keys those ' +
        'tags actually use. This is how to learn an UNDOCUMENTED tag type: Google does not publish ' +
        'the type codes or field names for GTM\'s ~68 built-in vendor templates (Criteo, Twitter, ' +
        'Pinterest, Quora and the rest), but a container that already uses one contains the answer, ' +
        'because that tag\'s own type and keys are definitionally correct. Use it to AUDIT what a ' +
        'container runs, to find an unfamiliar type code, and to copy a working shape before ' +
        'creating a similar tag. `alwaysPresent` lists keys found on every tag of that type, which ' +
        'is the closest thing to a required-field list for a template with no published schema. ' +
        'Read-only.',
      inputSchema: wsBase.extend({
        type: z
          .string()
          .optional()
          .describe('Only profile this one type, e.g. "cvt_MRQN8" or an unfamiliar code.'),
      }),
    },
    async ({ accountId, containerId, workspaceId, type }) => {
      try {
        const client = getClient();
        const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
        const result = await paginate(
          (token) =>
            client.accounts.containers.workspaces.tags.list({ parent, pageToken: token }).then((r) => r.data),
          (data) => data.tag,
        );

        const tags = result.items as { type?: string | null; name?: string | null; parameter?: unknown }[];
        if (tags.length === 0) {
          return errorText('This workspace has no tags, so there is nothing to profile.');
        }

        let profiles = summariseTagTypes(tags);
        if (type && type.trim()) {
          const wanted = type.trim();
          profiles = profiles.filter((p) => p.type === wanted);
          if (profiles.length === 0) {
            return jsonResult({
              query: wanted,
              found: false,
              typesPresent: summariseTagTypes(tags).map((p) => p.type),
              note:
                'No tag of that type in this workspace. That means this container does not use it, ' +
                'not that the type is invalid.',
            });
          }
        }

        return jsonResult({
          tagsScanned: tags.length,
          distinctTypes: profiles.length,
          profiles,
          note:
            'These keys are observed, not declared: they are what tags in THIS container use, which ' +
            'makes them correct for this type but not necessarily complete. A key in ' +
            '`alwaysPresent` is almost certainly required. For a cvt_ type, ' +
            'templates_describe_fields returns the declared schema, which is better still.',
        });
      } catch (err) {
        return errorResult('tags_type_profile', err);
      }
    },
  );
}
