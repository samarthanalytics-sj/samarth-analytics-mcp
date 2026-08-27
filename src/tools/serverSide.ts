/**
 * Workspace-scoped GTM resources that share an identical CRUD(+revert) shape:
 *   - clients         (server containers)
 *   - transformations (server containers)
 *   - zones           (web containers — zone delegation)
 *   - templates       (custom templates / gallery-installed templates)
 *   - gtag_config     (Google tag / gtag configuration; no revert)
 *
 * These resources have rich, deeply-nested bodies (parameters, consent
 * settings, template data, etc.). Rather than model every field in Zod, the
 * create/update tools accept the full resource as a JSON string (`bodyJson`),
 * mirroring the existing workspace_resolve_conflict pattern. List/get/delete
 * use the same guardrails and pagination as the rest of the server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { paginate, paginationFields, buildListResult } from '../utils/pagination.js';
import { jsonResult, textResult, errorResult, errorText } from '../utils/toolResponse.js';

/** A GTM resource collection that lives directly under a workspace. */
interface WorkspaceResourceApi {
  list: (params: { parent: string; pageToken?: string }) => Promise<{ data: Record<string, unknown> }>;
  get: (params: { path: string }) => Promise<{ data: unknown }>;
  create: (params: { parent: string; requestBody: Record<string, unknown> }) => Promise<{ data: unknown }>;
  update: (params: { path: string; fingerprint?: string; requestBody: Record<string, unknown> }) => Promise<{ data: unknown }>;
  delete: (params: { path: string }) => Promise<unknown>;
  revert?: (params: { path: string; fingerprint?: string }) => Promise<{ data: unknown }>;
}

interface ResourceSpec {
  /** Tool name prefix, e.g. "clients". */
  toolPrefix: string;
  /** GTM API path segment, e.g. "clients". */
  pathSegment: string;
  /** Key of the item ID argument, e.g. "clientId". */
  idArg: string;
  /** Response array key on list responses, e.g. "client". */
  listKey: string;
  /** Human label used in descriptions. */
  label: string;
  /** Whether this resource supports revert. */
  hasRevert: boolean;
  /** Selects the API collection off the GTM client for a workspace. */
  select: (client: GtmClient) => WorkspaceResourceApi;
  /**
   * Optional enrichment applied to every item returned by list and get.
   *
   * Exists for templates, whose single most useful fact — the tag `type` string you need to
   * build a tag on the template — is not a field on the resource at all. It has to be derived,
   * and the derivation is unobvious enough that leaving it to the caller produced tags GTM
   * rejects. Deriving it here means the answer arrives with the question.
   */
  decorate?: (item: Record<string, unknown>, containerId: string) => Record<string, unknown>;
}

/**
 * The tag `type` string for a custom template, which is what `tags_create` needs and what no
 * field on the template resource contains.
 *
 * There are two shapes, and the difference matters because guessing wrong is not a validation
 * error — GTM accepts the tag and the UI renders it as an unrecognised type:
 *
 *   gallery-installed   cvt_<galleryTemplateId>              e.g. cvt_MRQN8
 *   locally authored    cvt_<containerId>_<templateId>       e.g. cvt_1234567_12
 *
 * Note that a gallery template's type uses the GALLERY's id, NOT the workspace `templateId` it
 * was given on import. Those are different numbers, and the workspace one looks like the
 * plausible answer, which is exactly why it gets used by mistake.
 */
export function customTemplateType(
  template: Record<string, unknown>,
  fallbackContainerId: string
): string {
  const gallery = template['galleryReference'] as { galleryTemplateId?: string | null } | undefined;
  const galleryId = gallery?.galleryTemplateId;
  if (galleryId) return `cvt_${galleryId}`;
  const containerId = (template['containerId'] as string | undefined) || fallbackContainerId;
  const templateId = (template['templateId'] as string | undefined) ?? '';
  return `cvt_${containerId}_${templateId}`;
}

/** Adds the derived `tagType` to a template without disturbing the resource's own fields. */
function decorateTemplate(
  item: Record<string, unknown>,
  containerId: string
): Record<string, unknown> {
  return { ...item, tagType: customTemplateType(item, containerId) };
}

const wsBase = z.object({
  accountId: z.string().describe('The GTM account ID.'),
  containerId: z.string().describe('The GTM container ID.'),
  workspaceId: z.string().describe('The GTM workspace ID.'),
});

function parseBody(bodyJson: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const parsed = JSON.parse(bodyJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function registerResource(server: McpServer, getClient: () => GtmClient, spec: ResourceSpec): void {
  const wsPath = (a: string, c: string, w: string) =>
    `accounts/${a}/containers/${c}/workspaces/${w}`;
  const itemPath = (a: string, c: string, w: string, id: string) =>
    `${wsPath(a, c, w)}/${spec.pathSegment}/${id}`;

  // ── list ──────────────────────────────────────────────────────────────────
  server.registerTool(
    `${spec.toolPrefix}_list`,
    {
      description: `List all GTM ${spec.label} in a workspace. Automatically follows pagination.`,
      inputSchema: wsBase.extend(paginationFields),
    },
    async ({ accountId, containerId, workspaceId, pageToken, maxPages }) => {
      try {
        const api = spec.select(getClient());
        const parent = wsPath(accountId, containerId, workspaceId);
        const result = await paginate<Record<string, unknown>, Record<string, unknown>>(
          (token) => api.list({ parent, pageToken: token }).then((r) => r.data),
          (data) => data[spec.listKey] as Record<string, unknown>[] | undefined,
          { pageToken, maxPages }
        );
        const decorate = spec.decorate;
        const items = decorate ? result.items.map((i) => decorate(i, containerId)) : result.items;
        return jsonResult(buildListResult(spec.toolPrefix, { ...result, items }));
      } catch (err) {
        return errorResult(`${spec.toolPrefix}_list`, err);
      }
    }
  );

  // ── get ─────────────────────────────────────────────────────────────────--
  server.registerTool(
    `${spec.toolPrefix}_get`,
    {
      description: `Get a specific GTM ${spec.label.replace(/s$/, '')}.`,
      inputSchema: wsBase.extend({ [spec.idArg]: z.string().describe(`The ${spec.label} ID.`) }),
    },
    async (args) => {
      const { accountId, containerId, workspaceId } = args as Record<string, string>;
      const id = (args as Record<string, string>)[spec.idArg];
      try {
        const api = spec.select(getClient());
        const res = await api.get({ path: itemPath(accountId, containerId, workspaceId, id) });
        const decorate = spec.decorate;
        const body =
          decorate && res.data && typeof res.data === 'object'
            ? decorate(res.data as Record<string, unknown>, containerId)
            : res.data;
        return jsonResult(body);
      } catch (err) {
        return errorResult(`${spec.toolPrefix}_get`, err);
      }
    }
  );

  // ── create ─────────────────────────────────────────────────────────────────
  server.registerTool(
    `${spec.toolPrefix}_create`,
    {
      description:
        `[WRITE] Create a new GTM ${spec.label.replace(/s$/, '')}. ` +
        `Requires GTM_MCP_ENABLE_WRITES=true and confirm=true. ` +
        `Pass the full resource as a JSON string in bodyJson.`,
      inputSchema: wsBase.extend({
        bodyJson: z.string().describe(`Full ${spec.label} resource as a JSON string (e.g. {"name":"...","type":"..."}).`),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, containerId, workspaceId, bodyJson, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would create ${spec.label} in workspace ${workspaceId}`);
        }
        const parsed = parseBody(bodyJson);
        if (!parsed.ok) {
          return errorText('bodyJson must be a valid JSON object.');
        }
        const api = spec.select(getClient());
        const res = await api.create({
          parent: wsPath(accountId, containerId, workspaceId),
          requestBody: parsed.value,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult(`${spec.toolPrefix}_create`, err);
      }
    }
  );

  // ── update ─────────────────────────────────────────────────────────────────
  server.registerTool(
    `${spec.toolPrefix}_update`,
    {
      description:
        `[WRITE] Update an existing GTM ${spec.label.replace(/s$/, '')}. ` +
        `Requires GTM_MCP_ENABLE_WRITES=true and confirm=true. ` +
        `Pass the full resource as a JSON string in bodyJson.`,
      inputSchema: wsBase.extend({
        [spec.idArg]: z.string().describe(`The ${spec.label} ID to update.`),
        bodyJson: z.string().describe(`Full ${spec.label} resource as a JSON string.`),
        fingerprint: z.string().optional().describe('Current fingerprint (for optimistic locking).'),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async (args) => {
      const { accountId, containerId, workspaceId, bodyJson, fingerprint, confirm } = args as Record<string, unknown>;
      const id = (args as Record<string, string>)[spec.idArg];
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm as boolean | undefined, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would update ${spec.label} ${id} in workspace ${workspaceId}`);
        }
        const parsed = parseBody(bodyJson as string);
        if (!parsed.ok) {
          return errorText('bodyJson must be a valid JSON object.');
        }
        const api = spec.select(getClient());
        const res = await api.update({
          path: itemPath(accountId as string, containerId as string, workspaceId as string, id),
          ...(fingerprint ? { fingerprint: fingerprint as string } : {}),
          requestBody: parsed.value,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult(`${spec.toolPrefix}_update`, err);
      }
    }
  );

  // ── delete ─────────────────────────────────────────────────────────────────
  server.registerTool(
    `${spec.toolPrefix}_delete`,
    {
      description:
        `[DELETE] Delete a GTM ${spec.label.replace(/s$/, '')}. ` +
        `Requires GTM_MCP_ENABLE_DELETES=true and confirm=true.`,
      inputSchema: wsBase.extend({
        [spec.idArg]: z.string().describe(`The ${spec.label} ID to delete.`),
        confirm: z.boolean().describe('Must be true to confirm this delete operation.'),
      }),
    },
    async (args) => {
      const { accountId, containerId, workspaceId, confirm } = args as Record<string, unknown>;
      const id = (args as Record<string, string>)[spec.idArg];
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('delete', confirm as boolean | undefined, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would delete ${spec.label} ${id} from workspace ${workspaceId}`);
        }
        const api = spec.select(getClient());
        await api.delete({ path: itemPath(accountId as string, containerId as string, workspaceId as string, id) });
        return textResult(`${spec.label.replace(/s$/, '')} ${id} deleted from workspace ${workspaceId}.`);
      } catch (err) {
        return errorResult(`${spec.toolPrefix}_delete`, err);
      }
    }
  );

  // ── revert ─────────────────────────────────────────────────────────────────
  if (spec.hasRevert) {
    server.registerTool(
      `${spec.toolPrefix}_revert`,
      {
        description:
          `[WRITE] Revert workspace changes to a GTM ${spec.label.replace(/s$/, '')} back to its last container-version state. ` +
          `Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.`,
        inputSchema: wsBase.extend({
          [spec.idArg]: z.string().describe(`The ${spec.label} ID to revert.`),
          fingerprint: z.string().optional().describe('Current fingerprint (for optimistic locking).'),
          confirm: z.boolean().describe('Must be true to confirm this write operation.'),
        }),
      },
      async (args) => {
        const { accountId, containerId, workspaceId, fingerprint, confirm } = args as Record<string, unknown>;
        const id = (args as Record<string, string>)[spec.idArg];
        try {
          const config = getGuardrailConfig();
          const { dryRun } = checkGuardrails('write', confirm as boolean | undefined, config);
          if (dryRun) {
            return textResult(`[DRY RUN] Would revert ${spec.label} ${id} in workspace ${workspaceId}`);
          }
          const api = spec.select(getClient());
          if (!api.revert) {
            return errorText(`${spec.toolPrefix}_revert is not supported by the API.`);
          }
          const res = await api.revert({
            path: itemPath(accountId as string, containerId as string, workspaceId as string, id),
            ...(fingerprint ? { fingerprint: fingerprint as string } : {}),
          });
          return jsonResult(res.data);
        } catch (err) {
          return errorResult(`${spec.toolPrefix}_revert`, err);
        }
      }
    );
  }
}

export function registerServerSideTools(server: McpServer, getClient: () => GtmClient): void {
  const specs: ResourceSpec[] = [
    {
      toolPrefix: 'clients', pathSegment: 'clients', idArg: 'clientId', listKey: 'client',
      label: 'clients', hasRevert: true,
      select: (c) => c.accounts.containers.workspaces.clients as unknown as WorkspaceResourceApi,
    },
    {
      toolPrefix: 'transformations', pathSegment: 'transformations', idArg: 'transformationId', listKey: 'transformation',
      label: 'transformations', hasRevert: true,
      select: (c) => c.accounts.containers.workspaces.transformations as unknown as WorkspaceResourceApi,
    },
    {
      toolPrefix: 'zones', pathSegment: 'zones', idArg: 'zoneId', listKey: 'zone',
      label: 'zones', hasRevert: true,
      select: (c) => c.accounts.containers.workspaces.zones as unknown as WorkspaceResourceApi,
    },
    {
      toolPrefix: 'templates', pathSegment: 'templates', idArg: 'templateId', listKey: 'template',
      label: 'templates', hasRevert: true,
      select: (c) => c.accounts.containers.workspaces.templates as unknown as WorkspaceResourceApi,
      decorate: decorateTemplate,
    },
    {
      toolPrefix: 'gtag_config', pathSegment: 'gtag_config', idArg: 'gtagConfigId', listKey: 'gtagConfig',
      label: 'gtag configs', hasRevert: false,
      select: (c) => c.accounts.containers.workspaces.gtag_config as unknown as WorkspaceResourceApi,
    },
  ];

  for (const spec of specs) registerResource(server, getClient, spec);

  registerGalleryImport(server, getClient);
}

/** Common gallery templates, so the model does not have to guess an owner/repository pair. */
const GALLERY_EXAMPLES =
  'facebook/GoogleTagManager-WebTemplate-For-FacebookPixel (Meta Pixel), ' +
  'tiktok/gtm-template-pixel (TikTok), ' +
  'linkedin/linkedin-gtm-community-template (LinkedIn Insight Tag 2.0), ' +
  'Snapchat/snapchat-google-tag-manager (Snap Pixel), ' +
  'pinterest/ws-gtm-template (Pinterest, web) or pinterest/ss-gtm-template (Pinterest, server), ' +
  'stape-io/facebook-tag and stape-io/tiktok-tag (Stape server-side)';

/**
 * Installing a Community Template Gallery template into a workspace.
 *
 * This exists because the alternative is Custom HTML, and Custom HTML is a worse tag in four
 * specific ways: it runs as arbitrary page script rather than in GTM's sandbox, it declares no
 * permissions so a strict CSP can block it, it has no Consent Mode integration, and it rots
 * silently when the vendor changes their API. The methodology already tells the model to prefer a
 * gallery template; without this tool that advice had nothing behind it on this server and the
 * chat could only describe the manual steps.
 *
 * IDEMPOTENT BY DESIGN. Importing the same owner/repository twice would leave two copies of the
 * template in the workspace and make "which type do I use?" ambiguous, so an existing install is
 * detected first and returned unchanged. Callers can therefore run this without checking.
 */
function registerGalleryImport(server: McpServer, getClient: () => GtmClient): void {
  server.registerTool(
    'templates_import_from_gallery',
    {
      description:
        '[WRITE] Install a Community Template Gallery template into a workspace by GitHub owner and repository, ' +
        'so a THIRD-PARTY pixel can use its official sandboxed template instead of Custom HTML. ' +
        'NOT for Google\'s own tags. GA4, Google Ads and Floodlight are BUILT IN to GTM as native tag ' +
        'types (googtag, gaawe, awct, sp, flc), there is no gallery repository for them, and asking ' +
        'for one answers "404 Not found or permission denied". To build a GA4 event tag call ' +
        'tags_create with type "gaawe" directly; do not import anything first. ' +
        'Requires GTM_MCP_ENABLE_WRITES=true and confirm=true. ' +
        'The GTM API DOES support this (templates.import_from_gallery); never tell the user it is UI-only. ' +
        'Idempotent: importing one already present returns it unchanged rather than creating a duplicate. ' +
        'Returns the installed template. To build a tag on it you need its tag TYPE (a cvt_... string): READ ' +
        'that from the container rather than constructing it from the templateId, because the format is not ' +
        'what it appears to be. Pass the exact string as `type` to tags_create ' +
        'along with that template\'s own field keys (template-specific, e.g. Meta Pixel uses pixelId). ' +
        `Common pairs: ${GALLERY_EXAMPLES}.`,
      inputSchema: wsBase.extend({
        owner: z.string().describe('GitHub owner of the gallery template, e.g. "linkedin".'),
        repository: z.string().describe('GitHub repository, e.g. "linkedin-gtm-community-template".'),
        sha: z.string().optional().describe('Optional gallery version SHA. Defaults to the latest published version.'),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({ accountId, containerId, workspaceId, owner, repository, sha, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(
            `[DRY RUN] Would import gallery template ${owner}/${repository} into workspace ${workspaceId}`,
          );
        }

        const client = getClient();
        const api = client.accounts.containers.workspaces.templates as unknown as WorkspaceResourceApi;
        const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;

        // Already installed? Compared case-insensitively, because the gallery is not consistent
        // about capitalisation (Snapchat/snapchat-google-tag-manager) and a case mismatch would
        // import a second copy of a template that is already there.
        const wantOwner = owner.trim().toLowerCase();
        const wantRepo = repository.trim().toLowerCase();
        const existingPages = await paginate(
          (pageToken) => api.list({ parent, pageToken }),
          (data) => (data as { data?: { template?: Record<string, unknown>[] } }).data?.template,
        );
        const existing = existingPages.items.find((t) => {
          const ref = t.galleryReference as { owner?: string; repository?: string } | undefined;
          return ref?.owner?.toLowerCase() === wantOwner && ref?.repository?.toLowerCase() === wantRepo;
        });
        if (existing) {
          return jsonResult({
            imported: false,
            reason: 'This gallery template is already installed in the workspace; returning the existing one.',
            template: existing,
            tagType: customTemplateType(existing, containerId),
            tagTypeNote: TAG_TYPE_GUIDANCE,
          });
        }

        const imported = await importFromGallery(client, parent, owner, repository, sha);

        return jsonResult({
          imported: true,
          template: imported,
          tagType: customTemplateType(
            (imported ?? {}) as Record<string, unknown>,
            containerId,
          ),
          tagTypeNote: TAG_TYPE_GUIDANCE,
        });
      } catch (err) {
        return errorResult('templates_import_from_gallery', err);
      }
    }
  );
}

/**
 * Imports a gallery template over REST, because the SDK has no method for it.
 *
 * googleapis 140's tagmanager v2 client exposes list/get/create/update/delete/revert on templates
 * and NOTHING for the gallery: the generated client has no import method at all, in types or at
 * runtime. (The desktop app calls `import_from_gallery` happily because it uses the separate,
 * newer @googleapis/tagmanager package. Copying that call here produced
 * "api.import_from_gallery is not a function" against a live container.)
 *
 * The REST endpoint exists regardless, so this issues the request through the client's own
 * OAuth2Client. That matters: it reuses the same credentials, refresh behaviour and retry
 * configuration as every other call, rather than introducing a second way of talking to Google.
 *
 * The alternative was upgrading or adding a Google client package for one method. Not worth the
 * dependency risk across a 179-tool server.
 */
async function importFromGallery(
  client: GtmClient,
  parent: string,
  owner: string,
  repository: string,
  sha?: string,
): Promise<Record<string, unknown>> {
  // The auth lives on the generated client's context. Reached defensively: if a future googleapis
  // version moves it, this must fail with a sentence someone can act on rather than a TypeError.
  const auth = (client as unknown as { context?: { _options?: { auth?: unknown } } }).context?._options?.auth as
    | { request?: (opts: Record<string, unknown>) => Promise<{ data: unknown }> }
    | undefined;

  if (!auth || typeof auth.request !== 'function') {
    throw new Error(
      'Could not reach the authenticated request client to call templates:import_from_gallery. ' +
        'The googleapis client shape may have changed; the gallery import needs updating.',
    );
  }

  const url = `https://tagmanager.googleapis.com/tagmanager/v2/${parent}/templates:import_from_gallery`;
  const res = await auth.request({
    url,
    method: 'POST',
    params: {
      galleryOwner: owner,
      galleryRepository: repository,
      ...(sha ? { gallerySha: sha } : {}),
      // Gallery templates declare the permissions they need (network access, cookie reads) and the
      // API refuses the import without this acknowledgement. Set here rather than exposed as an
      // argument: a caller answering "no" gets a failed import and nothing else, so the choice is
      // not a real one. The permissions stay visible on the imported template.
      acknowledgePermissions: true,
    },
  });

  const data = res.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') {
    throw new Error('The gallery import returned no template. Check the owner and repository are correct.');
  }
  return data;
}

/**
 * Where the tag `type` for an installed template comes from.
 *
 * Deliberately NOT computed here. This used to return `cvt_<containerId>_<templateId>`, which is
 * not the format GTM actually uses: a real import produced `cvt_TB7ZX` against container
 * 223151851, so the constructed string was wrong and would have been passed straight into
 * tags_create as an invalid type.
 *
 * It happened to cause no harm only because the caller ignored it. That is luck, not design: a
 * convenience field that is confidently wrong is worse than an absent one, because the next caller
 * trusts it. The same fabrication the model is forbidden from doing should not be done by the tool
 * that instructs it.
 *
 * The type is a real property of the container's tag-type list, so it is read rather than derived:
 * the tool's response tells the caller where to get it.
 */
const TAG_TYPE_GUIDANCE =
  'Use the `tagType` field returned alongside this template as the `type` for tags_create. Do NOT ' +
  'build it yourself from templateId: a gallery template\'s type uses the GALLERY id ' +
  '(cvt_<galleryTemplateId>), not the workspace templateId it was assigned on import, and the two ' +
  'are different numbers. templates_list returns `tagType` for every installed template if you ' +
  'need to look one up later.';
