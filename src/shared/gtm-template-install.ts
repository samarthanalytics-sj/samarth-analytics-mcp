// Installing a GTM custom template that the Community Template Gallery does not carry.
//
// `templates.import_from_gallery` cannot install a template that was never listed (stape-io's Data
// Client, RTB House and Tapfiliate templates are all "Not listed" per their own READMEs). GTM does
// accept `templates.create` with the template's SOURCE in `templateData`, which is exactly what the
// GTM UI's "Import" button does with a downloaded .tpl. So the step that used to be four manual
// instructions is done here instead.
//
// This module is the ONLY place that fetches template code over the network, and it is deliberately
// narrow:
//
//   * ALLOWLIST ONLY. The URL is built from the registry in gtm-template-sources, never from caller
//     input, so this cannot be pointed at an arbitrary repository. An unknown owner/repo is refused
//     before any request is made.
//   * PINNED. The one URL fetched is template.tpl at the commit the registry records as reviewed
//     (`sourceSha`), never a branch, so an upstream push cannot change what gets installed. An entry
//     without a pin is refused before any request is made; there is no branch fallback.
//   * HASH-CHECKED. The SHA-256 of the downloaded RAW BYTES must equal the registry's `sha256`, the
//     hash of the reviewed file. A mismatch is refused before anything is written into a container.
//   * VERIFIED BEFORE USE. Only then is it decoded and checked to parse as a GTM template matching
//     the kind, the display name and the SERVER context the registry recorded, as a second line.
//   * HTTPS to raw.githubusercontent.com, the vendor's own repository, and nothing is executed here:
//     the file is handed to GTM, which runs custom templates in its own sandbox.
//
// Hashing uses Web Crypto (globalThis.crypto.subtle) rather than node:crypto so this file stays
// portable between the MCP server and the desktop main process. The fetch is injectable so the
// behaviour is testable without a network.

import {
  resolveTemplateSource,
  templatePin,
  verifyTemplateSource,
  type TemplateSource,
} from './gtm-template-sources.js';

/** The subset of `fetch` this needs, so a test can pass a stub. The body is read as RAW BYTES
 *  (`arrayBuffer`), because the pinned SHA-256 is over the file exactly as served; hashing a
 *  decoded-then-re-encoded string could hide a byte-level difference. */
export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

export interface FetchedTemplate {
  /** The .tpl source, ready to hand to templates.create as `templateData`. */
  templateData: string;
  /** Where it came from (the pinned commit's raw URL), for the caller to report. */
  url: string;
  /** The name to create it under: what the template calls itself. */
  name: string;
  source: TemplateSource;
  /** The reviewed commit the file was fetched from. */
  sourceSha: string;
  /** The SHA-256 of the downloaded bytes, verified equal to the registry pin. */
  sha256: string;
}

/** How long to wait for the template download before giving up. */
const FETCH_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s.`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Lowercase hex SHA-256 of raw bytes, via Web Crypto (`globalThis.crypto.subtle` in Node 19+,
 * Electron and browsers; node:crypto's webcrypto on Node 18). Throws when the runtime has neither:
 * a download that cannot be verified is never installed.
 */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  // Node 18 (still allowed by package.json engines) has no global Web Crypto without a flag; reach
  // node:crypto's webcrypto lazily there, so the import never runs where globalThis.crypto exists.
  const subtle = globalThis.crypto?.subtle ?? (await nodeWebCryptoSubtle());
  if (!subtle) {
    throw new Error(
      'Web Crypto is not available in this runtime, so the template download cannot be checked ' +
        'against its pinned SHA-256 and will not be installed. Use Node 18 or later.',
    );
  }
  // Copy a view into its own ArrayBuffer so exactly its bytes are hashed, not the whole backing buffer.
  const data: ArrayBuffer = bytes instanceof Uint8Array ? new Uint8Array(bytes).buffer : bytes;
  const digest = await subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

type Subtle = NonNullable<typeof globalThis.crypto>['subtle'];

async function nodeWebCryptoSubtle(): Promise<Subtle | undefined> {
  try {
    const nodeCrypto = await import('node:crypto');
    return nodeCrypto.webcrypto?.subtle as unknown as Subtle | undefined;
  } catch {
    return undefined;
  }
}

export type TemplateBytesVerdict =
  | { ok: true; templateData: string; sha256: string }
  | { ok: false; reason: string };

/**
 * Check downloaded template bytes BEFORE anything is uploaded, in this order:
 *   1. the SHA-256 of the RAW BYTES must equal `expectedSha256` (the reviewed file, byte for byte);
 *   2. only then are they decoded as UTF-8 and checked for identity against the registry entry for
 *      `owner`/`repository` (kind, displayName, SERVER context).
 * Returns the decoded source, or why it was refused. Fetches nothing and uploads nothing: the
 * installer always passes the registry's own pin as `expectedSha256`.
 */
export async function verifyTemplateBytes(
  bytes: ArrayBuffer | Uint8Array,
  expectedSha256: string,
  owner: string,
  repository: string,
): Promise<TemplateBytesVerdict> {
  const expected = (expectedSha256 ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return { ok: false, reason: 'there is no valid pinned SHA-256 to check the download against.' };
  }
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    return {
      ok: false,
      reason:
        `the download's SHA-256 is ${actual}, but the reviewed template.tpl is pinned at ${expected}. ` +
        'It is not the reviewed file, so it was not installed.',
    };
  }
  let templateData: string;
  try {
    templateData = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'the download is not valid UTF-8 text, so it is not a GTM template.' };
  }
  const verdict = verifyTemplateSource(templateData, owner, repository);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return { ok: true, templateData, sha256: actual };
}

/**
 * Download this template's source from the vendor repository the registry records, AT THE REVIEWED
 * COMMIT it is pinned to, and verify it byte for byte (SHA-256) and by identity before returning it.
 * Throws with a sentence the user can act on.
 *
 * Only templates in the registry with a pin can be fetched, so `owner`/`repository` are a lookup key
 * here, not a URL. Exactly one URL is requested; there is no branch fallback.
 */
export async function fetchVerifiedTemplateSource(
  owner: string,
  repository: string,
  fetchImpl?: FetchLike,
): Promise<FetchedTemplate> {
  const source = resolveTemplateSource(owner, repository);
  if (!source) {
    throw new Error(
      `${owner}/${repository} is not a known template source, so it will not be downloaded. ` +
        'Only templates listed in src/shared/gtm-template-sources.ts can be installed this way.',
    );
  }
  const pin = templatePin(owner, repository);
  if (!pin) {
    throw new Error(
      `${source.sourceRepo} has no reviewed pin (sourceSha and sha256) in src/shared/gtm-template-sources.ts, ` +
        'so it will not be downloaded. A source install only ever fetches a reviewed commit and checks its ' +
        'SHA-256; it never falls back to a branch.',
    );
  }

  const { url } = pin;
  const doFetch: FetchLike = fetchImpl ?? ((u) => fetch(u) as unknown as ReturnType<FetchLike>);
  let bytes: ArrayBuffer;
  try {
    const res = await withTimeout(doFetch(url), FETCH_TIMEOUT_MS, `Downloading ${url}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = await withTimeout(res.arrayBuffer(), FETCH_TIMEOUT_MS, `Reading ${url}`);
  } catch (e) {
    throw new Error(
      `Could not download the ${source.sourceRepo} template at reviewed commit ${pin.sourceSha}. Tried:\n` +
        `  ${url} -> ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const verdict = await verifyTemplateBytes(bytes, pin.sha256, owner, repository);
  if (!verdict.ok) {
    // A reachable file that is not the reviewed template is a hard stop: installing it anyway would
    // put unreviewed code into the container.
    throw new Error(
      `Refused to install ${source.sourceRepo}: ${verdict.reason} Downloaded from ${url}. ` +
        'Nothing was written to the container.',
    );
  }
  return {
    templateData: verdict.templateData,
    url,
    name: source.displayName,
    source,
    sourceSha: pin.sourceSha,
    sha256: verdict.sha256,
  };
}

/** Minimal shape of the GTM templates collection, satisfied by both surfaces' clients. */
export interface TemplateCreateApi {
  create: (params: { parent: string; requestBody: Record<string, unknown> }) => Promise<{ data: unknown }>;
}

export interface InstalledTemplate {
  template: Record<string, unknown>;
  /** Where the source came from (the pinned commit's raw URL), so the caller can say what it installed. */
  url: string;
  name: string;
  /** The reviewed commit and the verified SHA-256 of what was uploaded. */
  sourceSha: string;
  sha256: string;
}

/**
 * Install a not-in-the-gallery template into a workspace by uploading its source, the same thing the
 * GTM UI's Templates > Import does. The download is pinned and hash-checked before `create` is ever
 * called. The caller is responsible for the write guardrails.
 */
export async function installTemplateFromSource(
  api: TemplateCreateApi,
  parent: string,
  owner: string,
  repository: string,
  fetchImpl?: FetchLike,
): Promise<InstalledTemplate> {
  const fetched = await fetchVerifiedTemplateSource(owner, repository, fetchImpl);
  const res = await api.create({
    parent,
    requestBody: { name: fetched.name, templateData: fetched.templateData },
  });
  const template = (res?.data ?? {}) as Record<string, unknown>;
  return { template, url: fetched.url, name: fetched.name, sourceSha: fetched.sourceSha, sha256: fetched.sha256 };
}
