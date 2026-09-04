/**
 * The tag `type` for a custom template.
 *
 * This is worth a test out of proportion to its size, because getting it wrong is invisible: GTM
 * accepts a tag carrying a bogus cvt_ type without complaint, and the mistake only shows up later
 * as an unrecognised tag in the UI. The two shapes also look interchangeable, and the wrong one
 * (the workspace templateId) is the one that looks right.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { customTemplateType, registerServerSideTools } from '../tools/serverSide.js';
import type { GtmClient } from '../utils/gtmClient.js';

test('a gallery template uses the GALLERY id, not the workspace templateId', () => {
  const template = {
    containerId: '1234567',
    templateId: '12',
    galleryReference: {
      owner: 'facebook',
      repository: 'GoogleTagManager-WebTemplate-For-FacebookPixel',
      galleryTemplateId: 'MRQN8',
    },
  };
  // The trap: '12' is present, plausible, and wrong.
  assert.equal(customTemplateType(template, '1234567'), 'cvt_MRQN8');
});

test('a locally authored template is container-scoped', () => {
  const template = { containerId: '1234567', templateId: '12' };
  assert.equal(customTemplateType(template, '1234567'), 'cvt_1234567_12');
});

test('the container id falls back to the caller when the resource omits it', () => {
  assert.equal(customTemplateType({ templateId: '7' }, '999'), 'cvt_999_7');
});

test('the resource own containerId wins over the caller fallback', () => {
  // A template read from one container must never be labelled with another's id.
  assert.equal(customTemplateType({ containerId: '111', templateId: '7' }, '999'), 'cvt_111_7');
});

test('an empty galleryReference does not masquerade as a gallery template', () => {
  // galleryReference is present on some locally-authored templates with no galleryTemplateId;
  // treating "has the key" as "is from the gallery" would emit `cvt_undefined`.
  const template = { containerId: '1234567', templateId: '12', galleryReference: {} };
  assert.equal(customTemplateType(template, '1234567'), 'cvt_1234567_12');
});

test('a missing templateId still yields a parseable type rather than throwing', () => {
  assert.equal(customTemplateType({ containerId: '5' }, '5'), 'cvt_5_');
});

/**
 * The already-installed scan behind templates_import_from_gallery.
 *
 * The tool's whole promise is idempotency, and that promise is only as good as the scan: a template
 * the scan cannot see is imported a second time, leaving two copies and an ambiguous "which type do
 * I use?". The scan reads the workspace's template list, so it has to follow pagination, and the
 * fetch used to hand `paginate` the raw gaxios response rather than its body: nextPageToken sat one
 * level down where paginate never looks, so page 2 was never read.
 */

const GALLERY_TEMPLATE = {
  templateId: '42',
  containerId: '2',
  name: 'LinkedIn Insight Tag 2.0',
  galleryReference: {
    owner: 'linkedin',
    repository: 'linkedin-gtm-community-template',
    galleryTemplateId: 'AB12C',
  },
};

/** `pages` is an array of template arrays; page N carries a nextPageToken while more remain. */
function buildGalleryServer(pages: Record<string, unknown>[][]) {
  const listCalls: { parent: string; pageToken?: string }[] = [];
  const imports: Record<string, unknown>[] = [];
  const list = (params: { parent: string; pageToken?: string }) => {
    listCalls.push({ ...params });
    const idx = params.pageToken ? Number(params.pageToken) : 0;
    const hasNext = idx + 1 < pages.length;
    return Promise.resolve({
      data: { template: pages[idx], ...(hasNext ? { nextPageToken: String(idx + 1) } : {}) },
    });
  };
  // importFromGallery issues its REST call through the generated client's own auth, so the fake
  // has to carry that shape for the "not installed yet" path to reach the network at all.
  const client = {
    accounts: { containers: { workspaces: { templates: { list } } } },
    context: {
      _options: {
        auth: {
          request: (opts: Record<string, unknown>) => {
            imports.push(opts);
            return Promise.resolve({ data: { ...GALLERY_TEMPLATE, templateId: '99' } });
          },
        },
      },
    },
  } as unknown as GtmClient;
  const server = new McpServer(
    { name: 'serverside-test', version: '0.0.1' },
    { capabilities: { tools: {} } }
  );
  registerServerSideTools(server, () => client);
  return { server, listCalls, imports };
}

const IMPORT_ARGS = {
  accountId: '1',
  containerId: '2',
  workspaceId: '3',
  owner: 'linkedin',
  repository: 'linkedin-gtm-community-template',
  confirm: true,
};

async function runImport(server: McpServer): Promise<Record<string, unknown>> {
  const prevWrites = process.env.GTM_MCP_ENABLE_WRITES;
  const prevDryRun = process.env.DRY_RUN;
  process.env.GTM_MCP_ENABLE_WRITES = 'true';
  process.env.DRY_RUN = 'false';
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = (server as any)._registeredTools['templates_import_from_gallery'];
    const r = await tool.handler(IMPORT_ARGS, { requestId: 'test' });
    assert.ok(!r.isError, r.content?.[0]?.text);
    return JSON.parse(r.content[0].text);
  } finally {
    if (prevWrites === undefined) delete process.env.GTM_MCP_ENABLE_WRITES;
    else process.env.GTM_MCP_ENABLE_WRITES = prevWrites;
    if (prevDryRun === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = prevDryRun;
  }
}

test('REGRESSION: the installed-template scan follows nextPageToken instead of stopping at page 1', async () => {
  const { server, listCalls } = buildGalleryServer([[{ templateId: '1', containerId: '2' }], [GALLERY_TEMPLATE]]);
  await runImport(server);
  assert.equal(listCalls.length, 2, 'both pages must be read before deciding nothing is installed');
  assert.equal(listCalls[0]?.pageToken, undefined);
  assert.equal(listCalls[1]?.pageToken, '1');
});

test('REGRESSION: a template already installed on page 2 is returned, not imported again', async () => {
  // The sharpest one. Pre-fix the scan saw only page 1, so this reported imported:true and made
  // the duplicate the tool exists to prevent.
  const { server, imports } = buildGalleryServer([[{ templateId: '1', containerId: '2' }], [GALLERY_TEMPLATE]]);
  const body = await runImport(server);
  assert.equal(body['imported'], false);
  assert.equal(imports.length, 0, 'no gallery import may be issued for a template already present');
  assert.equal(body['tagType'], 'cvt_AB12C');
});

test('a template absent from every page is still imported', async () => {
  // Guards the other direction: the fix must not turn every call into "already installed".
  const { server, imports } = buildGalleryServer([
    [{ templateId: '1', containerId: '2' }],
    [{ templateId: '2', containerId: '2' }],
  ]);
  const body = await runImport(server);
  assert.equal(body['imported'], true);
  assert.equal(imports.length, 1);
});
