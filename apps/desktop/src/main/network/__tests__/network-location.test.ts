// Pure-logic tests for the Network & Location detector: adapter → provider inference, org → provider,
// the connection classifier's precedence, geo-JSON normalization per provider, provider fallback chain,
// and getNetworkLocation's cache/force + offline behavior (all with injected fetch/interfaces/clock —
// no real network, no Electron).
//
// Run: tsx apps/desktop/src/main/network/__tests__/network-location.test.ts

import type { NetworkInterfaceInfo } from 'node:os';
import {
  detectVpnAdapters,
  providerFromOrg,
  matchProviderSig,
  classifyConnection,
  normalizeGeo,
  fetchGeo,
  getNetworkLocation,
  __resetNetworkCache,
} from '../network-location';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const ext = (address: string): NetworkInterfaceInfo => ({ address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: null });
const loop = (): NetworkInterfaceInfo => ({ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: null });

// A fake fetch that serves a scripted body per URL substring; unmatched URLs 404. Records call order.
function fakeFetch(routes: { match: string; ok?: boolean; status?: number; body?: unknown; throws?: boolean }[]): {
  impl: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  calls: string[];
} {
  const calls: string[] = [];
  const impl = async (url: string): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
    calls.push(url);
    const r = routes.find((x) => url.includes(x.match));
    if (!r) return { ok: false, status: 404, json: async () => ({}) };
    if (r.throws) throw new Error('network down');
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body };
  };
  return { impl, calls };
}

async function run(): Promise<void> {
  // ── detectVpnAdapters ──────────────────────────────────────────────────────────────────────────
  {
    const s = detectVpnAdapters({ 'Ethernet': [ext('192.168.1.9')], 'Surfshark': [ext('10.14.0.2')], 'Loopback': [loop()] });
    check('adapter: branded Surfshark adapter → active + provider', s.active && s.provider === 'Surfshark');
    check('adapter: names the triggering adapter', s.adapterNames.includes('Surfshark'));
  }
  {
    const s = detectVpnAdapters({ 'WireGuard Tunnel': [ext('10.7.0.2')] });
    check('adapter: generic WireGuard tunnel → active but provider null', s.active && s.provider === null);
  }
  {
    // Linux/macOS OpenVPN tunnel interfaces are indexed (tun0/tun1) — the \btun\d*\b signature must catch them.
    const s0 = detectVpnAdapters({ 'tun0': [ext('10.8.0.2')], 'eth0': [ext('192.168.1.9')] });
    check('adapter: Linux OpenVPN tun0 → active (generic, no brand)', s0.active && s0.provider === null && s0.adapterNames.includes('tun0'));
    const s1 = detectVpnAdapters({ 'utun4': [ext('10.9.0.2')] });
    check('adapter: macOS utun4 → active', s1.active);
    // Must NOT false-match ordinary names that merely contain "tun".
    const neg = detectVpnAdapters({ 'Fortune-LAN': [ext('192.168.5.5')], 'tuna': [ext('192.168.5.6')] });
    check('adapter: "Fortune"/"tuna" do not false-trigger the tun signature', !neg.active);
  }
  {
    const s = detectVpnAdapters({ 'NordLynx': [ext('10.5.0.2')], 'Wi-Fi': [ext('192.168.0.5')] });
    check('adapter: NordLynx maps to NordVPN', s.active && s.provider === 'NordVPN');
  }
  {
    // A VPN-named adapter that is DOWN (no non-internal address) must NOT count.
    const s = detectVpnAdapters({ 'Surfshark': [loop()], 'Ethernet': [ext('192.168.1.9')] });
    check('adapter: disconnected VPN adapter (internal only) is ignored', !s.active && s.provider === null);
  }
  {
    const s = detectVpnAdapters({ 'Ethernet': [ext('192.168.1.9')], 'Wi-Fi': [ext('192.168.1.22')] });
    check('adapter: plain LAN → not active', !s.active);
  }

  // ── providerFromOrg / matchProviderSig ────────────────────────────────────────────────────────
  check('org: "Tefincom S.A." → NordVPN', providerFromOrg('Tefincom S.A.') === 'NordVPN');
  check('org: "Surfshark Ltd" → Surfshark', providerFromOrg('Surfshark Ltd') === 'Surfshark');
  check('org: "Proton AG" → Proton VPN', providerFromOrg('Proton AG') === 'Proton VPN');
  check('org: residential ISP → null', providerFromOrg('BT Public Internet Service') === null);
  check('org: null → null', providerFromOrg(null) === null);
  check('sig: generic openvpn is not branded', matchProviderSig('OpenVPN TAP-Windows6')?.branded === false);

  // ── classifyConnection precedence ────────────────────────────────────────────────────────────
  {
    const v = classifyConnection({ adapter: { active: true, provider: 'Surfshark', adapterNames: ['Surfshark'] }, org: 'Datacamp Limited', asn: 'AS60068' });
    check('classify: branded adapter wins → vpn/Surfshark/high', v.connectionType === 'vpn' && v.provider === 'Surfshark' && v.confidence === 'high');
  }
  {
    // Generic tunnel adapter up, but org names the brand → fill provider from org, high confidence.
    const v = classifyConnection({ adapter: { active: true, provider: null, adapterNames: ['WireGuard Tunnel'] }, org: 'Surfshark Ltd', asn: 'AS9009' });
    check('classify: generic adapter + branded org → vpn/Surfshark', v.connectionType === 'vpn' && v.provider === 'Surfshark');
    check('classify: records both adapter and org signals', v.detectedVia.some((d) => d.includes('adapter')) && v.detectedVia.some((d) => d.toLowerCase().includes('org')));
  }
  {
    // No adapter, but the public IP org is a consumer VPN (system-level app VPN case).
    const v = classifyConnection({ adapter: { active: false, provider: null, adapterNames: [] }, org: 'NordVPN', asn: 'AS9009' });
    check('classify: branded org, no adapter → vpn/NordVPN/medium', v.connectionType === 'vpn' && v.provider === 'NordVPN' && v.confidence === 'medium');
  }
  {
    const v = classifyConnection({ adapter: { active: false, provider: null, adapterNames: [] }, org: 'M247 Europe SRL', asn: 'AS9009' });
    check('classify: hosting range → vpn/low/no-brand', v.connectionType === 'vpn' && v.provider === null && v.confidence === 'low');
  }
  {
    const v = classifyConnection({ adapter: { active: false, provider: null, adapterNames: [] }, org: 'Comcast Cable', asn: 'AS7922', flags: { proxy: true } });
    check('classify: proxy flag → proxy', v.connectionType === 'proxy');
  }
  {
    const v = classifyConnection({ adapter: { active: false, provider: null, adapterNames: [] }, org: 'Comcast Cable Communications', asn: 'AS7922' });
    check('classify: residential ISP → local/none', v.connectionType === 'local' && v.provider === null && v.confidence === 'none');
  }

  // ── normalizeGeo per provider ──────────────────────────────────────────────────────────────────
  {
    const g = normalizeGeo('ipwho', { success: true, ip: '203.0.113.7', country: 'United Kingdom', country_code: 'GB', region: 'England', city: 'London', connection: { asn: 9009, org: 'M247', isp: 'M247 Ltd' } });
    check('normalize ipwho: fields + ASxxxx', !!g && g.ip === '203.0.113.7' && g.countryCode === 'GB' && g.city === 'London' && g.asn === 'AS9009' && g.org === 'M247');
  }
  check('normalize ipwho: success:false → null', normalizeGeo('ipwho', { success: false, message: 'rate limited' }) === null);
  {
    const g = normalizeGeo('ipapi', { ip: '198.51.100.4', city: 'Paris', region: 'IDF', country_name: 'France', country_code: 'FR', org: 'Proton AG', asn: 'AS62371' });
    check('normalize ipapi: fields', !!g && g.ip === '198.51.100.4' && g.country === 'France' && g.org === 'Proton AG');
  }
  check('normalize ipapi: error body → null', normalizeGeo('ipapi', { error: true, reason: 'RateLimited' }) === null);
  {
    const g = normalizeGeo('ifconfig', { ip: '203.0.113.9', country: 'Germany', country_iso: 'DE', region_name: 'Hesse', city: 'Frankfurt', asn_org: 'Hetzner', asn: 'AS24940' });
    check('normalize ifconfig: fields', !!g && g.ip === '203.0.113.9' && g.city === 'Frankfurt' && g.org === 'Hetzner');
  }
  check('normalize: non-object → null', normalizeGeo('ipwho', 'nope') === null);

  // ── fetchGeo fallback chain ────────────────────────────────────────────────────────────────────
  {
    // Primary (ipwho) fails hard; secondary (ipapi) returns data → should use ipapi and stop.
    const f = fakeFetch([
      { match: 'ipwho.is', throws: true },
      { match: 'ipapi.co', body: { ip: '198.51.100.4', city: 'Paris', country_name: 'France', country_code: 'FR', org: 'OVH SAS', asn: 'AS16276' } },
    ]);
    const g = await fetchGeo(f.impl);
    check('fetchGeo: falls through to secondary provider', !!g && g.ip === '198.51.100.4');
    check('fetchGeo: stops once a provider succeeds (no ifconfig call)', !f.calls.some((u) => u.includes('ifconfig')));
  }
  {
    // Primary returns success:false (empty), secondary 404, tertiary succeeds.
    const f = fakeFetch([
      { match: 'ipwho.is', body: { success: false } },
      { match: 'ipapi.co', ok: false, status: 429, body: {} },
      { match: 'ifconfig.co', body: { ip: '203.0.113.9', country: 'Germany', country_iso: 'DE', city: 'Frankfurt', asn_org: 'Hetzner' } },
    ]);
    const g = await fetchGeo(f.impl);
    check('fetchGeo: skips empty + non-ok, uses tertiary', !!g && g.ip === '203.0.113.9' && f.calls.length === 3);
  }
  {
    const f = fakeFetch([{ match: 'ipwho.is', throws: true }, { match: 'ipapi.co', throws: true }, { match: 'ifconfig.co', throws: true }]);
    const g = await fetchGeo(f.impl);
    check('fetchGeo: all providers down → null', g === null);
  }

  // ── getNetworkLocation: end-to-end, cache, force, offline ───────────────────────────────────────
  {
    __resetNetworkCache();
    let clock = 1_000_000;
    const now = (): number => clock;
    const ifaces = (): Record<string, NetworkInterfaceInfo[]> => ({ 'Surfshark': [ext('10.14.0.2')], 'Wi-Fi': [ext('192.168.0.5')] });
    const f = fakeFetch([{ match: 'ipwho.is', body: { success: true, ip: '203.0.113.7', country: 'United Kingdom', country_code: 'GB', region: 'England', city: 'London', connection: { asn: 9009, org: 'Datacamp Limited' } } }]);
    const v = await getNetworkLocation({ force: true }, { fetchImpl: f.impl, ifaces, now });
    check('getNetworkLocation: connected + geo mapped', v.status === 'connected' && v.ip === '203.0.113.7' && v.city === 'London' && v.countryCode === 'GB');
    check('getNetworkLocation: adapter drives VPN + provider', v.connectionType === 'vpn' && v.provider === 'Surfshark' && v.confidence === 'high');
    check('getNetworkLocation: stamps checkedAt from clock', v.checkedAt === 1_000_000);

    // Second call within TTL, NOT forced → served from cache (no new fetch).
    const before = f.calls.length;
    clock += 10_000;
    const v2 = await getNetworkLocation({ ttlMs: 60_000 }, { fetchImpl: f.impl, ifaces, now });
    check('getNetworkLocation: within TTL returns cache (no refetch)', f.calls.length === before && v2.checkedAt === 1_000_000);

    // Forced → refetches and restamps.
    clock += 5_000;
    const v3 = await getNetworkLocation({ force: true }, { fetchImpl: f.impl, ifaces, now });
    check('getNetworkLocation: force refetches + restamps', f.calls.length > before && v3.checkedAt === 1_015_000);
  }
  {
    __resetNetworkCache();
    // Offline but a VPN adapter is up → status offline, still reports vpn/provider honestly.
    const f = fakeFetch([{ match: 'ipwho.is', throws: true }, { match: 'ipapi.co', throws: true }, { match: 'ifconfig.co', throws: true }]);
    const v = await getNetworkLocation({ force: true }, { fetchImpl: f.impl, ifaces: () => ({ 'NordLynx': [ext('10.5.0.2')] }), now: () => 42 });
    check('getNetworkLocation: offline with VPN adapter → offline + vpn + NordVPN', v.status === 'offline' && v.connectionType === 'vpn' && v.provider === 'NordVPN' && v.ip === null);
    check('getNetworkLocation: offline sets a detail message', typeof v.detail === 'string' && v.detail!.length > 0);
  }
  {
    __resetNetworkCache();
    // Offline, no VPN adapter → unknown.
    const f = fakeFetch([{ match: 'x', throws: true }]);
    const v = await getNetworkLocation({ force: true }, { fetchImpl: f.impl, ifaces: () => ({ 'Wi-Fi': [ext('192.168.0.5')] }), now: () => 7 });
    check('getNetworkLocation: offline no-VPN → unknown/offline', v.status === 'offline' && v.connectionType === 'unknown');
  }
}

void run().then(() => {
  console.log(`\nnetwork-location: ${passed} passed, ${failed} failed`);
  if (failed) { console.error(failures.join('\n')); process.exit(1); }
  if (passed < 30) { console.error(`expected >= 30 checks, got ${passed}`); process.exit(1); }
});
