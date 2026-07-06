// Desktop tool-surface smoke test — the in-process counterpart to the root
// server's scripts/smoke-all-tools.mjs. It boots the REAL desktop tool registry
// against a FAKE GoogleDataService (no Electron, no network, no Google) and
// asserts the whole surface behaves and the write guardrails hold:
//
//   A. Read-only mode (no confirm fn): write tools are NOT registered, and
//      trying to call one is rejected — with ZERO data-layer mutations.
//   B. Approval is DELETE-ONLY: with a DECLINING confirm, every delete_* tool
//      returns { declined: true } with zero delete API calls, while every other
//      write applies directly (creates/edits never prompt).
//   C. Liveness: with an APPROVING confirm, every tool (read + write, both
//      products) is invoked once and returns a structured JSON response — no
//      throw, no hang.
//   D. Audit: audit_gtm_container returns counts + severity summary + findings,
//      auto-fixable findings carry a runnable fix with the workspace ids
//      injected, and the unused-variable finding offers a delete_gtm_variable fix.
//
// Run: npm --prefix apps/desktop run smoke   (tsx scripts/smoke-tools.ts)

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildToolRegistry } from '../src/main/tools/registry';
import type { ConfirmFn } from '../src/main/tools/registry';
import { AuditHistoryStore } from '../src/main/storage/audit-history';
import type { GoogleDataService } from '../src/main/google/data-service';
import { createSuggestedTags } from '../src/main/suggestions/suggestion-service';
import type { SuggestedTagView } from '../src/shared/ipc';

let ok = 0;
let fail = 0;
function record(name: string, passed: boolean, detail = ''): void {
  if (passed) ok++;
  else fail++;
  console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// Data-layer methods that MUTATE GTM. Used to prove read-only mode mutates
// nothing and declined deletes never reach the API.
const MUTATIONS = new Set([
  'createGtmWorkspace', 'createGtmTag', 'updateGtmTag', 'setGtmTagPaused',
  'addGa4EventParameters', 'addGa4ServerParameters', 'setGa4MeasurementId', 'setGtmTagConsent',
  'addGa4EventParametersToAllTags', 'setGa4MeasurementIdOnAllTags',
  'deleteGtmTag', 'deleteGtmTrigger', 'deleteGtmVariable',
  'enableGtmBuiltInVariables', 'createGtmTrigger', 'updateGtmTrigger', 'createGtmVariable',
  'createGtmFolder', 'moveEntitiesToFolder', 'renameGtmFolder', 'deleteGtmFolder',
  'createGtmEnvironment',
  'createServerContainer', 'createGtmClient', 'deleteGtmClient', 'createGtmTransformation', 'bootstrapServerSideTagging',
  'setWebServerContainerUrl', 'setServerContainerTaggingUrl', 'createMetaEmqVariables', 'copyWorkspaceResources', 'importGalleryTemplate',
  'setupEcommerceFunnel', 'setupServerEcommerceFunnel', 'createServerContainerFromWeb',
  'ga4AdminCreate', 'ga4AdminPatch', 'ga4AdminDelete', 'ga4AdminArchive',
  'ga4CreateProperty', 'ga4UpdateProperty', 'ga4DeleteProperty', 'ga4UpdateDataRetention', 'ga4UpdateAccount', 'ga4DeleteAccount',
]);

// A snapshot crafted so the audit produces every kind of finding: a paused GA4
// tag (auto-fix), an orphan Custom-HTML tag with document.write, an unused
// trigger (auto-fix), and an unused variable (auto-fix: delete).
const SNAPSHOT = {
  tags: [
    {
      tagId: '1', name: 'Paused GA4', type: 'gaawe', firingTriggerId: ['T1'], blockingTriggerId: [],
      paused: true, parameter: [{ key: 'measurementIdOverride', value: 'G-1' }, { key: 'eventName', value: 'purchase' }],
      consentSettings: { consentStatus: 'needed' },
    },
    {
      tagId: '2', name: 'Orphan HTML', type: 'html', firingTriggerId: [], blockingTriggerId: [],
      paused: false, parameter: [{ type: 'template', key: 'html', value: '<script>document.write(1)</script>' }],
      consentSettings: null,
    },
  ],
  triggers: [
    { triggerId: 'T1', name: 'Used', type: 'pageview', filter: [], autoEventFilter: [], customEventFilter: [], parameter: [] },
    { triggerId: 'T2', name: 'Unused', type: 'pageview', filter: [], autoEventFilter: [], customEventFilter: [], parameter: [] },
  ],
  variables: [{ variableId: 'V1', name: 'Lonely', type: 'c', parameter: [] }],
};

function makeFakeData(): { data: GoogleDataService; calls: string[]; mutations: () => number } {
  const calls: string[] = [];
  const r = <T>(name: string, ret: T): Promise<T> => {
    calls.push(name);
    return Promise.resolve(ret);
  };
  const data = {
    // reads
    listGtmAccounts: () => r('listGtmAccounts', [{ accountId: '1', name: 'Acct', path: 'accounts/1' }]),
    listGtmContainers: () => r('listGtmContainers', [{ containerId: '2', name: 'Web', publicId: 'GTM-X', path: '' }]),
    listGtmWorkspaces: () => r('listGtmWorkspaces', [{ workspaceId: '3', name: 'Default', path: '' }]),
    listGtmFolders: () => r('listGtmFolders', [{ folderId: '12', name: 'Marketing', path: '' }]),
    listGtmEnvironments: () => r('listGtmEnvironments', [{ environmentId: '7', name: 'Test', type: 'user', authorizationCode: 'A', url: '', snippet: { head: 'h', body: 'b' } }]),
    createGtmEnvironment: () => r('createGtmEnvironment', { environmentId: '7', name: 'Test', type: 'user', authorizationCode: 'A', url: '', snippet: { head: 'h', body: 'b' } }),
    listGtmTags: () => r('listGtmTags', [{ tagId: '1', name: 'T', type: 'gaawe' }]),
    listGtmVariables: () => r('listGtmVariables', [{ variableId: '1', name: 'V', type: 'jsm' }]),
    listGtmClients: () => r('listGtmClients', [{ clientId: '1', name: 'GA4', type: 'gaaw_client' }]),
    listGtmTransformations: () => r('listGtmTransformations', [{ transformationId: '1', name: 'X', type: 'sgtm_transformation' }]),
    createServerContainer: () => r('createServerContainer', { containerId: 'SC1', publicId: 'GTM-SERVER', name: 'Server', taggingServerUrls: [] }),
    createGtmClient: () => r('createGtmClient', { clientId: 'CL1', name: 'GA4', type: 'gaaw_client' }),
    createGtmTransformation: () => r('createGtmTransformation', { transformationId: 'X1', name: 'X', type: 'sgtm_transformation' }),
    bootstrapServerSideTagging: () =>
      r('bootstrapServerSideTagging', { container: { containerId: 'SC1', publicId: 'GTM-SERVER', name: 'Server', taggingServerUrls: [] }, workspaceId: 'w1', client: { clientId: 'CL1', name: 'GA4' }, trigger: { triggerId: 'TR1', name: 'All Events' }, serverTag: { tagId: 'T1', name: 'GA4 - Server' } }),
    createServerContainerFromWeb: () =>
      r('createServerContainerFromWeb', { serverContainer: { containerId: 'SC1', publicId: 'GTM-SERVER', name: 'Web - Server', taggingServerUrls: [] }, workspaceId: 'w1', measurementId: 'G-1', created: { client: 'GA4', trigger: 'All Events', serverTag: 'GA4 - Server' }, serverUrlSet: false, webWired: null, webNonGa4: [] }),
    deriveWebContainerMeasurementId: () => r('deriveWebContainerMeasurementId', 'G-1'),
    setWebServerContainerUrl: () => r('setWebServerContainerUrl', { tagId: '1', name: 'Google Tag', serverContainerUrl: 'https://sgtm.example.com' }),
    setServerContainerTaggingUrl: () => r('setServerContainerTaggingUrl', { containerId: 'SC1', name: 'Server', taggingServerUrls: ['https://sgtm.example.com'] }),
    createMetaEmqVariables: () => r('createMetaEmqVariables', { created: ['ed - fbp', 'ed - fbc'], skipped: [] }),
    setupEcommerceFunnel: () => r('setupEcommerceFunnel', { created: { variables: [], triggers: ['CE - purchase'], tags: ['GA4 - Event - Purchase Tag'] }, skipped: [] }),
    setupServerEcommerceFunnel: () => r('setupServerEcommerceFunnel', { created: { triggers: ['ga4 - purchase'], tags: ['GA4 - Purchase Tag (Server)'] }, skipped: [] }),
    verifyTrackingSetup: () => r('verifyTrackingSetup', { ok: true, passed: 1, warnings: 0, failures: 0, checks: [{ id: 'web_google_tag', label: 'Web: Google tag', status: 'pass', detail: 'ok' }] }),
    copyWorkspaceResources: () => r('copyWorkspaceResources', { variables: { created: [], skipped: [] }, triggers: { created: [], skipped: [] }, tags: { created: [], skipped: [] } }),
    // GA4 Admin write plumbing (generic + specials).
    ga4AdminCreate: () => r('ga4AdminCreate', { name: 'properties/1/x/1' }),
    ga4AdminPatch: () => r('ga4AdminPatch', { name: 'properties/1/x/1' }),
    ga4AdminDelete: (_v: string, _a: string, name: string) => r('ga4AdminDelete', { deleted: true, name }),
    ga4AdminArchive: (_v: string, _a: string, name: string) => r('ga4AdminArchive', { archived: true, name }),
    ga4CreateProperty: () => r('ga4CreateProperty', { name: 'properties/999' }),
    ga4UpdateProperty: () => r('ga4UpdateProperty', { name: 'properties/1' }),
    ga4DeleteProperty: () => r('ga4DeleteProperty', { name: 'properties/1' }),
    ga4UpdateDataRetention: () => r('ga4UpdateDataRetention', { name: 'properties/1/dataRetentionSettings' }),
    ga4UpdateAccount: () => r('ga4UpdateAccount', { name: 'accounts/1' }),
    ga4DeleteAccount: (name: string) => r('ga4DeleteAccount', { deleted: true, name }),
    listGtmTemplates: () => r('listGtmTemplates', [{ templateId: '261', name: 'Meta Pixel', type: 'cvt_5RM3Q', galleryOwner: 'facebook', galleryRepository: 'GoogleTagManager-WebTemplate-For-FacebookPixel' }]),
    importGalleryTemplate: () => r('importGalleryTemplate', { templateId: '261', name: 'Meta Pixel', type: 'cvt_5RM3Q', imported: true }),
    getServerContainerSnapshot: () =>
      r('getServerContainerSnapshot', {
        taggingServerUrls: ['https://sgtm.example.com'],
        clients: [{ clientId: '1', name: 'GA4 Client', type: 'gaaw_client' }],
        tags: [{ tagId: '1', name: 'GA4 - Server', type: 'sgtmgaaw', firingTriggerId: ['10'], blockingTriggerId: [], paused: false, parameter: [{ type: 'template', key: 'measurementId', value: 'G-1' }], consentSettings: null }],
        transformations: [],
      }),
    verifyServerEndpoint: () => r('verifyServerEndpoint', { url: 'https://sgtm.example.com/healthy', ok: true, status: 200, body: 'ok' }),
    listGtmTriggers: () => r('listGtmTriggers', [] as Array<{ triggerId: string; name: string; type: string }>),
    getGtmContainerSnapshot: () => r('getGtmContainerSnapshot', structuredClone(SNAPSHOT)),
    listGa4Accounts: () => r('listGa4Accounts', []),
    listGa4Properties: () => r('listGa4Properties', []),
    listGa4DataStreams: () => r('listGa4DataStreams', []),
    runGa4Report: () => r('runGa4Report', { dimensionHeaders: [], metricHeaders: [], rows: [] }),
    getGa4DataQuality: () => r('getGa4DataQuality', { totalSessions: 0, channelGroups: [], sourceMediums: [], windowDays: 28 }),
    listGa4Audiences: () => r('listGa4Audiences', []),
    getGa4AttributionSettings: () => r('getGa4AttributionSettings', { reportingAttributionModel: '', acquisitionConversionEventLookbackWindow: '', otherConversionEventLookbackWindow: '', adsWebConversionDataExportScope: '' }),
    getGa4GoogleSignals: () => r('getGa4GoogleSignals', { state: '', consent: '' }),
    listGa4MeasurementProtocolSecrets: () => r('listGa4MeasurementProtocolSecrets', []),
    listGa4BigQueryLinks: () => r('listGa4BigQueryLinks', []),
    listGa4FirebaseLinks: () => r('listGa4FirebaseLinks', []),
    getGa4CampaignPerformance: () => r('getGa4CampaignPerformance', { rows: [{ campaign: 'summer_sale', sessions: 100, keyEvents: 10, revenue: 500, engagementRate: 0.5 }], totalSessions: 200, windowDays: 28, startDate: '2026-06-01', endDate: '2026-06-28', currencyCode: 'USD' }),
    getGtmLiveVersionSnapshot: () => r('getGtmLiveVersionSnapshot', structuredClone(SNAPSHOT)),
    listGtmVersions: () => r('listGtmVersions', []),
    getGtmVersionSnapshot: () => r('getGtmVersionSnapshot', structuredClone(SNAPSHOT)),
    getGa4PropertySnapshot: () => r('getGa4PropertySnapshot', {
      property: 'properties/1', displayName: 'Site', timeZone: 'UTC', currencyCode: 'USD', industryCategory: '',
      dataRetention: { eventDataRetention: 'TWO_MONTHS', resetOnNewActivity: true },
      keyEvents: [], customDimensions: [], customMetrics: [], dataStreams: [], googleAdsLinks: 0, googleSignals: 'GOOGLE_SIGNALS_ENABLED',
    }),
    getGa4PropertyDetails: () => r('getGa4PropertyDetails', { property: 'properties/1', displayName: 'Site', timeZone: 'UTC', currencyCode: 'USD', industryCategory: '', serviceLevel: '', parent: 'accounts/1', createTime: '' }),
    listGa4KeyEvents: () => r('listGa4KeyEvents', []),
    listGa4CustomDimensions: () => r('listGa4CustomDimensions', []),
    listGa4CustomMetrics: () => r('listGa4CustomMetrics', []),
    listGa4GoogleAdsLinks: () => r('listGa4GoogleAdsLinks', []),
    getGa4DataRetention: () => r('getGa4DataRetention', { eventDataRetention: 'TWO_MONTHS', resetUserDataOnNewActivity: true }),
    getGa4EnhancedMeasurement: () => r('getGa4EnhancedMeasurement', { streamEnabled: true, scrollsEnabled: true, outboundClicksEnabled: true, siteSearchEnabled: false, videoEngagementEnabled: false, fileDownloadsEnabled: true, pageChangesEnabled: true, formInteractionsEnabled: false }),
    runGa4RealtimeReport: () => r('runGa4RealtimeReport', { dimensionHeaders: [], metricHeaders: [], rows: [] }),
    listGa4MeasurementIds: () => r('listGa4MeasurementIds', []),
    // writes (each records a mutation)
    createGtmWorkspace: () => r('createGtmWorkspace', { workspaceId: 'w9', name: 'WS', path: '' }),
    createGtmFolder: () => r('createGtmFolder', { folderId: 'f1', name: 'Analytics', path: '' }),
    moveEntitiesToFolder: () => r('moveEntitiesToFolder', { folderId: 'f1', moved: { tags: 1, triggers: 0, variables: 0 } }),
    renameGtmFolder: () => r('renameGtmFolder', { folderId: 'f1', name: 'Renamed', path: '' }),
    deleteGtmFolder: () => r('deleteGtmFolder', { deleted: true, folderId: 'f1' }),
    createGtmTag: () => r('createGtmTag', { tagId: 'TAG1', name: 'X', type: 'gaawe' }),
    updateGtmTag: () => r('updateGtmTag', { tagId: 'TAG1', name: 'X', type: 'gaawe' }),
    addGa4EventParameters: () => r('addGa4EventParameters', { tagId: 'TAG1', name: 'X', type: 'gaawe' }),
    addGa4ServerParameters: () => r('addGa4ServerParameters', { tagId: 'TAG15', name: 'GA4 Server', type: 'sgtmgaaw' }),
    setGa4MeasurementId: () => r('setGa4MeasurementId', { tagId: 'TAG1', name: 'X', type: 'gaawe' }),
    setGtmTagConsent: () => r('setGtmTagConsent', { tagId: 'TAG1', name: 'X', type: 'gaawe' }),
    addGa4EventParametersToAllTags: () => r('addGa4EventParametersToAllTags', { total: 1, updated: ['X'], failed: [] }),
    setGa4MeasurementIdOnAllTags: () => r('setGa4MeasurementIdOnAllTags', { total: 1, updated: ['X'], failed: [] }),
    setGtmTagPaused: () => r('setGtmTagPaused', { tagId: 'TAG1', name: 'X', type: 'gaawe' }),
    deleteGtmTag: () => r('deleteGtmTag', { deleted: true, tagId: '9' }),
    deleteGtmTrigger: () => r('deleteGtmTrigger', { deleted: true, triggerId: 'T2' }),
    deleteGtmVariable: () => r('deleteGtmVariable', { deleted: true, variableId: 'V1' }),
    deleteGtmClient: () => r('deleteGtmClient', { deleted: true, clientId: '4' }),
    enableGtmBuiltInVariables: (_a: string, _b: string, _c: string, types: string[]) => r('enableGtmBuiltInVariables', types),
    updateGtmTrigger: (_a: string, _b: string, _c: string, triggerId: string, patch: { name?: string; eventName?: string }) =>
      r('updateGtmTrigger', { triggerId, name: patch.name ?? 'T', type: 'customEvent', customEventName: patch.eventName ?? '' }),
    createGtmTrigger: (_a: string, _b: string, _c: string, t: Record<string, unknown>) =>
      r('createGtmTrigger', { triggerId: 'NEW1', name: String(t?.name ?? ''), type: String(t?.type ?? '') }),
    createGtmVariable: (_a: string, _b: string, _c: string, v: Record<string, unknown>) =>
      r('createGtmVariable', { variableId: 'V9', name: String(v?.name ?? ''), type: String(v?.type ?? '') }),
  } as unknown as GoogleDataService;
  return { data, calls, mutations: () => calls.filter((c) => MUTATIONS.has(c)).length };
}

// Build a minimal schema-valid argument object for a tool's inputSchema.
function synthesize(schema: unknown): unknown {
  const s = schema as { type?: string; enum?: unknown[]; properties?: Record<string, unknown>; required?: string[]; items?: unknown };
  if (!s || typeof s !== 'object') return undefined;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  switch (s.type) {
    case 'string': return 'x';
    case 'boolean': return false;
    case 'number':
    case 'integer': return 1;
    case 'array': return s.items ? [synthesize(s.items)] : [];
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = s.properties ?? {};
      // Fill ALL properties (not just required) so tools with conditionally-required fields
      // (e.g. create_server_tag's platform-specific measurementId/conversionId) get valid args.
      for (const key of Object.keys(props)) if (props[key] !== undefined) out[key] = synthesize(props[key]);
      return out;
    }
    default: return 'x';
  }
}

async function main(): Promise<void> {
  console.log('\nDesktop tool-surface smoke test:');

  const approve: ConfirmFn = async (p) => p.details; // approve unchanged (twice for destructive)
  const decline: ConfirmFn = async () => null;

  // Discover read vs write tool names from the registry itself.
  const readOnlyNames = new Set(buildToolRegistry(makeFakeData().data).list().map((t) => t.name));
  const fullList = buildToolRegistry(makeFakeData().data, approve).list();
  const writeNames = fullList.map((t) => t.name).filter((n) => !readOnlyNames.has(n));

  // ── A. Read-only mode: write tools are not registered, calling one fails,
  //       and nothing mutates. ────────────────────────────────────────────────
  {
    const fd = makeFakeData();
    const reg = buildToolRegistry(fd.data); // no confirm
    let blocked = 0;
    for (const name of writeNames) {
      try {
        await reg.execute(name, {});
      } catch (e) {
        if (/Unknown tool/.test((e as Error).message)) blocked++;
      }
    }
    record(
      'read-only registry hides all write tools + blocks calls',
      blocked === writeNames.length && fd.mutations() === 0,
      `${blocked}/${writeNames.length} write tools rejected, ${fd.mutations()} mutations`
    );
    record('read-only registry exposes the 52 read tools', readOnlyNames.size === 52, `${readOnlyNames.size} tools`);
  }

  // ── B. Approval is DELETE-ONLY: a declining confirm blocks every destructive
  //       tool (delete_* and GA4 archive_*), while non-destructive writes apply
  //       directly. Destructive is identified from the registry flag, not names. ──
  {
    const fd = makeFakeData();
    const reg = buildToolRegistry(fd.data, decline);
    const isDestructive = (n: string) => n.startsWith('delete_') || n.startsWith('archive_');
    const destructiveNames = writeNames.filter(isDestructive);
    let destructiveDeclined = 0;
    let othersApplied = 0;
    for (const name of writeNames) {
      const schema = fullList.find((t) => t.name === name)!.inputSchema;
      const out = JSON.parse(await reg.execute(name, synthesize(schema) as Record<string, unknown>));
      if (isDestructive(name)) {
        if (out?.declined === true) destructiveDeclined++;
      } else if (out?.declined !== true) {
        othersApplied++;
      }
    }
    // No delete/archive should have reached the data layer (GTM deletes + GA4 delete/archive).
    const destructiveCalls = fd.calls.filter((c) => /^delete|^ga4AdminDelete|^ga4AdminArchive|^ga4DeleteProperty|^ga4DeleteAccount/.test(c)).length;
    record(
      'declined confirm → every delete/archive declines (no destructive API call); creates/edits apply without approval',
      destructiveDeclined === destructiveNames.length && othersApplied === writeNames.length - destructiveNames.length && destructiveCalls === 0,
      `${destructiveDeclined}/${destructiveNames.length} destructive declined, ${othersApplied}/${writeNames.length - destructiveNames.length} non-destructive applied, ${destructiveCalls} destructive API calls`
    );
  }

  // ── C. Liveness: invoke every tool once under an approving confirm. ─────────
  {
    const fd = makeFakeData();
    const histDir = mkdtempSync(join(tmpdir(), 'samarth-smoke-hist-'));
    const history = new AuditHistoryStore(join(histDir, 'h.json'));
    const reg = buildToolRegistry(fd.data, approve, undefined, history); // all tools, monitoring enabled
    const tools = reg.list();
    let responded = 0;
    for (const t of tools) {
      try {
        const out = await reg.execute(t.name, synthesize(t.inputSchema) as Record<string, unknown>);
        JSON.parse(out); // must be a structured JSON response
        responded++;
      } catch (e) {
        record(`invoke ${t.name}`, false, (e as Error).message);
      }
    }
    record(
      'every tool returns a structured response',
      responded === tools.length,
      `${responded}/${tools.length} tools responded`
    );
    rmSync(histDir, { recursive: true, force: true });
  }

  // ── D. Audit: structured, actionable, ids-injected, variable-delete offered. ─
  {
    const reg = buildToolRegistry(makeFakeData().data); // audit is read-only
    const report = JSON.parse(
      await reg.execute('audit_gtm_container', { accountId: '1', containerId: '2', workspaceId: '3' })
    );
    const shapeOk =
      report?.counts && report?.summary && Array.isArray(report.findings) && report.findings.length > 0;
    record('audit returns counts + summary + findings', Boolean(shapeOk), `${report?.findings?.length} findings`);

    const fixes = (report.findings ?? []).filter((f: { fix?: unknown }) => f.fix);
    const idsInjected = fixes.every(
      (f: { fix: { args: Record<string, string> } }) =>
        f.fix.args.accountId === '1' && f.fix.args.containerId === '2' && f.fix.args.workspaceId === '3'
    );
    record('every auto-fix has the workspace ids injected', fixes.length > 0 && idsInjected, `${fixes.length} fixes`);

    const tools = fixes.map((f: { fix: { tool: string } }) => f.fix.tool);
    record('paused tag → set_gtm_tag_paused fix offered', tools.includes('set_gtm_tag_paused'));
    record('unused trigger → delete_gtm_trigger fix offered', tools.includes('delete_gtm_trigger'));

    const unusedVar = (report.findings ?? []).find(
      (f: { category: string; resource?: { kind: string }; fix?: { tool: string; args?: Record<string, string> }; autoFixable?: boolean }) =>
        f.category === 'unused' && f.resource?.kind === 'variable'
    );
    record(
      'unused variable → delete_gtm_variable fix offered (per-row delete)',
      Boolean(unusedVar) &&
        unusedVar.autoFixable === true &&
        unusedVar.fix?.tool === 'delete_gtm_variable' &&
        Boolean(unusedVar.fix?.args?.variableId)
    );
  }

  // ── E. Tag-suggestion create path: approved suggestions become draft tags via
  //       the SAME create_gtm_tracking_tag tool, sequentially, fail-isolated. ───
  {
    const fd = makeFakeData();
    const reg = buildToolRegistry(fd.data, approve, 'gtm');
    const sug = (id: string, tagName: string): SuggestedTagView => ({
      id, page: '/', label: '', evidence: '', confidence: 'high', enhancedMeasurementOverlap: false,
      platform: 'ga4_event', tagName, measurementId: '{{GA4 Measurement ID}}', eventName: 'email_click',
      trigger: { name: `Trig ${id}`, kind: 'link_click', clickUrlValue: 'mailto:', clickUrlOperator: 'startsWith' },
    });
    const ids = { accountId: '1', containerId: '2', workspaceId: '3' };
    const outcomes = await createSuggestedTags((n, a) => reg.execute(n, a), ids, [sug('a', 'Email A'), sug('b', 'Phone B')]);
    record(
      'tag-suggest create: approved suggestions create draft tags',
      outcomes.length === 2 && outcomes.every((o) => o.ok) && fd.mutations() > 0,
      `${outcomes.filter((o) => o.ok).length}/2 ok, ${fd.mutations()} mutations`
    );

    // Empty selection mutates nothing.
    const fd2 = makeFakeData();
    const reg2 = buildToolRegistry(fd2.data, approve, 'gtm');
    const none = await createSuggestedTags((n, a) => reg2.execute(n, a), ids, []);
    record('tag-suggest create: empty selection creates nothing', none.length === 0 && fd2.mutations() === 0);

    // Read-only registry (no confirm) → create path is refused, nothing mutates.
    const fd3 = makeFakeData();
    const reg3 = buildToolRegistry(fd3.data); // no confirm fn → no write tools
    const blocked = await createSuggestedTags((n, a) => reg3.execute(n, a), ids, [sug('a', 'Email A')]);
    record(
      'tag-suggest create: without a confirm fn the write is refused, nothing mutates',
      blocked.length === 1 && blocked[0].ok === false && fd3.mutations() === 0,
      blocked[0]?.error ?? ''
    );
  }

  console.log(`\nsmoke-tools: ${ok}/${ok + fail} checks passed${fail ? ` (${fail} FAILED)` : ''}.`);
  if (fail > 0) process.exit(1);
}

void main();
