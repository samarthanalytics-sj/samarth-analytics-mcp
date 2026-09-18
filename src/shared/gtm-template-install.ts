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
//   * VERIFIED BEFORE USE. The download has to parse as a GTM template and match the kind, the
//     display name and the SERVER context the registry recorded. Anything else is refused rather
//     than written into the container.
//   * HTTPS to raw.githubusercontent.com, the vendor's own repository, and nothing is executed here:
//     the file is handed to GTM, which runs custom templates in its own sandbox.
//
// The fetch is injectable so the behaviour is testable without a network.

import {
  resolveTemplateSource,
  templateSourceUrls,
  verifyTemplateSource,
  type TemplateSource,
} from './gtm-template-sources.js';

/** The subset of `fetch` this needs, so a test can pass a stub. */
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface FetchedTemplate {
  /** The .tpl source, ready to hand to templates.create as `templateData`. */
  templateData: string;
  /** Where it came from, for the caller to report. */
  url: string;
  /** The name to create it under: what the template calls itself. */
  name: string;
  source: TemplateSource;
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
 * Download this template's source from the vendor repository the registry records, and verify it is
 * what it claims before returning it. Throws with a sentence the user can act on.
 *
 * Only templates in the registry can be fetched, so `owner`/`repository` are a lookup key here, not
 * a URL. Tries the repo's main branch, then master, because a few of these repos never renamed.
 */
export async function fetchVerifiedTemplateSource(
  owner: string,
  repository: string,
  fetchImpl?: FetchLike,
): Promise<FetchedTemplate> {
  const source = resolveTemplateSource(owner, repository);
  const urls = templateSourceUrls(owner, repository);
  if (!source || urls.length === 0) {
    throw new Error(
      `${owner}/${repository} is not a known template source, so it will not be downloaded. ` +
        'Only templates listed in src/shared/gtm-template-sources.ts can be installed this way.',
    );
  }

  const doFetch: FetchLike = fetchImpl ?? ((url) => fetch(url) as unknown as ReturnType<FetchLike>);
  const failures: string[] = [];
  for (const url of urls) {
    let body: string;
    try {
      const res = await withTimeout(doFetch(url), FETCH_TIMEOUT_MS, `Downloading ${url}`);
      if (!res.ok) { failures.push(`${url} -> HTTP ${res.status}`); continue; }
      body = await withTimeout(res.text(), FETCH_TIMEOUT_MS, `Reading ${url}`);
    } catch (e) {
      failures.push(`${url} -> ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const verdict = verifyTemplateSource(body, owner, repository);
    if (!verdict.ok) {
      // A reachable file that is not the template we expected is a hard stop, not a reason to try
      // the next branch: something upstream changed and installing it anyway would be a guess.
      throw new Error(
        `Refused to install ${source.sourceRepo}: ${verdict.reason} Downloaded from ${url}. ` +
          'Install it by hand if this is expected.',
      );
    }
    return { templateData: body, url, name: source.displayName, source };
  }

  throw new Error(
    `Could not download the ${source.sourceRepo} template. Tried:\n` +
      failures.map((f) => `  ${f}`).join('\n'),
  );
}

/** Minimal shape of the GTM templates collection, satisfied by both surfaces' clients. */
export interface TemplateCreateApi {
  create: (params: { parent: string; requestBody: Record<string, unknown> }) => Promise<{ data: unknown }>;
}

export interface InstalledTemplate {
  template: Record<string, unknown>;
  /** Where the source came from, so the caller can say what it installed. */
  url: string;
  name: string;
}

/**
 * Install a not-in-the-gallery template into a workspace by uploading its source, the same thing the
 * GTM UI's Templates > Import does. The caller is responsible for the write guardrails.
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
  return { template, url: fetched.url, name: fetched.name };
}
