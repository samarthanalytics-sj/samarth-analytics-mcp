// Pure tests for the install manifest (fingerprint + upsert + drift diff). Run:
//   tsx src/shared/__tests__/install-manifest.test.ts
import {
  fingerprintResource,
  upsertResources,
  diffManifest,
  type InstallManifest,
  type ManifestResource,
} from '../install-manifest';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── fingerprint stability ────────────────────────────────────────────────────
// Same logical config, but the parameter's object keys are in a DIFFERENT order
// and nested differently → the fingerprint must be identical (key order ignored).
const paramA = {
  name: 'GA4 - Event - Purchase Tag',
  type: 'gaawe',
  parameter: [
    { type: 'template', key: 'measurementIdOverride', value: 'G-123' },
    { type: 'boolean', key: 'sendEcommerceData', value: 'true' },
    { type: 'map', key: 'x', map: [{ a: 1, b: 2 }, { c: 3 }] },
  ],
};
const paramShuffled = {
  // top-level keys shuffled
  type: 'gaawe',
  parameter: [
    // same array ORDER (array order is meaningful) but each object's KEYS shuffled
    { key: 'measurementIdOverride', value: 'G-123', type: 'template' },
    { value: 'true', key: 'sendEcommerceData', type: 'boolean' },
    { key: 'x', type: 'map', map: [{ b: 2, a: 1 }, { c: 3 }] },
  ],
  name: 'GA4 - Event - Purchase Tag',
};
check('fingerprint: shuffled parameter key order → identical hash',
  fingerprintResource(paramA) === fingerprintResource(paramShuffled),
  `${fingerprintResource(paramA)} vs ${fingerprintResource(paramShuffled)}`);

check('fingerprint: is short hex (8 chars)', /^[0-9a-f]{8}$/.test(fingerprintResource(paramA)));

// A changed VALUE inside parameter → different hash.
const paramChangedValue = structuredClone(paramShuffled);
(paramChangedValue.parameter[0] as { value: string }).value = 'G-999';
check('fingerprint: changed parameter value → different hash',
  fingerprintResource(paramA) !== fingerprintResource(paramChangedValue));

// A changed NAME → different hash.
check('fingerprint: changed name → different hash',
  fingerprintResource(paramA) !== fingerprintResource({ ...paramA, name: 'Renamed Tag' }));

// A changed TYPE → different hash.
check('fingerprint: changed type → different hash',
  fingerprintResource(paramA) !== fingerprintResource({ ...paramA, type: 'html' }));

// Array ORDER inside parameter IS meaningful → reordering elements changes the hash.
const paramReordered = structuredClone(paramA);
paramReordered.parameter = [paramA.parameter[1], paramA.parameter[0], paramA.parameter[2]];
check('fingerprint: reordered parameter array → different hash (order is meaningful)',
  fingerprintResource(paramA) !== fingerprintResource(paramReordered));

// Missing/undefined parameter is stable and deterministic.
check('fingerprint: undefined parameter deterministic',
  fingerprintResource({ name: 'V', type: 'v' }) === fingerprintResource({ name: 'V', type: 'v', parameter: null }));

// ── upsertResources: merge by (kind,id) ──────────────────────────────────────
function emptyManifest(): InstallManifest {
  return { version: 1, account: '1', container: '2', workspace: '3', updatedAt: 't0', resources: [] };
}
const r = (kind: ManifestResource['kind'], id: string, name: string, fp: string): ManifestResource =>
  ({ kind, id, name, fingerprint: fp, tool: 'setup_ecommerce_funnel' });

const m0 = emptyManifest();
const m1 = upsertResources(m0, [r('tag', '10', 'Tag A', 'aaaa1111'), r('trigger', '20', 'Trig A', 'bbbb2222')], 't1');
check('upsert: input manifest not mutated', m0.resources.length === 0);
check('upsert: returns new manifest with updatedAt set', m1.updatedAt === 't1' && m1 !== m0);
check('upsert: adds both resources', m1.resources.length === 2);

// Re-upsert same (kind,id) with new name/fp → replaces, does NOT duplicate.
const m2 = upsertResources(m1, [r('tag', '10', 'Tag A renamed', 'ffff9999')], 't2');
check('upsert: merge-by-id replaces, no duplicate', m2.resources.length === 2);
const tag10 = m2.resources.find((x) => x.kind === 'tag' && x.id === '10');
check('upsert: replaced resource has the new fields', !!tag10 && tag10.name === 'Tag A renamed' && tag10.fingerprint === 'ffff9999');
// Same id but DIFFERENT kind is a distinct resource.
const m3 = upsertResources(m2, [r('trigger', '10', 'Trigger 10', 'cccc3333')], 't3');
check('upsert: same id different kind is distinct', m3.resources.length === 3);

// ── diffManifest: intact / modified / deleted / unmanaged ─────────────────────
// Build a manifest whose fingerprints match a "live" snapshot, then mutate live.
const liveTagIntact = { tagId: '100', name: 'GA4 - Event - View Item Tag', type: 'gaawe', parameter: [{ type: 'template', key: 'eventName', value: 'view_item' }] };
const liveTrigIntact = { triggerId: '200', name: 'CE - view_item', type: 'customEvent', parameter: [] as unknown[] };
const liveVarIntact = { variableId: '300', name: 'dlv - ecommerce.value', type: 'v', parameter: [{ key: 'name', value: 'ecommerce.value' }] };

const manifest: InstallManifest = {
  version: 1, account: '1', container: '2', workspace: '3', updatedAt: 't0',
  resources: [
    { kind: 'tag', id: '100', name: liveTagIntact.name, fingerprint: fingerprintResource(liveTagIntact), tool: 'setup_ecommerce_funnel' },
    { kind: 'trigger', id: '200', name: liveTrigIntact.name, fingerprint: fingerprintResource(liveTrigIntact), tool: 'setup_ecommerce_funnel' },
    { kind: 'variable', id: '300', name: liveVarIntact.name, fingerprint: fingerprintResource(liveVarIntact), tool: 'setup_ecommerce_funnel' },
    // A tag we recorded that will be DELETED from live below (id 999 absent).
    { kind: 'tag', id: '999', name: 'GA4 - Event - Purchase Tag', fingerprint: 'deadbeef', tool: 'setup_ecommerce_funnel' },
  ],
};

// Live: tag 100 MODIFIED (parameter changed), trigger 200 + variable 300 INTACT,
// tag 999 DELETED (absent), plus an UNMANAGED manual tag 500.
const liveTagModified = { tagId: '100', name: liveTagIntact.name, type: 'gaawe', parameter: [{ type: 'template', key: 'eventName', value: 'view_item' }, { type: 'boolean', key: 'sendEcommerceData', value: 'false' }] };
const live = {
  tags: [liveTagModified, { tagId: '500', name: 'Manual - Meta Pixel', type: 'html', parameter: [] }],
  triggers: [liveTrigIntact],
  variables: [liveVarIntact],
};

const report = diffManifest(manifest, live);
const byId = (id: string) => report.managed.find((e) => e.id === id);
check('diff: trigger 200 intact', byId('200')?.status === 'intact');
check('diff: variable 300 intact', byId('300')?.status === 'intact');
check('diff: tag 100 modified (parameter changed)', byId('100')?.status === 'modified');
check('diff: tag 999 deleted (absent from live)', byId('999')?.status === 'deleted');
check('diff: tag 500 is unmanaged (manual addition)', report.unmanaged.some((u) => u.id === '500' && u.kind === 'tag'));
check('diff: managed count = 4', report.managed.length === 4);
check('diff: summary intact=2', report.summary.intact === 2);
check('diff: summary modified=1', report.summary.modified === 1);
check('diff: summary deleted=1', report.summary.deleted === 1);
check('diff: summary unmanaged=1', report.summary.unmanaged === 1);

// A RENAMED live resource (same id, new name) is 'modified' and the detail mentions the rename.
const liveRenamed = { tags: [{ tagId: '100', name: 'Renamed by user', type: 'gaawe', parameter: liveTagIntact.parameter }], triggers: [], variables: [] };
const renamedReport = diffManifest(manifest, liveRenamed);
const renamedEntry = renamedReport.managed.find((e) => e.id === '100');
check('diff: renamed live resource → modified', renamedEntry?.status === 'modified');
check('diff: renamed detail mentions old + new name', !!renamedEntry && renamedEntry.detail.includes('Renamed'));

// All-intact fast path: live exactly matches the recorded fingerprints (minus the deleted one).
const allIntact = { tags: [liveTagIntact], triggers: [liveTrigIntact], variables: [liveVarIntact] };
const intactReport = diffManifest({ ...manifest, resources: manifest.resources.filter((r2) => r2.id !== '999') }, allIntact);
check('diff: all-intact → no modified/deleted/unmanaged',
  intactReport.summary.intact === 3 && intactReport.summary.modified === 0 && intactReport.summary.deleted === 0 && intactReport.summary.unmanaged === 0);

// Empty live snapshot → every managed resource is 'deleted', nothing unmanaged.
const emptyLive = diffManifest(manifest, {});
check('diff: empty live → all deleted', emptyLive.summary.deleted === 4 && emptyLive.summary.unmanaged === 0 && emptyLive.summary.intact === 0);

// client kind is diffed by clientId.
const clientManifest: InstallManifest = {
  version: 1, account: '1', container: '2', workspace: '3', updatedAt: 't0',
  resources: [{ kind: 'client', id: '77', name: 'GA4 Client', fingerprint: fingerprintResource({ name: 'GA4 Client', type: 'gaaw_client', parameter: [] }), tool: 'setup_x' }],
};
const clientReport = diffManifest(clientManifest, { clients: [{ clientId: '77', name: 'GA4 Client', type: 'gaaw_client', parameter: [] }] });
check('diff: client tracked by clientId → intact', clientReport.summary.intact === 1);
const clientReportDeleted = diffManifest(clientManifest, { clients: [] });
check('diff: client absent → deleted', clientReportDeleted.summary.deleted === 1);

console.log(`\ninstall-manifest: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
