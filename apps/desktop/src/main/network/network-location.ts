// Network & Location detection for the desktop app.
//
// Answers "where is this app's outbound traffic coming from right now?" so the user can confirm, before
// running an audit, that website audits / form submissions / click events egress from the intended
// network (their real ISP, a VPN exit, or a proxy). The detected public IP is the app's OWN egress:
// because the app installs no proxy of its own, that egress equals the OS routing table, so under a
// full-tunnel OS VPN it is also the route the offscreen-Chromium audits and form submits take.
//
// Two independent signals are combined:
//   1) Local network adapters (os.networkInterfaces) — an active WireGuard/OpenVPN/TAP tunnel, or a
//      branded adapter ("Surfshark", "NordLynx"), is a strong, offline VPN signal and often names the
//      provider outright.
//   2) The public IP's geolocation + ISP/organization from a keyless geo service — gives country/region/
//      city and, via the org string, a second shot at the provider (e.g. "Surfshark Ltd", "Tefincom").
//
// The pure functions (adapter/org/classify) take plain data so they are unit-testable without Electron
// or the network; only fetchGeo touches the outside world and its fetch is injectable.

import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { NetworkLocationView, NetworkConnectionType } from '../../shared/ipc';

/** Normalized shape returned by any geo provider before classification. */
export interface GeoInfo {
  ip: string | null;
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  org: string | null;
  asn: string | null;
}

/** Result of scanning the local network adapters for an active VPN tunnel. */
export interface AdapterSignal {
  /** An active, non-internal tunnel/VPN adapter is present. */
  active: boolean;
  /** Provider inferred from the adapter name, or null (generic tunnel with no brand in the name). */
  provider: string | null;
  /** Names of the adapters that triggered the signal (for the "detected via" note). */
  adapterNames: string[];
}

// ── Provider signatures ─────────────────────────────────────────────────────────────────────────────
// Ordered, most-specific first. Each maps a regex (tested against an adapter name OR an ISP/org string)
// to a display provider name. Branded entries identify a consumer VPN; the generic tunnel entries
// (WireGuard/OpenVPN) only prove "a tunnel is up" so they carry provider=null.
interface Sig { re: RegExp; provider: string | null; branded: boolean }
const PROVIDER_SIGS: Sig[] = [
  { re: /nordlynx|nordvpn|tefincom/i, provider: 'NordVPN', branded: true },
  { re: /surfshark/i, provider: 'Surfshark', branded: true },
  { re: /proton\s*vpn|protonvpn|\bproton ag\b/i, provider: 'Proton VPN', branded: true },
  { re: /express\s*vpn|expressvpn/i, provider: 'ExpressVPN', branded: true },
  { re: /mullvad/i, provider: 'Mullvad', branded: true },
  { re: /cyberghost/i, provider: 'CyberGhost', branded: true },
  { re: /private internet access|\bpia\b/i, provider: 'Private Internet Access', branded: true },
  { re: /windscribe/i, provider: 'Windscribe', branded: true },
  { re: /tunnelbear/i, provider: 'TunnelBear', branded: true },
  { re: /ipvanish/i, provider: 'IPVanish', branded: true },
  { re: /\bhide\.?me\b/i, provider: 'hide.me', branded: true },
  { re: /\bpurevpn\b/i, provider: 'PureVPN', branded: true },
  { re: /\bvyprvpn\b/i, provider: 'VyprVPN', branded: true },
  { re: /cloudflare|\bwarp\b/i, provider: 'Cloudflare WARP', branded: true },
  // Generic tunnels — prove a VPN is up but don't name the brand.
  { re: /wireguard|wg\d|\bwgtunnel\b/i, provider: null, branded: false },
  { re: /openvpn|tap-?windows|tap-?nord|\btun\d*\b|utun\d/i, provider: null, branded: false },
];

// ASNs / carriers commonly used as VPN/proxy exit hosting. A match means "this IP is on a hosting/VPN
// range" (so treat as VPN/proxy egress) even when no consumer brand is identifiable.
const HOSTING_ORG_RE =
  /\bm247\b|datacamp|packethub|clouvider|gthost|leaseweb|choopa|vultr|digitalocean|linode|ovh|hetzner|amazon|aws|google cloud|gcp|microsoft azure|\bnforex\b|hostroyale|servinga|xtom|zenlayer/i;

/** Match a name/org string against the provider signatures. Returns the first hit or null. */
export function matchProviderSig(text: string | null | undefined): { provider: string | null; branded: boolean } | null {
  if (!text) return null;
  for (const s of PROVIDER_SIGS) if (s.re.test(text)) return { provider: s.provider, branded: s.branded };
  return null;
}

/** Infer a VPN provider from the ISP/org string alone (used when the adapter name is generic). */
export function providerFromOrg(org: string | null | undefined): string | null {
  const hit = matchProviderSig(org);
  return hit?.branded ? hit.provider : null;
}

/**
 * Scan local network adapters for an active VPN tunnel. An adapter counts only when it has at least one
 * non-internal address (i.e. it is actually carrying traffic, not a disconnected virtual NIC).
 */
export function detectVpnAdapters(ifaces: Record<string, NetworkInterfaceInfo[] | undefined>): AdapterSignal {
  const adapterNames: string[] = [];
  let provider: string | null = null;
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs || addrs.length === 0) continue;
    const live = addrs.some((a) => !a.internal && !!a.address);
    if (!live) continue;
    const hit = matchProviderSig(name);
    if (!hit) continue;
    adapterNames.push(name);
    // Prefer a branded provider name over a generic-tunnel (null) match.
    if (hit.branded && !provider) provider = hit.provider;
  }
  return { active: adapterNames.length > 0, provider, adapterNames };
}

/** Optional privacy flags from a geo provider that returns them (most keyless ones don't). */
export interface GeoFlags { vpn?: boolean; proxy?: boolean; tor?: boolean; hosting?: boolean }

/**
 * Combine the adapter signal, the IP's org/asn, and any geo privacy flags into a connection verdict.
 * Precedence: a branded adapter (offline, unforgeable) wins; then a branded org; then privacy flags or a
 * hosting-range org (VPN/proxy but brand unknown); otherwise local.
 */
export function classifyConnection(input: {
  adapter: AdapterSignal;
  org: string | null;
  asn: string | null;
  flags?: GeoFlags;
}): { connectionType: NetworkConnectionType; provider: string | null; confidence: NetworkLocationView['confidence']; detectedVia: string[] } {
  const { adapter, org, flags } = input;
  const detectedVia: string[] = [];
  const orgProvider = providerFromOrg(org);

  // 1) A live VPN adapter is the strongest signal.
  if (adapter.active) {
    const provider = adapter.provider ?? orgProvider ?? null;
    detectedVia.push(`network adapter${adapter.adapterNames.length ? `: ${adapter.adapterNames.join(', ')}` : ''}`);
    if (!adapter.provider && orgProvider) detectedVia.push(`IP org: ${org}`);
    return { connectionType: 'vpn', provider, confidence: adapter.provider ? 'high' : orgProvider ? 'high' : 'medium', detectedVia };
  }

  // 2) A branded VPN org on the public IP (no local tunnel adapter — e.g. system-level app VPN).
  if (orgProvider) {
    detectedVia.push(`IP organization: ${org}`);
    return { connectionType: 'vpn', provider: orgProvider, confidence: 'medium', detectedVia };
  }

  // 3) Explicit privacy flags from the geo service.
  if (flags?.vpn) { detectedVia.push('geo service flag: vpn'); return { connectionType: 'vpn', provider: null, confidence: 'medium', detectedVia }; }
  if (flags?.proxy) { detectedVia.push('geo service flag: proxy'); return { connectionType: 'proxy', provider: null, confidence: 'medium', detectedVia }; }

  // 4) A hosting/datacenter range — consumer traffic normally comes from a residential ISP, so a hosting
  //    org usually means a VPN/proxy exit even when the brand isn't identifiable.
  if (org && HOSTING_ORG_RE.test(org)) {
    detectedVia.push(`IP organization (hosting/VPN range): ${org}`);
    return { connectionType: 'vpn', provider: null, confidence: 'low', detectedVia };
  }

  // 5) Otherwise it's a normal local/ISP connection.
  if (org) detectedVia.push(`IP organization: ${org}`);
  return { connectionType: 'local', provider: null, confidence: 'none', detectedVia };
}

// ── Geo providers (keyless, HTTPS) ────────────────────────────────────────────────────────────────
type FetchImpl = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const asStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Normalize each provider's JSON into a common GeoInfo. Unknown fields degrade to null, never throw. */
export function normalizeGeo(provider: 'ipwho' | 'ipapi' | 'ifconfig', body: unknown): GeoInfo | null {
  if (!isObj(body)) return null;
  if (provider === 'ipwho') {
    // ipwho.is: { success, ip, country, country_code, region, city, connection: { asn, org, isp } }
    if (body.success === false) return null;
    const conn = isObj(body.connection) ? body.connection : {};
    const asnNum = asNum(conn.asn);
    return {
      ip: asStr(body.ip),
      country: asStr(body.country),
      countryCode: asStr(body.country_code),
      region: asStr(body.region),
      city: asStr(body.city),
      org: asStr(conn.org) ?? asStr(conn.isp),
      asn: asnNum !== null ? `AS${asnNum}` : asStr(conn.asn),
    };
  }
  if (provider === 'ipapi') {
    // ipapi.co: { ip, city, region, country_name, country_code, org, asn }
    if (typeof body.error !== 'undefined' && body.error) return null;
    return {
      ip: asStr(body.ip),
      country: asStr(body.country_name),
      countryCode: asStr(body.country_code),
      region: asStr(body.region),
      city: asStr(body.city),
      org: asStr(body.org),
      asn: asStr(body.asn),
    };
  }
  // ifconfig.co: { ip, country, city, region_name, asn_org, asn }
  return {
    ip: asStr(body.ip),
    country: asStr(body.country),
    countryCode: asStr(body.country_iso),
    region: asStr(body.region_name),
    city: asStr(body.city),
    org: asStr(body.asn_org),
    asn: asStr(body.asn),
  };
}

const PROVIDERS: { key: 'ipwho' | 'ipapi' | 'ifconfig'; url: string }[] = [
  { key: 'ipwho', url: 'https://ipwho.is/' },
  { key: 'ipapi', url: 'https://ipapi.co/json/' },
  { key: 'ifconfig', url: 'https://ifconfig.co/json' },
];

/** Try each keyless geo provider until one returns a usable IP. Returns null only if all fail (offline). */
export async function fetchGeo(fetchImpl: FetchImpl, timeoutMs = 7000): Promise<GeoInfo | null> {
  for (const p of PROVIDERS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      let geo: GeoInfo | null = null;
      try {
        const res = await fetchImpl(p.url, { signal: ctrl.signal });
        if (res.ok) geo = normalizeGeo(p.key, await res.json());
      } finally {
        clearTimeout(t);
      }
      if (geo?.ip) return geo;
    } catch {
      // Try the next provider.
    }
  }
  return null;
}

// ── Public API + cache ────────────────────────────────────────────────────────────────────────────
let cache: NetworkLocationView | null = null;

const globalFetch: FetchImpl = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchImpl>;

/**
 * Resolve the current network location. Cached for `ttlMs`; pass `force` (the Refresh button, or a run
 * start after a VPN switch) to bypass the cache and re-check. `deps` are injectable for tests.
 */
export async function getNetworkLocation(opts: { force?: boolean; ttlMs?: number } = {}, deps: {
  fetchImpl?: FetchImpl;
  ifaces?: () => Record<string, NetworkInterfaceInfo[] | undefined>;
  now?: () => number;
} = {}): Promise<NetworkLocationView> {
  const now = deps.now ?? Date.now;
  const ttl = opts.ttlMs ?? 60_000;
  if (!opts.force && cache && now() - cache.checkedAt < ttl) return cache;

  const ifaces = (deps.ifaces ?? networkInterfaces)();
  const adapter = detectVpnAdapters(ifaces);
  const geo = await fetchGeo(deps.fetchImpl ?? globalFetch);

  if (!geo) {
    // No provider reachable. If a VPN adapter is up we can still report the connection type honestly;
    // otherwise we simply couldn't reach the network.
    const view: NetworkLocationView = {
      ip: null, country: null, countryCode: null, region: null, city: null, org: null, asn: null,
      connectionType: adapter.active ? 'vpn' : 'unknown',
      provider: adapter.provider,
      confidence: adapter.active ? (adapter.provider ? 'high' : 'low') : 'none',
      detectedVia: adapter.active ? [`network adapter: ${adapter.adapterNames.join(', ')}`] : [],
      status: 'offline',
      detail: 'Could not reach a geolocation service. Check your internet connection or VPN.',
      checkedAt: now(),
    };
    cache = view;
    return view;
  }

  const verdict = classifyConnection({ adapter, org: geo.org, asn: geo.asn });
  const view: NetworkLocationView = {
    ip: geo.ip,
    country: geo.country,
    countryCode: geo.countryCode,
    region: geo.region,
    city: geo.city,
    org: geo.org,
    asn: geo.asn,
    connectionType: verdict.connectionType,
    provider: verdict.provider,
    confidence: verdict.confidence,
    detectedVia: verdict.detectedVia,
    status: 'connected',
    detail: null,
    checkedAt: now(),
  };
  cache = view;
  return view;
}

/** The last resolved location without triggering a check (null if never checked). For run-start stamping. */
export function peekNetworkLocation(): NetworkLocationView | null {
  return cache;
}

/** Test-only: clear the module cache between cases. */
export function __resetNetworkCache(): void {
  cache = null;
}
