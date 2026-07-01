import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildToolRegistry, type GtmContextControl } from '../registry';
import { AuditHistoryStore } from '../../storage/audit-history';
import type { GoogleDataService } from '../../google/data-service';
import type { GtmContext } from '../../../shared/ipc';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

// Records calls so we can assert the registry routes args correctly.
function fakeData(
  opts: {
    existingTriggers?: Array<{ triggerId: string; name: string; type: string; customEventName?: string }>;
    existingVariables?: Array<{ variableId: string; name: string; type: string }>;
    snapshot?: {
      tags: Array<Record<string, unknown>>;
      triggers: Array<Record<string, unknown>>;
      variables: Array<Record<string, unknown>>;
    };
    liveSnapshot?: {
      tags: Array<Record<string, unknown>>;
      triggers: Array<Record<string, unknown>>;
      variables: Array<Record<string, unknown>>;
    } | null;
  } = {}
): { data: GoogleDataService; calls: string[] } {
  const calls: string[] = [];
  const data = {
    listGtmAccounts: async () => {
      calls.push('gtmAccounts');
      return [{ accountId: '1', name: 'A', path: 'accounts/1' }];
    },
    listGtmContainers: async (id: string) => {
      calls.push(`gtmContainers:${id}`);
      return [];
    },
    listGa4Accounts: async () => {
      calls.push('ga4Accounts');
      return [];
    },
    listGa4Properties: async (account: string) => {
      calls.push(`ga4Properties:${account}`);
      return [];
    },
    listGtmWorkspaces: async (a: string, c: string) => {
      calls.push(`gtmWorkspaces:${a}:${c}`);
      return [];
    },
    listGtmTags: async (a: string, c: string, w: string) => {
      calls.push(`gtmTags:${a}:${c}:${w}`);
      return [];
    },
    listGtmTriggers: async (a: string, c: string, w: string) => {
      calls.push(`listTriggers:${a}:${c}:${w}`);
      return opts.existingTriggers ?? [];
    },
    listGtmVariables: async (a: string, c: string, w: string) => {
      calls.push(`listVariables:${a}:${c}:${w}`);
      return opts.existingVariables ?? [];
    },
    listGtmClients: async () => {
      calls.push('listClients');
      return [];
    },
    listGtmTransformations: async () => {
      calls.push('listTransformations');
      return [];
    },
    createServerContainer: async (a: string, name: string) => {
      calls.push(`createServerContainer:${a}:${name}`);
      return { containerId: 'SC1', publicId: 'GTM-SERVER', name, taggingServerUrls: [] };
    },
    createGtmClient: async (a: string, c: string, w: string, cl: Record<string, unknown>) => {
      calls.push(`createClient:${a}:${c}:${w}:${String(cl.type ?? '')}`);
      return { clientId: 'CL1', name: String(cl.name ?? ''), type: String(cl.type ?? '') };
    },
    deleteGtmClient: async (_a: string, _c: string, _w: string, clientId: string) => {
      calls.push(`deleteClient:${clientId}`);
      return { deleted: true, clientId };
    },
    createGtmTransformation: async (a: string, c: string, w: string, x: Record<string, unknown>) => {
      calls.push(`createTransformation:${a}:${c}:${w}`);
      return { transformationId: 'X1', name: String(x.name ?? ''), type: String(x.type ?? '') };
    },
    deriveWebContainerMeasurementId: async (a: string, webContainerId: string) => {
      calls.push(`deriveMid:${a}:${webContainerId}`);
      return 'G-WEB123';
    },
    bootstrapServerSideTagging: async (a: string, name: string, mid: string) => {
      calls.push(`bootstrapServer:${a}:${name}:${mid}`);
      return {
        container: { containerId: 'SC1', publicId: 'GTM-SERVER', name, taggingServerUrls: [] },
        workspaceId: 'w1',
        client: { clientId: 'CL1', name: 'GA4' },
        trigger: { triggerId: 'TR1', name: 'All Events' },
        serverTag: { tagId: 'T1', name: 'GA4 - Server' },
      };
    },
    setWebServerContainerUrl: async (_a: string, _c: string, _w: string, tagId: string, url: string) => {
      calls.push(`setWebServerUrl:${tagId}:${url}`);
      return { tagId, name: 'Google Tag', serverContainerUrl: url };
    },
    setServerContainerTaggingUrl: async (_a: string, containerId: string, urls: string[]) => {
      calls.push(`setServerTaggingUrl:${containerId}:${urls.join(',')}`);
      return { containerId, name: 'Server Container', taggingServerUrls: urls };
    },
    getServerContainerSnapshot: async (a: string, c: string, w: string) => {
      calls.push(`serverSnapshot:${a}:${c}:${w}`);
      return {
        taggingServerUrls: [] as string[],
        clients: [] as Array<{ clientId: string; name: string; type: string }>,
        transformations: [] as Array<{ transformationId: string; name: string; type: string }>,
        tags: [{ tagId: '1', name: 'GA4 - Server', type: 'sgtmgaaw', firingTriggerId: [], blockingTriggerId: [], paused: false, parameter: [], consentSettings: null }],
      };
    },
    verifyServerEndpoint: async (url: string) => {
      calls.push(`verifyEndpoint:${url}`);
      return { url: `${url}/healthy`, ok: true, status: 200, body: 'ok' };
    },
    listGa4DataStreams: async (p: string) => {
      calls.push(`ga4Streams:${p}`);
      return [];
    },
    getGa4PropertySnapshot: async (p: string) => {
      calls.push(`ga4Snapshot:${p}`);
      return {
        property: p, displayName: 'Site', timeZone: 'UTC', currencyCode: 'USD', industryCategory: 'TECHNOLOGY',
        dataRetention: { eventDataRetention: 'TWO_MONTHS', resetOnNewActivity: true },
        keyEvents: [], customDimensions: [], customMetrics: [],
        dataStreams: [], googleAdsLinks: 0, googleSignals: 'GOOGLE_SIGNALS_ENABLED',
      };
    },
    getGa4AttributionSettings: async (p: string) => {
      calls.push(`ga4Attribution:${p}`);
      return { reportingAttributionModel: 'PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN', acquisitionConversionEventLookbackWindow: 'ACQUISITION_CONVERSION_EVENT_LOOKBACK_WINDOW_30_DAYS', otherConversionEventLookbackWindow: 'CONVERSION_EVENT_LOOKBACK_WINDOW_90_DAYS', adsWebConversionDataExportScope: 'CROSS_CHANNEL' };
    },
    getGa4GoogleSignals: async (p: string) => {
      calls.push(`ga4Signals:${p}`);
      return { state: 'GOOGLE_SIGNALS_ENABLED', consent: 'GOOGLE_SIGNALS_CONSENT_CONSENTED' };
    },
    listGa4MeasurementProtocolSecrets: async (p: string) => {
      calls.push(`ga4MpSecrets:${p}`);
      return [{ stream: `${p}/dataStreams/5`, streamDisplayName: 'Web', secrets: [{ displayName: 'Server MP' }] }];
    },
    listGa4BigQueryLinks: async (p: string) => {
      calls.push(`ga4Bq:${p}`);
      return [{ name: `${p}/bigQueryLinks/1`, project: 'projects/my-gcp', dailyExportEnabled: true, streamingExportEnabled: false }];
    },
    listGa4FirebaseLinks: async (p: string) => {
      calls.push(`ga4Firebase:${p}`);
      return [{ name: `${p}/firebaseLinks/1`, project: 'projects/my-firebase' }];
    },
    runGa4Report: async (input: { property: string; metrics: string[] }) => {
      calls.push(`ga4Report:${input.property}:${input.metrics.join(',')}`);
      return { dimensionHeaders: [], metricHeaders: [], rows: [] };
    },
    getGa4DataQuality: async (p: string, days: number) => {
      calls.push(`ga4DataQuality:${p}:${days}`);
      return {
        totalSessions: 1000,
        channelGroups: [{ name: 'Direct', sessions: 700 }, { name: 'Unassigned', sessions: 300 }],
        sourceMediums: [{ name: '(direct) / (none)', sessions: 700 }, { name: '(not set)', sessions: 300 }],
        windowDays: days,
        startDate: '2026-01-01',
        endDate: '2026-01-28',
      };
    },
    getGa4PropertyDetails: async (p: string) => {
      calls.push(`ga4Details:${p}`);
      return { property: p, displayName: 'Site', timeZone: 'UTC', currencyCode: 'USD', industryCategory: 'TECHNOLOGY', serviceLevel: 'GOOGLE_ANALYTICS_STANDARD', parent: 'accounts/1', createTime: '' };
    },
    listGa4KeyEvents: async (p: string) => {
      calls.push(`ga4KeyEvents:${p}`);
      return [{ eventName: 'purchase', countingMethod: 'ONCE_PER_EVENT', custom: false }];
    },
    listGa4Audiences: async (p: string) => {
      calls.push(`ga4Audiences:${p}`);
      return [{ name: `${p}/audiences/1`, displayName: 'Purchasers', description: 'Bought something', membershipDurationDays: 540, adsPersonalizationEnabled: true, filterClauseCount: 1 }];
    },
    listGa4CustomDimensions: async (p: string) => {
      calls.push(`ga4Dims:${p}`);
      return [{ parameterName: 'plan', displayName: 'Plan', scope: 'EVENT', description: '' }];
    },
    listGa4CustomMetrics: async (p: string) => {
      calls.push(`ga4Metrics:${p}`);
      return [{ parameterName: 'score', displayName: 'Score', measurementUnit: 'STANDARD', scope: 'EVENT', description: '' }];
    },
    listGa4GoogleAdsLinks: async (p: string) => {
      calls.push(`ga4AdsLinks:${p}`);
      return [{ name: 'properties/1/googleAdsLinks/9', customerId: '123', adsPersonalizationEnabled: true, canManageClients: false }];
    },
    getGa4DataRetention: async (p: string) => {
      calls.push(`ga4Retention:${p}`);
      return { eventDataRetention: 'TWO_MONTHS', resetUserDataOnNewActivity: true };
    },
    getGa4EnhancedMeasurement: async (ds: string) => {
      calls.push(`ga4Enhanced:${ds}`);
      return { streamEnabled: true, scrollsEnabled: true, outboundClicksEnabled: true, siteSearchEnabled: false, videoEngagementEnabled: false, fileDownloadsEnabled: true, pageChangesEnabled: true, formInteractionsEnabled: false };
    },
    runGa4RealtimeReport: async (input: { property: string; metrics: string[] }) => {
      calls.push(`ga4Realtime:${input.property}:${input.metrics.join(',')}`);
      return { dimensionHeaders: [], metricHeaders: ['activeUsers'], rows: [] };
    },
    listGa4MeasurementIds: async (account?: string) => {
      calls.push(`ga4MeasIds:${account ?? 'all'}`);
      return [{ measurementId: 'G-LIVE111', property: 'properties/1', propertyDisplayName: 'Main', streamDisplayName: 'Web' }];
    },
    createGtmWorkspace: async (a: string, c: string, name: string) => {
      calls.push(`createWorkspace:${a}:${c}:${name}`);
      return { workspaceId: 'w9', name, path: 'p' };
    },
    copyWorkspaceResources: async (a: string, c: string, from: string, to: string) => {
      calls.push(`copyWorkspace:${a}:${c}:${from}:${to}`);
      return { variables: { created: ['V'], skipped: [] }, triggers: { created: ['T'], skipped: [] }, tags: { created: ['Tag'], skipped: ['Existing'] }, unsupported: [], failed: [] };
    },
    deleteGtmTag: async (a: string, c: string, w: string, t: string) => {
      calls.push(`deleteTag:${a}:${c}:${w}:${t}`);
      return { deleted: true, tagId: t };
    },
    setGtmTagPaused: async (a: string, c: string, w: string, t: string, paused: boolean) => {
      calls.push(`setPaused:${a}:${c}:${w}:${t}:${paused}`);
      return { tagId: t, name: '', type: '' };
    },
    deleteGtmTrigger: async (a: string, c: string, w: string, t: string) => {
      calls.push(`deleteTrigger:${a}:${c}:${w}:${t}`);
      return { deleted: true, triggerId: t };
    },
    deleteGtmVariable: async (a: string, c: string, w: string, v: string) => {
      calls.push(`deleteVar:${a}:${c}:${w}:${v}`);
      return { deleted: true, variableId: v };
    },
    createGtmTrigger: async (a: string, c: string, w: string, trig: Record<string, unknown>) => {
      calls.push(`createTrigger:${a}:${c}:${w}:${String(trig.name ?? '')}`);
      return { triggerId: 'NEW1', name: String(trig.name ?? ''), type: String(trig.type ?? '') };
    },
    updateGtmTrigger: async (_a: string, _c: string, _w: string, triggerId: string, patch: { name?: string; eventName?: string }) => {
      calls.push(`updateTrigger:${triggerId}:${patch.eventName ?? ''}:${patch.name ?? ''}`);
      return { triggerId, name: patch.name ?? 'CE - Purchase', type: 'customEvent', customEventName: patch.eventName ?? '' };
    },
    createGtmTag: async (a: string, c: string, w: string, tag: Record<string, unknown>) => {
      calls.push(`createTag:${a}:${c}:${w}:${JSON.stringify(tag.firingTriggerId ?? [])}`);
      return { tagId: 'TAG1', name: String(tag.name ?? ''), type: String(tag.type ?? ''), parameter: tag.parameter };
    },
    enableGtmBuiltInVariables: async (a: string, c: string, w: string, types: string[]) => {
      calls.push(`enableVars:${a}:${c}:${w}:${types.join(',')}`);
      return types;
    },
    createGtmVariable: async (a: string, c: string, w: string, v: Record<string, unknown>) => {
      calls.push(`createVar:${a}:${c}:${w}:${String(v.type)}:${String(v.name)}`);
      return { variableId: 'V1', name: String(v.name ?? ''), type: String(v.type ?? '') };
    },
    createMetaEmqVariables: async (a: string, c: string, w: string) => {
      calls.push(`metaEmq:${a}:${c}:${w}`);
      return { created: ['ed - fbp', 'ed - fbc', 'ed - event_id'], skipped: ['ed - value'] };
    },
    listGtmTemplates: async (a: string, c: string, w: string) => {
      calls.push(`listTemplates:${a}:${c}:${w}`);
      return [];
    },
    importGalleryTemplate: async (_a: string, _c: string, _w: string, owner: string, repo: string) => {
      calls.push(`importTemplate:${owner}/${repo}`);
      return { templateId: '261', name: 'Meta Pixel', type: 'cvt_5RM3Q', imported: true };
    },
    getGtmContainerSnapshot: async (a: string, c: string, w: string) => {
      calls.push(`snapshot:${a}:${c}:${w}`);
      return (
        opts.snapshot ?? {
          tags: [{ tagId: '1', name: 'Orphan', type: 'html', firingTriggerId: [], paused: false, parameter: [] }],
          triggers: [],
          variables: [],
        }
      );
    },
    getGtmLiveVersionSnapshot: async (a: string, c: string) => {
      calls.push(`live:${a}:${c}`);
      return opts.liveSnapshot === undefined ? null : opts.liveSnapshot;
    },
    listGtmVersions: async (a: string, c: string) => {
      calls.push(`versions:${a}:${c}`);
      return [
        { versionId: '7', name: 'June', numTags: 5, numTriggers: 3, numVariables: 2, deleted: false },
        { versionId: '6', name: 'May', numTags: 4, numTriggers: 3, numVariables: 2, deleted: false },
      ];
    },
    getGtmVersionSnapshot: async (a: string, c: string, v: string) => {
      calls.push(`versionSnap:${a}:${c}:${v}`);
      // v=7 has an extra tag vs v=6 → a diff.
      const base = [{ tagId: '1', name: 'A', type: 'html', firingTriggerId: ['T1'], paused: false, parameter: [] }];
      const tags = v === '7'
        ? [...base, { tagId: '2', name: 'New', type: 'html', firingTriggerId: ['T1'], paused: false, parameter: [] }]
        : base;
      return { tags, triggers: [], variables: [] };
    },
  } as unknown as GoogleDataService;
  return { data, calls };
}

// Approve unchanged: returns the proposal args as-is.
const approveAsIs = async (p: { details: Record<string, unknown> }) => p.details;
const reject = async () => null;

// A confirm() answering a fixed yes/no sequence; records each proposal.
function seqConfirm(...answers: boolean[]): {
  fn: (p: { details: Record<string, unknown>; destructive?: boolean }) => Promise<Record<string, unknown> | null>;
  calls: Array<{ destructive?: boolean }>;
} {
  let i = 0;
  const seen: Array<{ destructive?: boolean }> = [];
  return {
    calls: seen,
    fn: async (p) => {
      seen.push(p);
      return answers[Math.min(i++, answers.length - 1)] ? p.details : null;
    },
  };
}

async function main(): Promise<void> {
  console.log('\nTool registry:');

  await test('exposes the read-only tools with schemas', async () => {
    const reg = buildToolRegistry(fakeData().data);
    const names = reg.list().map((t) => t.name).sort();
    assert.deepEqual(names, [
      'analytics_scorecard',
      'audit_ga4_data_quality',
      'audit_ga4_property',
      'audit_gtm_container',
      'audit_gtm_container_changes',
      'audit_server_container',
      'check_gtm_measurement_ids',
      'detect_meta_web_tags',
      'diff_gtm_versions',
      'diff_gtm_workspace_vs_live',
      'generate_analytics_report',
      'generate_ga4_report',
      'get_ga4_attribution_settings',
      'get_ga4_data_retention',
      'get_ga4_enhanced_measurement',
      'get_ga4_google_signals',
      'get_ga4_property_details',
      'list_ga4_accounts',
      'list_ga4_audiences',
      'list_ga4_bigquery_links',
      'list_ga4_custom_dimensions',
      'list_ga4_custom_metrics',
      'list_ga4_data_streams',
      'list_ga4_firebase_links',
      'list_ga4_google_ads_links',
      'list_ga4_key_events',
      'list_ga4_measurement_protocol_secrets',
      'list_ga4_properties',
      'list_gtm_accounts',
      'list_gtm_clients',
      'list_gtm_containers',
      'list_gtm_environments',
      'list_gtm_folders',
      'list_gtm_tags',
      'list_gtm_templates',
      'list_gtm_transformations',
      'list_gtm_triggers',
      'list_gtm_variables',
      'list_gtm_versions',
      'list_gtm_workspaces',
      'list_unused_gtm_triggers',
      'list_unused_gtm_variables',
      'run_ga4_realtime_report',
      'run_ga4_report',
      'score_ga4_property',
      'verify_server_endpoint',
    ]);
  });

  await test('execute routes args and returns JSON', async () => {
    const { data, calls } = fakeData();
    const reg = buildToolRegistry(data);
    const out = await reg.execute('list_gtm_accounts', {});
    assert.equal(JSON.parse(out)[0].accountId, '1');
    await reg.execute('list_gtm_tags', { accountId: '1', containerId: '2', workspaceId: '3' });
    await reg.execute('run_ga4_report', { property: 'properties/5', startDate: '7daysAgo', endDate: 'today', metrics: ['activeUsers'] });
    assert.ok(calls.includes('gtmTags:1:2:3'));
    assert.ok(calls.includes('ga4Report:properties/5:activeUsers'));
  });

  await test('unknown tool rejects', async () => {
    await assert.rejects(() => buildToolRegistry(fakeData().data).execute('nope', {}), /Unknown tool/);
  });

  await test('write tools appear ONLY when a confirm function is provided', async () => {
    const readOnly = buildToolRegistry(fakeData().data);
    assert.equal(readOnly.list().length, 46, 'read-only registry has 46 tools');
    assert.equal(readOnly.list().some((t) => t.name === 'create_gtm_tag'), false);

    const withWrites = buildToolRegistry(fakeData().data, approveAsIs);
    assert.equal(withWrites.list().length, 87, 'read + write registry has 87 tools');
    assert.equal(withWrites.list().some((t) => t.name === 'create_gtm_tracking_tag'), true);
    for (const n of ['create_gtm_folder', 'move_gtm_entities_to_folder', 'rename_gtm_folder', 'delete_gtm_folder']) {
      assert.equal(withWrites.list().some((t) => t.name === n), true, `${n} present`);
    }
    assert.equal(withWrites.list().some((t) => t.name === 'add_ga4_event_parameters'), true);
    assert.equal(withWrites.list().some((t) => t.name === 'set_ga4_measurement_id'), true);
    assert.equal(withWrites.list().some((t) => t.name === 'set_ga4_measurement_id_on_all_tags'), true);
    assert.equal(withWrites.list().some((t) => t.name === 'add_ga4_event_parameters_to_all_tags'), true);
    assert.equal(withWrites.list().some((t) => t.name === 'set_gtm_tag_consent'), true);
    assert.equal(withWrites.list().some((t) => t.name === 'create_gtm_variable_typed'), true);
    for (const fixTool of ['set_gtm_tag_paused', 'delete_gtm_trigger', 'delete_gtm_variable']) {
      assert.equal(withWrites.list().some((t) => t.name === fixTool), true, `${fixTool} is registered`);
    }
  });

  await test('unknown tool name suggests the closest real tool (did you mean)', async () => {
    const reg = buildToolRegistry(fakeData().data, approveAsIs);
    // A near-miss / hallucinated name (gemini-flash style) should point at the real tool.
    await assert.rejects(
      () => reg.execute('set_ga4_measurement_id_for_all_tags', { measurementId: 'x' }),
      /Did you mean:.*set_ga4_measurement_id_on_all_tags/,
      'suggests the real bulk tool for a near-miss name'
    );
  });

  await test('GA4 tag-edit tools are scoped to the GTM product (reachable in the GTM chat)', async () => {
    const editTools = ['set_ga4_measurement_id', 'set_ga4_measurement_id_on_all_tags', 'add_ga4_event_parameters', 'add_ga4_event_parameters_to_all_tags'];
    // GTM chat (where these belong — they edit GTM tags): all must be present.
    const gtm = buildToolRegistry(fakeData().data, approveAsIs, 'gtm').list().map((t) => t.name);
    for (const n of editTools) assert.equal(gtm.includes(n), true, `${n} must be available in the GTM chat`);
    // GA4 chat (read-only Analytics): they must NOT leak in, but the real GA4 read tools do.
    const ga4 = buildToolRegistry(fakeData().data, approveAsIs, 'ga4').list().map((t) => t.name);
    for (const n of editTools) assert.equal(ga4.includes(n), false, `${n} must NOT appear in the GA4 chat`);
    assert.equal(ga4.includes('list_ga4_properties'), true, 'real GA4 read tools still scoped to GA4');
  });

  await test('bad args: a tool called with another tool\'s shape is redirected, not fired', async () => {
    const reg = buildToolRegistry(fakeData().data, approveAsIs);
    // The exact misfire from the logs: set_gtm_tag_paused called with measurementId and
    // NO tagId. It must NOT hit the API; it must point at the tool the args fit.
    await assert.rejects(
      () => reg.execute('set_gtm_tag_paused', { accountId: '1', containerId: '2', workspaceId: '3', measurementId: '{{GA4 Variable}}' }),
      /set_ga4_measurement_id_on_all_tags/,
      'redirects misfiled set_gtm_tag_paused(measurementId) to set_ga4_measurement_id_on_all_tags'
    );
  });

  await test('audit_gtm_container returns counts + findings', async () => {
    const reg = buildToolRegistry(fakeData().data);
    const out = JSON.parse(await reg.execute('audit_gtm_container', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.equal(out.counts.tags, 1);
    assert.ok(out.findings.some((f: { message: string }) => f.message.includes('no firing trigger')));
  });

  await test('audit_ga4_property returns counts + severity findings (read-only)', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data);
    const out = JSON.parse(await reg.execute('audit_ga4_property', { property: 'properties/123' }));
    assert.ok(fd.calls.includes('ga4Snapshot:properties/123'));
    assert.ok(out.counts && out.summary && Array.isArray(out.findings));
    // The fake snapshot has 2-month retention + no key events + no streams + no ads links → findings.
    assert.ok(out.findings.some((f: { category: string }) => f.category === 'retention'));
    assert.ok(out.findings.some((f: { category: string }) => f.category === 'conversions'));
    // GA4 audit is advisory — no machine fixes.
    assert.ok(out.findings.every((f: { fix?: unknown }) => f.fix === undefined));
  });

  await test('GA4 read tools surface config BY NAME (key events, dimensions, retention, enhanced, realtime)', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data);

    const keyEvents = JSON.parse(await reg.execute('list_ga4_key_events', { property: 'properties/9' }));
    assert.deepEqual(keyEvents.map((k: { eventName: string }) => k.eventName), ['purchase']);
    assert.ok(fd.calls.includes('ga4KeyEvents:properties/9'));

    const audiences = JSON.parse(await reg.execute('list_ga4_audiences', { property: 'properties/9' }));
    assert.equal(audiences[0].displayName, 'Purchasers');
    assert.equal(audiences[0].membershipDurationDays, 540);
    assert.equal(audiences[0].adsPersonalizationEnabled, true);
    assert.ok(fd.calls.includes('ga4Audiences:properties/9'));

    const dims = JSON.parse(await reg.execute('list_ga4_custom_dimensions', { property: 'properties/9' }));
    assert.equal(dims[0].parameterName, 'plan');
    assert.equal(dims[0].scope, 'EVENT');

    const metrics = JSON.parse(await reg.execute('list_ga4_custom_metrics', { property: 'properties/9' }));
    assert.equal(metrics[0].measurementUnit, 'STANDARD');

    const links = JSON.parse(await reg.execute('list_ga4_google_ads_links', { property: 'properties/9' }));
    assert.equal(links[0].customerId, '123');

    const details = JSON.parse(await reg.execute('get_ga4_property_details', { property: 'properties/9' }));
    assert.equal(details.timeZone, 'UTC');

    const retention = JSON.parse(await reg.execute('get_ga4_data_retention', { property: 'properties/9' }));
    assert.equal(retention.eventDataRetention, 'TWO_MONTHS');

    const em = JSON.parse(await reg.execute('get_ga4_enhanced_measurement', { dataStream: 'properties/9/dataStreams/5' }));
    assert.equal(em.streamEnabled, true);
    assert.ok(fd.calls.includes('ga4Enhanced:properties/9/dataStreams/5'));

    const rt = JSON.parse(await reg.execute('run_ga4_realtime_report', { property: 'properties/9', metrics: ['activeUsers'] }));
    assert.deepEqual(rt.metricHeaders, ['activeUsers']);
    assert.ok(fd.calls.includes('ga4Realtime:properties/9:activeUsers'));
  });

  await test('check_gtm_measurement_ids flags container GA4 ids missing from accessible properties', async () => {
    const fd = fakeData({
      snapshot: {
        tags: [
          { tagId: '1', name: 'GA4 Config', type: 'gaawc', firingTriggerId: ['T1'], paused: false, parameter: [{ key: 'measurementId', value: 'G-LIVE111' }] },
          { tagId: '2', name: 'Typo', type: 'gaawe', firingTriggerId: ['T1'], paused: false, parameter: [{ key: 'measurementIdOverride', value: 'G-WRONG99' }] },
        ],
        triggers: [],
        variables: [],
      },
    });
    const reg = buildToolRegistry(fd.data);
    const out = JSON.parse(await reg.execute('check_gtm_measurement_ids', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.deepEqual(out.matched.map((m: { id: string }) => m.id), ['G-LIVE111']);
    assert.equal(out.matched[0].propertyDisplayName, 'Main');
    assert.deepEqual(out.notFound.map((n: { id: string }) => n.id), ['G-WRONG99']);
    assert.ok(fd.calls.includes('ga4MeasIds:all'), 'scanned all GA4 accounts when none given');
  });

  await test('list_gtm_versions + diff_gtm_versions report the publish history and what changed', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data);
    const versions = JSON.parse(await reg.execute('list_gtm_versions', { accountId: '1', containerId: '2' }));
    assert.deepEqual(versions.map((v: { versionId: string }) => v.versionId), ['7', '6']);
    assert.ok(fd.calls.includes('versions:1:2'));

    const diff = JSON.parse(await reg.execute('diff_gtm_versions', { accountId: '1', containerId: '2', versionA: '6', versionB: '7' }));
    assert.equal(diff.versionA, '6');
    assert.equal(diff.versionB, '7');
    assert.deepEqual(diff.drift.tags.added.map((t: { id: string }) => t.id), ['2'], 'tag added in v7');
    assert.equal(diff.drift.changeCount, 1);
    assert.ok(fd.calls.includes('versionSnap:1:2:6') && fd.calls.includes('versionSnap:1:2:7'));
  });

  await test('analytics_scorecard folds a web-audit consent report in as a third section', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data);
    const consentReport = { findings: [{ domain: 'consent', severity: 'critical', finding: 'Tag fires before consent', suggestedFix: 'Gate it' }] };
    const out = JSON.parse(await reg.execute('analytics_scorecard', { accountId: '1', containerId: '2', workspaceId: '3', ga4Property: 'properties/9', consentReport }));
    assert.deepEqual(out.sections.map((s: { key: string }) => s.key), ['gtm', 'ga4', 'consent']);
    const consent = out.sections.find((s: { key: string }) => s.key === 'consent');
    assert.equal(consent.label, 'Consent Mode v2');
  });

  await test('audit_ga4_data_quality flags Unassigned + (not set) from the reporting data', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data);
    const out = JSON.parse(await reg.execute('audit_ga4_data_quality', { property: 'properties/9', days: 14 }));
    assert.equal(out.totalSessions, 1000);
    assert.equal(out.windowDays, 14);
    const sev = out.findings.map((f: { severity: string }) => f.severity);
    assert.ok(sev.includes('high'), '30% Unassigned → high');
    assert.ok(out.findings.every((f: { category: string }) => f.category === 'data_quality'));
    assert.equal(out.dateRange, 'Jan 1 – Jan 28, 2026', 'result echoes the calendar window');
    assert.equal(out.startDate, '2026-01-01');
    assert.ok(fd.calls.includes('ga4DataQuality:properties/9:14'));
  });

  await test('audit_ga4_data_quality defaults to a 28-day window when days is omitted', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data);
    await reg.execute('audit_ga4_data_quality', { property: 'properties/9' });
    assert.ok(fd.calls.includes('ga4DataQuality:properties/9:28'), 'defaults to 28 days');
  });

  await test('audit_ga4_data_quality coerces days safely (non-numeric → 28, huge → 365, neg → 1)', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data);
    await reg.execute('audit_ga4_data_quality', { property: 'properties/9', days: 'abc' });
    await reg.execute('audit_ga4_data_quality', { property: 'properties/9', days: 100000 });
    await reg.execute('audit_ga4_data_quality', { property: 'properties/9', days: -5 });
    assert.ok(fd.calls.includes('ga4DataQuality:properties/9:28'), 'non-numeric → default 28 (no "NaNdaysAgo")');
    assert.ok(fd.calls.includes('ga4DataQuality:properties/9:365'), 'huge → clamped to 365');
    assert.ok(fd.calls.includes('ga4DataQuality:properties/9:1'), 'negative → clamped to 1');
  });

  await test('GA4 config-completeness read tools (attribution, signals, MP secrets, BQ/Firebase links)', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data);

    const attr = JSON.parse(await reg.execute('get_ga4_attribution_settings', { property: 'properties/9' }));
    assert.equal(attr.reportingAttributionModel, 'PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN');
    assert.ok(fd.calls.includes('ga4Attribution:properties/9'));

    const signals = JSON.parse(await reg.execute('get_ga4_google_signals', { property: 'properties/9' }));
    assert.equal(signals.state, 'GOOGLE_SIGNALS_ENABLED');

    const mp = JSON.parse(await reg.execute('list_ga4_measurement_protocol_secrets', { property: 'properties/9' }));
    assert.equal(mp[0].secrets[0].displayName, 'Server MP');
    // secret VALUE must never be surfaced.
    assert.ok(!JSON.stringify(mp).toLowerCase().includes('secretvalue'));

    const bq = JSON.parse(await reg.execute('list_ga4_bigquery_links', { property: 'properties/9' }));
    assert.equal(bq[0].dailyExportEnabled, true);

    const fb = JSON.parse(await reg.execute('list_ga4_firebase_links', { property: 'properties/9' }));
    assert.equal(fb[0].project, 'projects/my-firebase');
  });

  await test('generate_ga4_report combines the property + data-quality audits into one Markdown report', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data);
    const out = JSON.parse(await reg.execute('generate_ga4_report', { property: 'properties/9', days: 30 }));
    assert.ok(typeof out.report === 'string');
    assert.ok(out.report.includes('# GA4 Health Report'));
    assert.ok(out.report.includes('GA4 property') && out.report.includes('GA4 data quality'));
    assert.ok(out.report.includes('GA4 data quality (Jan 1 – Jan 28, 2026)'), 'report shows the data-quality window');
    assert.ok(fd.calls.includes('ga4Snapshot:properties/9') && fd.calls.includes('ga4DataQuality:properties/9:30'));
  });

  await test('generate_analytics_report returns a Markdown report (GTM + optional GA4)', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data);
    const out = JSON.parse(await reg.execute('generate_analytics_report', { accountId: '1', containerId: '2', workspaceId: '3', ga4Property: 'properties/9' }));
    assert.ok(typeof out.report === 'string', 'returns a report string');
    assert.ok(out.report.includes('# Analytics Health Report'));
    assert.ok(/\*\*Overall: \d+\/100 \([A-F]\)\*\*/.test(out.report));
    assert.ok(out.report.includes('GTM container'));
    assert.ok(out.report.includes('GA4 property'), 'GA4 section included when ga4Property given');
    assert.ok(fd.calls.includes('ga4Snapshot:properties/9'));
  });

  await test('score_ga4_property grades a GA4 property (GA4-mode scorecard)', async () => {
    const fd = fakeData(); // fake snapshot has 2-month retention + no key events/streams → findings
    const reg = buildToolRegistry(fd.data);
    const out = JSON.parse(await reg.execute('score_ga4_property', { property: 'properties/9' }));
    assert.ok(typeof out.score === 'number' && out.grade, 'overall score + grade');
    assert.deepEqual(out.sections.map((s: { key: string }) => s.key), ['ga4'], 'a single GA4 section');
    assert.ok(out.score < 100, 'the fake property has findings, so not a perfect score');
    assert.ok(fd.calls.includes('ga4Snapshot:properties/9'));
  });

  await test('analytics_scorecard scores GTM alone, and GTM+GA4 when a property is given', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data);
    // GTM only (default snapshot has an orphan tag → at least one finding).
    const gtmOnly = JSON.parse(await reg.execute('analytics_scorecard', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.ok(typeof gtmOnly.score === 'number' && gtmOnly.grade, 'has overall score + grade');
    assert.deepEqual(gtmOnly.sections.map((s: { key: string }) => s.key), ['gtm'], 'GTM section only');
    assert.ok(Array.isArray(gtmOnly.topIssues));

    // With a GA4 property → both sections (the fake GA4 snapshot has findings).
    const both = JSON.parse(await reg.execute('analytics_scorecard', { accountId: '1', containerId: '2', workspaceId: '3', ga4Property: 'properties/123' }));
    assert.deepEqual(both.sections.map((s: { key: string }) => s.key), ['gtm', 'ga4']);
    assert.ok(fd.calls.includes('ga4Snapshot:properties/123'), 'fetched the GA4 property');
    assert.ok(both.score <= gtmOnly.score, 'adding GA4 findings cannot raise the score');
  });

  await test('audit injects workspace ids into auto-fixes (paused + unused trigger)', async () => {
    const fd = fakeData({
      snapshot: {
        tags: [
          {
            tagId: '7', name: 'Paused GA4', type: 'gaawe', firingTriggerId: ['T1'], paused: true,
            parameter: [{ key: 'measurementIdOverride', value: 'G-1' }, { key: 'eventName', value: 'purchase' }],
            consentSettings: { consentStatus: 'needed' },
          },
        ],
        triggers: [
          { triggerId: 'T1', name: 'Used', type: 'pageview' },
          { triggerId: 'T2', name: 'Lonely', type: 'pageview' },
        ],
        variables: [],
      },
    });
    const reg = buildToolRegistry(fd.data); // audit is read-only
    const out = JSON.parse(await reg.execute('audit_gtm_container', { accountId: '1', containerId: '2', workspaceId: '3' }));

    const paused = out.findings.find((f: { category: string }) => f.category === 'paused');
    assert.ok(paused?.fix, 'paused finding carries a fix');
    assert.equal(paused.fix.tool, 'set_gtm_tag_paused');
    assert.deepEqual(paused.fix.args, { accountId: '1', containerId: '2', workspaceId: '3', tagId: '7', paused: false, name: 'Paused GA4' });

    const unused = out.findings.find(
      (f: { category: string; resource?: { kind: string } }) => f.category === 'unused' && f.resource?.kind === 'trigger'
    );
    assert.equal(unused.fix.tool, 'delete_gtm_trigger');
    assert.deepEqual(unused.fix.args, { accountId: '1', containerId: '2', workspaceId: '3', triggerId: 'T2', name: 'Lonely' });
    // The healthy GA4 tag (mid + eventName + consent needed) raises no GA4/consent finding.
    assert.equal(out.findings.some((f: { category: string }) => f.category === 'ga4' || f.category === 'consent'), false);
  });

  await test('fix tools apply: unpause (one confirm), delete trigger/variable (two confirms)', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data, approveAsIs);
    await reg.execute('set_gtm_tag_paused', { accountId: '1', containerId: '2', workspaceId: '3', tagId: '7', paused: false });
    assert.ok(fd.calls.includes('setPaused:1:2:3:7:false'), 'unpaused the tag');

    const ct = seqConfirm(true, true);
    await buildToolRegistry(fd.data, ct.fn).execute('delete_gtm_trigger', { accountId: '1', containerId: '2', workspaceId: '3', triggerId: 'T2' });
    assert.equal(ct.calls.length, 2, 'delete trigger asked twice');
    assert.ok(fd.calls.includes('deleteTrigger:1:2:3:T2'), 'deleted the trigger after both approvals');

    const cv = seqConfirm(true, false);
    const out = await buildToolRegistry(fd.data, cv.fn).execute('delete_gtm_variable', { accountId: '1', containerId: '2', workspaceId: '3', variableId: 'V5' });
    assert.equal(JSON.parse(out).declined, true, 'declining the 2nd confirm cancels the variable delete');
    assert.ok(!fd.calls.includes('deleteVar:1:2:3:V5'), 'variable NOT deleted when 2nd confirm declined');
  });

  await test('diff_gtm_workspace_vs_live: no published version → pending note', async () => {
    const fd = fakeData(); // liveSnapshot undefined → getGtmLiveVersionSnapshot returns null
    const reg = buildToolRegistry(fd.data);
    const out = JSON.parse(await reg.execute('diff_gtm_workspace_vs_live', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.equal(out.publishedVersion, null);
    assert.ok(String(out.note).includes('No published version'));
    assert.ok(fd.calls.includes('live:1:2'), 'fetched the live version');
  });

  await test('diff_gtm_workspace_vs_live: reports config drift vs the live version', async () => {
    const fd = fakeData({
      liveSnapshot: { tags: [{ tagId: '1', name: 'A', type: 'html', firingTriggerId: ['T1'], paused: false, parameter: [] }], triggers: [], variables: [] },
      snapshot: { tags: [{ tagId: '1', name: 'A', type: 'html', firingTriggerId: ['T1'], paused: true, parameter: [] }], triggers: [], variables: [] }, // paused flipped
    });
    const reg = buildToolRegistry(fd.data);
    const out = JSON.parse(await reg.execute('diff_gtm_workspace_vs_live', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.equal(out.publishedVersion, 'live');
    assert.deepEqual(out.drift.tags.modified.map((t: { id: string }) => t.id), ['1']);
    assert.equal(out.drift.changeCount, 1);
  });

  await test('audit_gtm_container_changes: baseline first, NEW issues on second run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'samarth-reg-hist-'));
    const history = new AuditHistoryStore(join(dir, 'h.json'));
    let snap: { tags: Array<Record<string, unknown>>; triggers: never[]; variables: never[] } = { tags: [], triggers: [], variables: [] };
    const data = { getGtmContainerSnapshot: async () => snap } as unknown as GoogleDataService;
    const reg = buildToolRegistry(data, undefined, undefined, history);

    const first = JSON.parse(await reg.execute('audit_gtm_container_changes', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.equal(first.firstRun, true);
    assert.equal(first.since, null);

    snap = { tags: [{ tagId: '9', name: 'Orphan', type: 'html', firingTriggerId: [], paused: false, parameter: [] }], triggers: [], variables: [] };
    const second = JSON.parse(await reg.execute('audit_gtm_container_changes', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.equal(second.firstRun, false);
    assert.ok(second.drift.newFindings.some((f: { message: string }) => f.message.includes('no firing trigger')), 'reports the new orphan-tag issue');
    rmSync(dir, { recursive: true, force: true });
  });

  await test('audit_gtm_container_changes without history degrades gracefully', async () => {
    const reg = buildToolRegistry(fakeData().data); // no history store
    const out = JSON.parse(await reg.execute('audit_gtm_container_changes', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.ok(String(out.error).includes('unavailable'));
  });

  await test('create_tracking_tag (ga4_event) builds correct tag + reuses trigger', async () => {
    const fd = fakeData({ existingTriggers: [{ triggerId: 'T9', name: 'Email link click', type: 'linkClick' }] });
    const reg = buildToolRegistry(fd.data, approveAsIs);
    const out = JSON.parse(
      await reg.execute('create_gtm_tracking_tag', {
        accountId: '1', containerId: '2', workspaceId: '3',
        platform: 'ga4_event', tagName: 'GA4 - email', measurementId: 'G-XYZ', eventName: 'email_click',
        eventParameters: [{ name: 'link_url', value: '{{Click URL}}' }],
        trigger: { name: 'Email link click', kind: 'link_click', clickUrlValue: 'mailto:' },
      })
    );
    assert.equal(out.trigger.reused, true);
    assert.ok(fd.calls.includes('enableVars:1:2:3:clickUrl'), 'auto-enabled clickUrl');
    assert.ok(!fd.calls.some((c) => c.startsWith('createTrigger')), 'reused, did not create trigger');
    assert.ok(fd.calls.some((c) => c.startsWith('createTag') && c.includes('T9')), 'tag linked to existing trigger');
  });

  await test('create_tracking_tag (google_tag) builds a googtag and creates its trigger', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data, approveAsIs);
    const out = JSON.parse(
      await reg.execute('create_gtm_tracking_tag', {
        accountId: '1', containerId: '2', workspaceId: '3',
        platform: 'google_tag', tagName: 'Google tag - GA4', tagId: 'G-XYZ',
        configSettings: [{ name: 'send_page_view', value: 'false' }],
        trigger: { name: 'Initialization - All Pages', kind: 'pageview' },
      })
    );
    assert.equal(out.tag.type, 'googtag', 'built a Google tag');
    assert.ok(fd.calls.some((c) => c.startsWith('createTag')), 'created the tag');
    assert.ok(fd.calls.some((c) => c.startsWith('createTrigger')), 'created its trigger');
  });

  // The 5 non-GA4 web platforms: assert the enum → correct-builder dispatch AND that the handler's
  // arg coercion (bln, countingMethod narrowing, AW- stripping, linkerDomains) flows into the tag.
  const trkParam = (out: { tag: { parameter?: Array<{ key: string; value: string }> } }, key: string) =>
    (out.tag.parameter ?? []).find((x) => x.key === key)?.value;

  await test('create_tracking_tag (floodlight) dispatches flc + coerces countingMethod to ordinalType', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data, approveAsIs);
    const out = JSON.parse(
      await reg.execute('create_gtm_tracking_tag', {
        accountId: '1', containerId: '2', workspaceId: '3',
        platform: 'floodlight', tagName: 'FL - Signup', advertiserId: '6278210', groupTag: 'confi0', activityTag: 'email0', countingMethod: 'unique',
        trigger: { name: 'All Pages', kind: 'pageview' },
      })
    );
    assert.equal(out.tag.type, 'flc');
    assert.equal(trkParam(out, 'advertiserId'), '6278210');
    assert.equal(trkParam(out, 'ordinalType'), 'UNIQUE');
    assert.ok(fd.calls.some((c) => c.startsWith('createTag')), 'created the tag');
  });

  await test('create_tracking_tag (google_ads_call_conversion) dispatches awcc + strips AW- from conversionId', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data, approveAsIs);
    const out = JSON.parse(
      await reg.execute('create_gtm_tracking_tag', {
        accountId: '1', containerId: '2', workspaceId: '3',
        platform: 'google_ads_call_conversion', tagName: 'Call', phoneNumber: '(877) 635-4246', conversionId: 'AW-10966070237', conversionLabel: 'L1',
        trigger: { name: 'All Pages', kind: 'pageview' },
      })
    );
    assert.equal(out.tag.type, 'awcc');
    assert.equal(trkParam(out, 'conversionId'), '10966070237');
    assert.equal(trkParam(out, 'phoneConversionNumber'), '(877) 635-4246');
  });

  await test('create_tracking_tag (google_ads_remarketing) dispatches sp with customParamsFormat NONE', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data, approveAsIs);
    const out = JSON.parse(
      await reg.execute('create_gtm_tracking_tag', {
        accountId: '1', containerId: '2', workspaceId: '3',
        platform: 'google_ads_remarketing', tagName: 'RMKT', conversionId: 'AW-605994778',
        trigger: { name: 'All Pages', kind: 'pageview' },
      })
    );
    assert.equal(out.tag.type, 'sp');
    assert.equal(trkParam(out, 'customParamsFormat'), 'NONE');
    assert.equal(trkParam(out, 'conversionId'), 'AW-605994778'); // sp passes conversionId through
  });

  await test('create_tracking_tag (conversion_linker) dispatches gclidw; linkerDomains implies cross-domain', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data, approveAsIs);
    const out = JSON.parse(
      await reg.execute('create_gtm_tracking_tag', {
        accountId: '1', containerId: '2', workspaceId: '3',
        platform: 'conversion_linker', tagName: 'CL', linkerDomains: 'a.com, b.com',
        trigger: { name: 'Initialization - All Pages', kind: 'pageview' },
      })
    );
    assert.equal(out.tag.type, 'gclidw');
    assert.equal(trkParam(out, 'enableCrossDomain'), 'true');
    assert.equal(trkParam(out, 'linkerDomains'), 'a.com, b.com');
  });

  await test('create_tracking_tag (custom_image) dispatches img; bln coerces useCacheBuster=false', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data, approveAsIs);
    const out = JSON.parse(
      await reg.execute('create_gtm_tracking_tag', {
        accountId: '1', containerId: '2', workspaceId: '3',
        platform: 'custom_image', tagName: 'Pixel', url: '//pixel.example.com/p.gif', useCacheBuster: false,
        trigger: { name: 'All Pages', kind: 'pageview' },
      })
    );
    assert.equal(out.tag.type, 'img');
    assert.equal(trkParam(out, 'url'), '//pixel.example.com/p.gif');
    assert.equal(trkParam(out, 'useCacheBuster'), 'false');
    assert.equal(trkParam(out, 'cacheBusterQueryParam'), undefined); // dropped when cache buster is off
  });

  await test('create_gtm_variable_typed builds a Custom JS variable', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data, approveAsIs);
    await reg.execute('create_gtm_variable_typed', {
      accountId: '1', containerId: '2', workspaceId: '3',
      kind: 'javascript', name: 'JS - Page Title', javascript: 'function(){return document.title;}',
    });
    assert.ok(fd.calls.some((c) => c.startsWith('createVar:1:2:3:jsm:JS - Page Title')), 'created a jsm variable');
  });

  await test('product scopes the toolset (gtm vs ga4)', async () => {
    // Assert EXACT per-product membership against an explicit expected set, not
    // the registry's own name-substring rule (re-deriving that rule is
    // tautological — it would pass even if a GA4-data tool were mis-scoped).
    // GA4 = the tools that read GA4 data; everything else is GTM.
    const GA4_TOOLS = [
      'audit_ga4_data_quality',
      'audit_ga4_property',
      'generate_ga4_report',
      'get_ga4_attribution_settings',
      'get_ga4_data_retention',
      'get_ga4_enhanced_measurement',
      'get_ga4_google_signals',
      'get_ga4_property_details',
      'list_ga4_accounts',
      'list_ga4_audiences',
      'list_ga4_bigquery_links',
      'list_ga4_custom_dimensions',
      'list_ga4_custom_metrics',
      'list_ga4_data_streams',
      'list_ga4_firebase_links',
      'list_ga4_google_ads_links',
      'list_ga4_key_events',
      'list_ga4_measurement_protocol_secrets',
      'list_ga4_properties',
      'run_ga4_realtime_report',
      'run_ga4_report',
      'score_ga4_property',
    ];

    const gtmNames = buildToolRegistry(fakeData().data, approveAsIs, 'gtm').list().map((t) => t.name);
    // No GA4 tool may appear in gtm mode (checked by explicit name, not substring).
    for (const t of GA4_TOOLS) {
      assert.ok(!gtmNames.includes(t), `${t} must not appear in gtm mode`);
    }
    // The cross-cutting scorecard (reads GA4 data but is gtm-anchored) + a GTM-only tool are present.
    assert.ok(gtmNames.includes('analytics_scorecard'));
    assert.ok(gtmNames.includes('create_gtm_tag_with_trigger'));

    // ga4 mode is EXACTLY the GA4 tool set (no confirm → no write tools, all of which are GTM anyway).
    const ga4Names = buildToolRegistry(fakeData().data, undefined, 'ga4').list().map((t) => t.name);
    assert.deepEqual([...ga4Names].sort(), [...GA4_TOOLS].sort(), 'ga4 mode = exactly the GA4 tools');
  });

  await test('confirm can edit args before they are applied', async () => {
    const { data, calls } = fakeData();
    // Approve but rename the workspace.
    const reg = buildToolRegistry(data, async (p) => ({ ...p.details, name: 'Edited Name' }));
    await reg.execute('create_gtm_workspace', { accountId: '1', containerId: '2', name: 'Original' });
    assert.ok(calls.includes('createWorkspace:1:2:Edited Name'), 'applied the edited value');
  });

  await test('create_gtm_tag_with_trigger REUSES an existing trigger + enables vars + links tag', async () => {
    const fd = fakeData({ existingTriggers: [{ triggerId: 'T1', name: 'Email link click', type: 'linkClick' }] });
    const reg = buildToolRegistry(fd.data, approveAsIs);
    const out = await reg.execute('create_gtm_tag_with_trigger', {
      accountId: '1',
      containerId: '2',
      workspaceId: '3',
      tag: { name: 'GA4 - email', type: 'gaawe' },
      trigger: { name: 'Email link click', type: 'linkClick' },
      builtInVariables: ['clickUrl'],
    });
    const res = rec(JSON.parse(out));
    assert.equal(rec(res.trigger).reused, true);
    assert.equal(rec(res.trigger).triggerId, 'T1');
    assert.ok(fd.calls.includes('enableVars:1:2:3:clickUrl'), 'enabled the built-in variable');
    assert.ok(!fd.calls.some((c) => c.startsWith('createTrigger')), 'did NOT create a duplicate trigger');
    assert.ok(fd.calls.some((c) => c.startsWith('createTag') && c.includes('T1')), 'tag linked to existing trigger');
  });

  await test('create_gtm_tag_with_trigger creates the trigger when none exists', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data, approveAsIs);
    await reg.execute('create_gtm_tag_with_trigger', {
      accountId: '1',
      containerId: '2',
      workspaceId: '3',
      tag: { name: 't', type: 'gaawe' },
      trigger: { name: 'New trigger', type: 'linkClick' },
    });
    assert.ok(fd.calls.some((c) => c.startsWith('createTrigger:1:2:3:New trigger')), 'created the trigger');
    assert.ok(fd.calls.some((c) => c.startsWith('createTag')), 'created the tag');
  });

  await test('delete_gtm_tag requires TWO confirmations; applies only after both', async () => {
    const fd = fakeData();
    const c = seqConfirm(true, true);
    const reg = buildToolRegistry(fd.data, c.fn);
    await reg.execute('delete_gtm_tag', { accountId: '1', containerId: '2', workspaceId: '3', tagId: '9' });
    assert.equal(c.calls.length, 2, 'asked twice');
    assert.equal(c.calls[1].destructive, true, 'second prompt is the destructive final confirm');
    assert.ok(fd.calls.includes('deleteTag:1:2:3:9'), 'deleted after both approvals');
  });

  await test('delete declines on the 2nd confirmation → no API call', async () => {
    const fd = fakeData();
    const c = seqConfirm(true, false);
    const reg = buildToolRegistry(fd.data, c.fn);
    const out = await reg.execute('delete_gtm_tag', { accountId: '1', containerId: '2', workspaceId: '3', tagId: '9' });
    assert.equal(JSON.parse(out).declined, true);
    assert.equal(c.calls.length, 2);
    assert.equal(fd.calls.length, 0, 'nothing deleted');
  });

  await test('delete declines on the 1st confirmation → only one prompt, no API call', async () => {
    const fd = fakeData();
    const c = seqConfirm(false);
    const reg = buildToolRegistry(fd.data, c.fn);
    await reg.execute('delete_gtm_tag', { accountId: '1', containerId: '2', workspaceId: '3', tagId: '9' });
    assert.equal(c.calls.length, 1, 'no second prompt after first rejection');
    assert.equal(fd.calls.length, 0);
  });

  await test('write declines (no API call) on rejection', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data, reject);
    const out = await reg.execute('create_gtm_workspace', { accountId: '1', containerId: '2', name: 'Draft' });
    assert.equal(JSON.parse(out).declined, true);
    assert.equal(fd.calls.length, 0, 'no API call when declined');
  });

  await test('write tool is unavailable without confirm (not registered, no API call)', async () => {
    const fd = fakeData();
    const reg = buildToolRegistry(fd.data);
    await assert.rejects(
      () => reg.execute('create_gtm_workspace', { accountId: '1', containerId: '2', name: 'X' }),
      /Unknown tool/
    );
    assert.equal(fd.calls.length, 0);
  });

  await test('context tools switch the active GTM context (present only with ctxControl)', async () => {
    const data = {
      listGtmContainers: async () => [
        { containerId: 'C1', name: 'web', publicId: 'GTM-AAA', path: '' },
        { containerId: 'C2', name: 'app', publicId: 'GTM-BBB', path: '' },
      ],
      listGtmWorkspaces: async (_a: string, c: string) =>
        c === 'C2'
          ? [{ workspaceId: '9', name: 'Default Workspace', path: '' }]
          : [
              { workspaceId: '1', name: 'Default Workspace', path: '' },
              { workspaceId: '3', name: 'MCP-TEST', path: '' },
            ],
    } as unknown as GoogleDataService;

    // Absent without a context controller.
    assert.equal(buildToolRegistry(data, undefined, 'gtm').list().some((t) => t.name === 'set_gtm_workspace'), false);

    const setCalls: GtmContext[] = [];
    const ctxControl: GtmContextControl = {
      current: () => ({ accountId: '1', accountName: 'A', containerId: 'C1', containerName: 'web', workspaceId: '1', workspaceName: 'Default Workspace' }),
      set: (ctx) => {
        setCalls.push(ctx);
      },
    };
    const reg = buildToolRegistry(data, undefined, 'gtm', undefined, ctxControl);
    assert.ok(reg.list().some((t) => t.name === 'set_gtm_workspace'), 'set_gtm_workspace present with ctxControl');
    assert.ok(reg.list().some((t) => t.name === 'set_gtm_container'), 'set_gtm_container present with ctxControl');

    // Switch workspace by name (case-insensitive), keeping the current container.
    await reg.execute('set_gtm_workspace', { workspaceName: 'mcp-test' });
    assert.equal(setCalls[0]?.workspaceId, '3');
    assert.equal(setCalls[0]?.workspaceName, 'MCP-TEST');
    assert.equal(setCalls[0]?.containerId, 'C1', 'keeps the current container');

    // Switch container by name → picks its Default Workspace.
    await reg.execute('set_gtm_container', { containerName: 'app' });
    assert.equal(setCalls[1]?.containerId, 'C2');
    assert.equal(setCalls[1]?.workspaceId, '9');
    assert.equal(setCalls[1]?.workspaceName, 'Default Workspace');

    // Unknown name → a clear error listing the options, and no further context change.
    await assert.rejects(() => reg.execute('set_gtm_workspace', { workspaceName: 'nope' }), /not found/i);
    assert.equal(setCalls.length, 2, 'a failed switch does not change context');
  });

  await test('folder tools create a folder and move entities (gtm write tools, confirm-gated)', async () => {
    const calls: string[] = [];
    const data = {
      listGtmFolders: async () => [{ folderId: '12', name: 'Marketing', path: '' }],
      createGtmFolder: async (_a: string, _c: string, _w: string, name: string) => {
        calls.push('createFolder');
        return { folderId: 'f1', name, path: '' };
      },
      moveEntitiesToFolder: async (_a: string, _c: string, _w: string, folderId: string, ids: { tagIds?: string[] }) => {
        calls.push('move');
        return { folderId, moved: { tags: ids.tagIds?.length ?? 0, triggers: 0, variables: 0 } };
      },
    } as unknown as GoogleDataService;

    // list_gtm_folders is a READ tool (available without a confirm fn).
    const folders = JSON.parse(await buildToolRegistry(data).execute('list_gtm_folders', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.equal(folders[0].folderId, '12');
    assert.equal(folders[0].name, 'Marketing');

    // Confirm-gated writes: absent read-only, present with a confirm fn.
    assert.equal(buildToolRegistry(data).list().some((t) => t.name === 'create_gtm_folder'), false);
    const reg = buildToolRegistry(data, approveAsIs, 'gtm');

    const folder = JSON.parse(await reg.execute('create_gtm_folder', { accountId: '1', containerId: '2', workspaceId: '3', name: 'Analytics' }));
    assert.equal(folder.folderId, 'f1');
    assert.equal(folder.name, 'Analytics');

    const moved = JSON.parse(
      await reg.execute('move_gtm_entities_to_folder', { accountId: '1', containerId: '2', workspaceId: '3', folderId: 'f1', tagIds: ['7', '8'] }),
    );
    assert.equal(moved.moved.tags, 2);
    assert.deepEqual(calls, ['createFolder', 'move']);
  });

  await test('folder rename (one confirm) + delete (two confirms, final requires typing "delete")', async () => {
    const calls: string[] = [];
    const data = {
      renameGtmFolder: async (_a: string, _c: string, _w: string, folderId: string, name: string) => {
        calls.push(`rename:${folderId}:${name}`);
        return { folderId, name, path: '' };
      },
      deleteGtmFolder: async (_a: string, _c: string, _w: string, folderId: string) => {
        calls.push(`delete:${folderId}`);
        return { deleted: true, folderId };
      },
    } as unknown as GoogleDataService;

    const r = JSON.parse(
      await buildToolRegistry(data, approveAsIs, 'gtm').execute('rename_gtm_folder', { accountId: '1', containerId: '2', workspaceId: '3', folderId: 'f1', name: 'Marketing' }),
    );
    assert.equal(r.name, 'Marketing');
    assert.ok(calls.includes('rename:f1:Marketing'), 'renamed');

    // delete is destructive: two confirms, and the FINAL one carries requireTextConfirm.
    const ct = seqConfirm(true, true);
    await buildToolRegistry(data, ct.fn, 'gtm').execute('delete_gtm_folder', { accountId: '1', containerId: '2', workspaceId: '3', folderId: 'f1', name: 'Marketing' });
    assert.equal(ct.calls.length, 2, 'delete folder asked twice');
    assert.equal((ct.calls[0] as { requireTextConfirm?: string }).requireTextConfirm, undefined, 'first confirm is a plain approval');
    assert.equal((ct.calls[1] as { requireTextConfirm?: string }).requireTextConfirm, 'delete', 'final confirm requires typing "delete"');
    assert.ok(calls.includes('delete:f1'), 'deleted after both approvals');

    // Declining the final confirm leaves the folder untouched.
    calls.length = 0;
    const cd = seqConfirm(true, false);
    await buildToolRegistry(data, cd.fn, 'gtm').execute('delete_gtm_folder', { accountId: '1', containerId: '2', workspaceId: '3', folderId: 'f1' });
    assert.equal(calls.length, 0, 'no delete when the final confirmation is declined');
  });

  await test('unused-trigger cleanup: list finds orphans; delete removes only unused, filter-aware', async () => {
    const snapshot = {
      tags: [{ tagId: 't1', name: 'GA4', type: 'gaawe', firingTriggerId: ['10'], blockingTriggerId: ['11'], paused: false, parameter: [] }],
      triggers: [
        { triggerId: '10', name: 'All Pages', type: 'pageview', parameter: [] }, // used: firing
        { triggerId: '11', name: 'Block on X', type: 'customEvent', parameter: [] }, // used: blocking
        { triggerId: '12', name: 'Orphan A', type: 'customEvent', parameter: [] }, // UNUSED
        { triggerId: '13', name: 'Orphan B', type: 'click', parameter: [] }, // UNUSED
      ],
      variables: [],
    };

    // list_unused is read-only and returns only the two orphans.
    const fd0 = fakeData({ snapshot });
    const listed = JSON.parse(await buildToolRegistry(fd0.data).execute('list_unused_gtm_triggers', { accountId: '1', containerId: '2', workspaceId: '3' })) as Array<{ triggerId: string }>;
    assert.deepEqual(listed.map((t) => t.triggerId).sort(), ['12', '13']);

    // delete ALL unused → removes 12 + 13, never the used 10/11.
    const fd1 = fakeData({ snapshot });
    const all = JSON.parse(await buildToolRegistry(fd1.data, approveAsIs, 'gtm').execute('delete_unused_gtm_triggers', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.equal(all.deletedCount, 2);
    assert.ok(fd1.calls.includes('deleteTrigger:1:2:3:12') && fd1.calls.includes('deleteTrigger:1:2:3:13'));
    assert.ok(!fd1.calls.some((c) => c === 'deleteTrigger:1:2:3:10' || c === 'deleteTrigger:1:2:3:11'), 'used triggers never deleted');

    // filter/selection: ask for 12 + a USED id 10 → deletes only 12, skips 10 (reported, not deleted).
    const fd2 = fakeData({ snapshot });
    const sel = JSON.parse(await buildToolRegistry(fd2.data, approveAsIs, 'gtm').execute('delete_unused_gtm_triggers', { accountId: '1', containerId: '2', workspaceId: '3', triggerIds: ['12', '10'] }));
    assert.equal(sel.deletedCount, 1);
    assert.ok(fd2.calls.includes('deleteTrigger:1:2:3:12'));
    assert.ok(!fd2.calls.includes('deleteTrigger:1:2:3:10'), 'a referenced id in the selection is skipped, never deleted');
    assert.equal(sel.skipped[0].triggerId, '10');

    // no-op: when nothing is unused, precheck short-circuits — no confirm, no delete.
    const fd3 = fakeData({ snapshot: { tags: [{ tagId: 't', name: 'T', type: 'html', firingTriggerId: ['10'], paused: false, parameter: [] }], triggers: [{ triggerId: '10', name: 'Used', type: 'pageview', parameter: [] }], variables: [] } });
    const none = JSON.parse(await buildToolRegistry(fd3.data, approveAsIs, 'gtm').execute('delete_unused_gtm_triggers', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.equal(none.deletedCount, 0, 'clean no-op when nothing is unused');
    assert.equal(fd3.calls.filter((c) => c.startsWith('deleteTrigger')).length, 0, 'no deletes when nothing is unused');
  });

  await test('unused-variable cleanup: list finds orphans; delete removes only unreferenced, filter-aware', async () => {
    const snapshot = {
      tags: [{ tagId: 't1', name: 'GA4', type: 'gaawe', firingTriggerId: [], paused: false, parameter: [{ type: 'template', key: 'm', value: '{{Used Var}}' }] }],
      triggers: [],
      variables: [
        { variableId: '10', name: 'Used Var', type: 'c', parameter: [] }, // referenced by the tag
        { variableId: '11', name: 'Orphan A', type: 'v', parameter: [] }, // UNUSED
        { variableId: '12', name: 'Orphan B', type: 'jsm', parameter: [] }, // UNUSED
      ],
    };

    const fd0 = fakeData({ snapshot });
    const listed = JSON.parse(await buildToolRegistry(fd0.data).execute('list_unused_gtm_variables', { accountId: '1', containerId: '2', workspaceId: '3' })) as Array<{ variableId: string }>;
    assert.deepEqual(listed.map((v) => v.variableId).sort(), ['11', '12']);

    const fd1 = fakeData({ snapshot });
    const all = JSON.parse(await buildToolRegistry(fd1.data, approveAsIs, 'gtm').execute('delete_unused_gtm_variables', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.equal(all.deletedCount, 2);
    assert.ok(fd1.calls.includes('deleteVar:1:2:3:11') && fd1.calls.includes('deleteVar:1:2:3:12'));
    assert.ok(!fd1.calls.includes('deleteVar:1:2:3:10'), 'a referenced variable is never deleted');

    const fd2 = fakeData({ snapshot });
    const sel = JSON.parse(await buildToolRegistry(fd2.data, approveAsIs, 'gtm').execute('delete_unused_gtm_variables', { accountId: '1', containerId: '2', workspaceId: '3', variableIds: ['11', '10'] }));
    assert.equal(sel.deletedCount, 1);
    assert.ok(fd2.calls.includes('deleteVar:1:2:3:11'));
    assert.ok(!fd2.calls.includes('deleteVar:1:2:3:10'), 'a referenced id in the selection is skipped, never deleted');
    assert.equal(sel.skipped[0].variableId, '10');
  });

  await test('environment tools: list (read) + create (write) return the install snippet', async () => {
    const calls: string[] = [];
    const env = (id: string, name: string) => ({
      environmentId: id,
      name,
      type: 'user',
      authorizationCode: 'AUTH_' + id,
      url: '',
      snippet: { head: `id=GTM-X&gtm_auth=AUTH_${id}&gtm_preview=env-${id}`, body: 'noscript' },
    });
    const data = {
      listGtmEnvironments: async () => { calls.push('list'); return [env('5', 'Live'), env('7', 'Test')]; },
      createGtmEnvironment: async (_a: string, _c: string, name: string) => { calls.push('create:' + name); return env('7', name); },
    } as unknown as GoogleDataService;

    // list is read-only (no confirm needed); create is a confirm-gated write.
    const envs = JSON.parse(await buildToolRegistry(data).execute('list_gtm_environments', { accountId: '1', containerId: '2' }));
    assert.equal(envs.length, 2);
    assert.ok(envs[1].snippet.head.includes('gtm_preview=env-7'), 'snippet carries gtm_preview=env-<id>');
    assert.equal(buildToolRegistry(data).list().some((t) => t.name === 'create_gtm_environment'), false, 'create is hidden read-only');

    const created = JSON.parse(
      await buildToolRegistry(data, approveAsIs, 'gtm').execute('create_gtm_environment', { accountId: '1', containerId: '2', name: 'Test' }),
    );
    assert.equal(created.environmentId, '7');
    assert.ok(created.snippet.head.includes('gtm_auth=AUTH_7'), 'created env returns its install snippet');
    assert.deepEqual(calls, ['list', 'create:Test']);
  });

  await test('precheck: an already-present trigger/variable is reused, NOT re-created (no approval)', async () => {
    // Existing custom-event trigger for product_view + an existing variable "GA4 Variable".
    const fd = fakeData({
      existingTriggers: [{ triggerId: '11', name: 'CE - Product View', type: 'customEvent', customEventName: 'product_view' }],
      existingVariables: [{ variableId: '5', name: 'GA4 Variable', type: 'c' }],
    });
    const c = seqConfirm(true, true); // would approve — but the precheck should skip before any prompt
    const reg = buildToolRegistry(fd.data, c.fn);

    // Same event under a different name → detected as already present, no create, no confirm.
    const trg = JSON.parse(
      await reg.execute('create_gtm_trigger', {
        accountId: '1', containerId: '2', workspaceId: '3',
        trigger: { name: 'Product View Listener', type: 'customEvent', customEventFilter: [{ type: 'equals', parameter: [{ type: 'template', key: 'arg0', value: '{{_event}}' }, { type: 'template', key: 'arg1', value: 'product_view' }] }] },
      }),
    );
    assert.equal(trg.alreadyExists, true, 'existing trigger reported as already present');
    assert.equal(trg.trigger.triggerId, '11');
    assert.equal(fd.calls.some((x) => x.startsWith('createTrigger')), false, 'no create call');
    assert.equal(c.calls.length, 0, 'no approval prompt for a no-op');

    // Existing variable by name → already present.
    const v = JSON.parse(
      await reg.execute('create_gtm_variable', { accountId: '1', containerId: '2', workspaceId: '3', variable: { name: 'GA4 Variable', type: 'c' } }),
    );
    assert.equal(v.alreadyExists, true, 'existing variable reported as already present');

    // A NEW trigger (different event) proceeds to create.
    await reg.execute('create_gtm_trigger', {
      accountId: '1', containerId: '2', workspaceId: '3',
      trigger: { name: 'CE - Add To Cart', type: 'customEvent', customEventFilter: [{ type: 'equals', parameter: [{ type: 'template', key: 'arg0', value: '{{_event}}' }, { type: 'template', key: 'arg1', value: 'add_to_cart' }] }] },
    });
    assert.ok(fd.calls.some((x) => x.startsWith('createTrigger:')), 'a genuinely new trigger is created');
  });

  await test('server-side GTM: list tools are read-only; create + bootstrap are confirm-gated writes', async () => {
    const fd = fakeData();
    // Read tools available without a confirm fn.
    const ro = buildToolRegistry(fd.data);
    assert.ok(ro.list().some((t) => t.name === 'list_gtm_clients') && ro.list().some((t) => t.name === 'list_gtm_transformations'), 'sGTM list tools are read-only');
    assert.equal(ro.list().some((t) => t.name === 'create_server_container'), false, 'create_server_container hidden read-only');

    const reg = buildToolRegistry(fd.data, approveAsIs, 'gtm');
    const created = JSON.parse(await reg.execute('create_server_container', { accountId: '1', name: 'Server' }));
    assert.equal(created.publicId, 'GTM-SERVER');
    assert.ok(fd.calls.includes('createServerContainer:1:Server'));

    const boot = JSON.parse(await reg.execute('bootstrap_server_side_tagging', { accountId: '1', name: 'Server', measurementId: 'G-1' }));
    assert.equal(boot.serverTag.name, 'GA4 - Server');
    assert.equal(boot.client.name, 'GA4');
    assert.ok(fd.calls.includes('bootstrapServer:1:Server:G-1'));

    const client = JSON.parse(await reg.execute('create_gtm_client', { accountId: '1', containerId: '2', workspaceId: '3', client: { name: 'GA4', type: 'gaaw_client' } }));
    assert.equal(client.type, 'gaaw_client');

    // Phase 2: web→server wiring sets the web Google tag's server_container_url.
    const wired = JSON.parse(
      await reg.execute('set_web_server_container_url', { accountId: '1', containerId: '2', workspaceId: '3', tagId: '9', serverUrl: 'https://sgtm.example.com' }),
    );
    assert.equal(wired.serverContainerUrl, 'https://sgtm.example.com');
    assert.ok(fd.calls.includes('setWebServerUrl:9:https://sgtm.example.com'));

    // Delete a (duplicate) server client — destructive, two confirms.
    const dc = seqConfirm(true, true);
    await buildToolRegistry(fd.data, dc.fn, 'gtm').execute('delete_gtm_client', { accountId: '1', containerId: '2', workspaceId: '3', clientId: '4', name: 'GA4 Client' });
    assert.equal(dc.calls.length, 2, 'delete client asked twice');
    assert.ok(fd.calls.includes('deleteClient:4'), 'deleted the duplicate client via the API');

    // Set the SERVER container's own tagging URL (the API CAN write taggingServerUrls).
    const tagged = JSON.parse(
      await reg.execute('set_server_container_tagging_url', { accountId: '1', containerId: '256548971', serverUrl: 'https://sgtm.example.com' }),
    );
    assert.deepEqual(tagged.taggingServerUrls, ['https://sgtm.example.com']);
    assert.ok(fd.calls.includes('setServerTaggingUrl:256548971:https://sgtm.example.com'), 'wrote taggingServerUrls via the API');

    // Phase 3: server tags by platform → correct sgtm* type via create_gtm_tag.
    const adsConv = JSON.parse(
      await reg.execute('create_server_tag', { accountId: '1', containerId: '2', workspaceId: '3', platform: 'ads_conversion', name: 'Ads - Purchase', conversionId: 'AW-1', conversionLabel: 'L1' }),
    );
    assert.equal(adsConv.type, 'sgtmadsct');
    const ga4srv = JSON.parse(
      await reg.execute('create_server_tag', { accountId: '1', containerId: '2', workspaceId: '3', platform: 'ga4', name: 'GA4 - Server', measurementId: 'G-1' }),
    );
    assert.equal(ga4srv.type, 'sgtmgaaw', 'platform ga4 → sgtmgaaw server tag');
    // missing required field → clear error (no create)
    await assert.rejects(() => reg.execute('create_server_tag', { accountId: '1', containerId: '2', workspaceId: '3', platform: 'ads_conversion', name: 'X' }), /requires conversionId/);

    // create_server_trigger builds the correct customEvent shape + enables the Client Name built-in.
    const srvTrig = JSON.parse(
      await reg.execute('create_server_trigger', { accountId: '1', containerId: '2', workspaceId: '3', name: 'GA4 - Server Trigger', clientName: 'GA4' }),
    );
    assert.equal(srvTrig.type, 'customEvent', 'server trigger is a customEvent (built by the tool, not hand-rolled)');
    assert.ok(fd.calls.includes('enableVars:1:2:3:clientName'), 'enabled the Client Name built-in for the scoped filter');

    // import_gallery_template: bring in the Meta Pixel community template (write) → returns its cvt_ type.
    const imp = JSON.parse(
      await reg.execute('import_gallery_template', { accountId: '1', containerId: '2', workspaceId: '3', owner: 'facebook', repository: 'GoogleTagManager-WebTemplate-For-FacebookPixel' }),
    );
    assert.equal(imp.type, 'cvt_5RM3Q', 'returns the gallery template tag-type code (cvt_<galleryTemplateId>)');
    assert.ok(fd.calls.includes('importTemplate:facebook/GoogleTagManager-WebTemplate-For-FacebookPixel'));

    // create_meta_pixel_tag imports the template + creates a tag of its cvt_ type; name optional.
    const metaTag = JSON.parse(
      await reg.execute('create_meta_pixel_tag', { accountId: '1', containerId: '2', workspaceId: '3', pixelId: '123', event: 'view content', firingTriggerId: ['9'], objectProperties: [{ name: 'value', value: '{{Ecommerce Value}}' }] }),
    );
    assert.equal(metaTag.type, 'cvt_5RM3Q', 'built on the imported Meta Pixel template type');
    assert.equal(metaTag.name, 'Meta - Event - ViewContent Tag', 'default name + canonicalized event');
    // a blank event is rejected (not silently created as an empty custom event)
    await assert.rejects(() => reg.execute('create_meta_pixel_tag', { accountId: '1', containerId: '2', workspaceId: '3', pixelId: '1', event: '  ' }), /event is required/);

    // create_meta_capi_server_tag imports the Stape template + creates the CAPI server tag.
    const capi = JSON.parse(
      await reg.execute('create_meta_capi_server_tag', { accountId: '1', containerId: '2', workspaceId: '3', pixelId: '{{Pixel}}', accessToken: '{{Token}}', event: 'Purchase', firingTriggerId: ['5'] }),
    );
    assert.equal(capi.type, 'cvt_5RM3Q', 'built on the imported Stape CAPI template type');
    assert.equal(capi.name, 'Meta CAPI - Purchase Tag', 'default CAPI name');
    assert.ok(fd.calls.includes('importTemplate:stape-io/facebook-tag'));
    await assert.rejects(() => reg.execute('create_meta_capi_server_tag', { accountId: '1', containerId: '2', workspaceId: '3', pixelId: '1', accessToken: '', event: 'Purchase' }), /accessToken is required/);

    // create_tiktok_capi_server_tag imports the Stape TikTok template + creates the Events API server tag.
    const ttapi = JSON.parse(
      await reg.execute('create_tiktok_capi_server_tag', { accountId: '1', containerId: '2', workspaceId: '3', pixelId: '{{TT Pixel}}', accessToken: '{{TT Token}}', event: 'purchase', firingTriggerId: ['5'], userData: [{ name: 'email', value: '{{Email}}' }], eventProperties: [{ name: 'value', value: '{{Ecommerce Value}}' }], eventId: '{{Event ID}}' }),
    );
    // (fake createGtmTag echoes a stub; the parameter[] shape is asserted in gtm-builders.test.ts)
    assert.equal(ttapi.name, 'TikTok CAPI - Purchase Tag', 'default name + GA4 purchase mapped to the current Purchase event');
    assert.ok(fd.calls.includes('importTemplate:stape-io/tiktok-tag'), 'imported the Stape TikTok server template');
    await assert.rejects(() => reg.execute('create_tiktok_capi_server_tag', { accountId: '1', containerId: '2', workspaceId: '3', pixelId: '1', accessToken: '', event: 'Purchase' }), /accessToken is required/);

    // update_gtm_trigger fixes a Custom Event trigger's Event name IN PLACE (no delete+recreate).
    const upd = JSON.parse(
      await reg.execute('update_gtm_trigger', { accountId: '1', containerId: '2', workspaceId: '3', triggerId: '224', eventName: 'purchase' }),
    );
    assert.equal(upd.customEventName, 'purchase');
    assert.ok(fd.calls.includes('updateTrigger:224:purchase:'));
    await assert.rejects(() => reg.execute('update_gtm_trigger', { accountId: '1', containerId: '2', workspaceId: '3', triggerId: '224' }), /name and\/or eventName/);

    // copy_workspace_resources: recreate tags/triggers/variables from one workspace into another.
    const copied = JSON.parse(
      await reg.execute('copy_workspace_resources', { accountId: '1', containerId: '2', fromWorkspaceId: '4', toWorkspaceId: '2' }),
    );
    assert.deepEqual(copied.tags.created, ['Tag']);
    assert.deepEqual(copied.tags.skipped, ['Existing'], 'name collisions are skipped, not overwritten');
    assert.ok(fd.calls.includes('copyWorkspace:1:2:4:2'));

    // Meta CAPI: create the EMQ Event Data variables (write) + detect Meta web tags (read).
    const emq = JSON.parse(await reg.execute('create_meta_emq_variables', { accountId: '1', containerId: '2', workspaceId: '3' }));
    assert.ok(emq.created.includes('ed - fbp') && emq.created.includes('ed - event_id'), 'created the EMQ variables');
    assert.ok(fd.calls.includes('metaEmq:1:2:3'));
    const meta = JSON.parse(
      await buildToolRegistry(
        fakeData({
          snapshot: {
            tags: [
              { tagId: '1', name: 'FB Pixel - Purchase', type: 'html', firingTriggerId: [], paused: false, parameter: [{ key: 'html', value: "fbq('track','Purchase',{value:9})" }] },
              { tagId: '2', name: 'GA4 Config', type: 'gaawc', firingTriggerId: [], paused: false, parameter: [] },
            ],
            triggers: [],
            variables: [],
          },
        }).data,
      ).execute('detect_meta_web_tags', { accountId: '1', containerId: '2', workspaceId: '3' }),
    );
    assert.equal(meta.hasMetaPixel, true, 'detected the FB pixel tag');
    assert.equal(meta.hasEcommerce, true, 'detected the Purchase event');
    assert.deepEqual(meta.metaTags.map((t: { id: string }) => t.id), ['1'], 'only the Meta tag, not GA4');

    // Phase 4: Event Data variable (server) + allow-params transformation.
    const edVar = JSON.parse(
      await reg.execute('create_gtm_variable_typed', { accountId: '1', containerId: '2', workspaceId: '3', kind: 'event_data', name: 'ed - items', keyPath: 'items' }),
    );
    assert.equal(edVar.type, 'ed', 'event_data → ed variable');
    const xform = JSON.parse(
      await reg.execute('create_gtm_transformation', { accountId: '1', containerId: '2', workspaceId: '3', name: 'Keep ecommerce', allowParams: ['transaction_id', 'currency'] }),
    );
    assert.equal(xform.type, 'tf_allow_params', 'allowParams → tf_allow_params transformation');
    // neither allowParams nor a raw transformation → clear error
    await assert.rejects(() => reg.execute('create_gtm_transformation', { accountId: '1', containerId: '2', workspaceId: '3' }), /allowParams|transformation/);

    // Bootstrap a server container FROM a web container: derive the GA4 id from webContainerId.
    await reg.execute('bootstrap_server_side_tagging', { accountId: '1', name: 'Test Server', webContainerId: '2' });
    assert.ok(fd.calls.includes('deriveMid:1:2'), 'derived the Measurement ID from the web container');
    assert.ok(fd.calls.includes('bootstrapServer:1:Test Server:G-WEB123'), 'bootstrapped relaying to the derived id');
    // neither measurementId nor webContainerId → clear error
    await assert.rejects(() => reg.execute('bootstrap_server_side_tagging', { accountId: '1', name: 'X' }), /measurementId|webContainerId/);
    // a whitespace-only measurementId must NOT relay a blank id — it's trimmed → treated as absent.
    await assert.rejects(() => reg.execute('bootstrap_server_side_tagging', { accountId: '1', name: 'X', measurementId: '   ' }), /measurementId|webContainerId/);

    // Phase 5: server-container audit (read) + runtime endpoint check (read) — use `ro`.
    const srvAudit = JSON.parse(await ro.execute('audit_server_container', { accountId: '1', containerId: '2', workspaceId: '3' }));
    const am = srvAudit.findings.map((f: { message: string }) => f.message).join(' | ');
    assert.ok(srvAudit.summary.critical >= 1, 'no client → critical');
    assert.ok(/no client/i.test(am) && /no tagging server URL/i.test(am), 'flags missing client + tagging URL');
    assert.ok(/NOT that the tagging server is deployed/i.test(srvAudit.boundary), 'server boundary statement');
    const verify = JSON.parse(await ro.execute('verify_server_endpoint', { serverUrl: 'https://sgtm.example.com' }));
    assert.equal(verify.ok, true);
    assert.ok(verify.url.endsWith('/healthy'), 'probes the /healthy endpoint');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
