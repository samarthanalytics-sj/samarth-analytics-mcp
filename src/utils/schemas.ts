/**
 * Shared Zod input fragments for MCP tools.
 *
 * `workspaceScope` is the bare account/container/workspace selector used by the
 * variables, triggers, builtInVariables and folders tools. It is intentionally
 * NOT used by the tags and serverSide tools: those annotate each field with
 * `.describe(...)`, and the description text is exposed as part of the tool's
 * inputSchema — adopting the bare version there would change the published API
 * shape. Keep this fragment description-free so it stays byte-identical to the
 * inline `wsBase` it replaces.
 *
 * ID fields
 * ---------
 * Every GTM id a tool pastes into a resource path (`accounts/${accountId}/containers/...`) MUST use
 * `gtmId` (or one of its siblings below), never a bare `z.string()`. googleapis expands `{+path}` as a
 * RESERVED string, so '/', ':', '?', '#' and '%XX' pass into the URL raw: a containerId of
 * '2/versions/5:publish#' turned the read-only workspace_quick_preview into
 * `POST .../versions/5:publish` (the '#' drops the real suffix as a fragment), i.e. a live publish
 * with every write/publish flag off. Rejecting anything that is not an id at the schema means the
 * smuggled value never reaches a handler. utils/googleRequestGuard.ts is the HTTP-level backstop for
 * any field this misses.
 *
 * Do not reuse guardrails.validateId's /^[\d/]+$/: it still allows '/', which rebuilds the path.
 */

import { z } from 'zod';

/** A GTM API entity id (account, container, workspace, tag, trigger, version, ...): digits only. */
export const GTM_ID_PATTERN = /^\d+$/;

export const gtmId = z
  .string()
  .regex(GTM_ID_PATTERN, 'must be a numeric GTM id (digits only, e.g. "123456")');

/** A container version id, or "live" where the tool resolves that to the live version itself. */
export const gtmVersionIdOrLive = z
  .string()
  .regex(/^(\d+|live)$/, 'must be a numeric GTM container version id or "live"');

/**
 * One opaque path segment that is not always numeric (e.g. a destination link id). Letters, digits,
 * '_' and '-' only, so it can never add a path segment, a ':verb', a query or a fragment.
 */
export const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

export const pathSegmentId = z
  .string()
  .regex(PATH_SEGMENT_PATTERN, 'must be a single id segment (letters, digits, "_" or "-" only)');

export const workspaceScope = z.object({
  accountId: gtmId,
  containerId: gtmId,
  workspaceId: gtmId,
});

// ── GA4 ────────────────────────────────────────────────────────────────────────
// GA4 tools accept either the bare id or the resource-name form, and have always trimmed
// surrounding whitespace before building the name, so the patterns allow both. Anything else
// (':archive', '#', '?', '..', extra segments) is refused: googleapis expands `{+parent}` /
// `{+name}` as reserved strings, so a property of '1/customDimensions/7:archive#' used to turn
// ga4_create_audience into `POST .../customDimensions/7:archive`, an irreversible archive with
// only the WRITES flag on. utils/ga4Errors.ts re-checks these at runtime when building names.

/** "123456789" or "properties/123456789". */
export const GA4_PROPERTY_PATTERN = /^\s*(properties\/)?\d+\s*$/;
/** "123456" or "accounts/123456". */
export const GA4_ACCOUNT_PATTERN = /^\s*(accounts\/)?\d+\s*$/;
/** "987654" or "dataStreams/987654". */
export const GA4_DATA_STREAM_PATTERN = /^\s*(dataStreams\/)?\d+\s*$/;

export const ga4PropertyId = z
  .string()
  .regex(GA4_PROPERTY_PATTERN, 'must be a GA4 property id: "123456789" or "properties/123456789"');
export const ga4AccountId = z
  .string()
  .regex(GA4_ACCOUNT_PATTERN, 'must be a GA4 account id: "123456" or "accounts/123456"');
export const ga4DataStreamId = z
  .string()
  .regex(GA4_DATA_STREAM_PATTERN, 'must be a GA4 data stream id: "987654" or "dataStreams/987654"');

export type Ga4ParentKind = 'property' | 'dataStream' | 'account';

const GA4_PARENT_NAME: Record<Ga4ParentKind, string> = {
  property: 'properties/\\d+',
  dataStream: 'properties/\\d+/dataStreams/\\d+',
  account: 'accounts/\\d+',
};

/**
 * The exact full resource name of one item in a GA4 collection, e.g. for ('property', 'keyEvents')
 * `properties/<digits>/keyEvents/<id>`. Used to refuse an update/delete/archive `name` that points
 * at a different resource kind (ga4_delete_key_event {name:'accounts/123'} used to trash the account).
 */
export function ga4ResourceNamePattern(parent: Ga4ParentKind, collection: string): RegExp {
  return new RegExp(`^\\s*${GA4_PARENT_NAME[parent]}/${collection}/[A-Za-z0-9_-]+\\s*$`);
}

/** A human template for the same shape, for descriptions and error messages. */
export function ga4ResourceNameExample(parent: Ga4ParentKind, collection: string): string {
  const head =
    parent === 'account' ? 'accounts/{account}' : parent === 'dataStream' ? 'properties/{property}/dataStreams/{stream}' : 'properties/{property}';
  return `${head}/${collection}/{id}`;
}
