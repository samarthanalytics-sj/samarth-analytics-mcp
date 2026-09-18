// Where a GTM custom template actually comes from, and how to install it.
//
// `templates.import_from_gallery(owner, repository)` only works for a template PUBLISHED in the
// Community Template Gallery under THOSE coordinates. Two things break that assumption, and both
// were breaking real installs:
//
//  1. NOT PUBLISHED AT ALL. Several templates ship on GitHub but were never listed in the gallery -
//     their own README says so ("GTM Gallery Status: Not listed"). `stape-io/data-client` is the one
//     users hit first, because the Data Tag -> Data Client enrichment pipeline needs it. Importing a
//     template that is not in the gallery can only fail, so the tool must not attempt it: it has to
//     say "this one is installed by hand" and give the steps.
//  2. PUBLISHED BY SOMEONE ELSE. stape-io holds FORKS of four server templates whose gallery entry
//     belongs to the upstream author (mbaersch, snowplow). Importing `stape-io/<fork>` fails; the
//     import has to name the publisher instead.
//
// A hand-installed template carries NO galleryReference, so matching installed templates by
// owner/repository alone never finds one - the tool would re-attempt the doomed import even after
// the user did exactly what it was told to do. `matchInstalledTemplate` therefore also reads the
// template's own ___INFO___ block, which is the one identifier a manual upload preserves.
//
// Every entry below is verified against that template's source and README, not inferred. PURE: no
// I/O, no GTM client - callers pass the templates they already listed.

/** What a template can be installed as. A CLIENT only exists in a SERVER container. */
export type TemplateKind = 'TAG' | 'CLIENT' | 'MACRO';

export interface TemplateInfo {
  kind: TemplateKind | null;
  displayName: string;
  /** e.g. ['SERVER'] or ['WEB']. */
  containerContexts: string[];
}

/** The `___INFO___` block a .tpl file opens with, as a JSON object. Returns null when the source
 *  has no readable INFO block (a native template has no templateData at all). PURE. */
export function parseTemplateInfo(templateData: string | null | undefined): TemplateInfo | null {
  const src = templateData ?? '';
  const marker = src.indexOf('___INFO___');
  if (marker < 0) return null;
  const open = src.indexOf('{', marker);
  if (open < 0) return null;
  // Brace-match rather than regex: the INFO block is JSON and nests.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return null;
  try {
    const parsed = JSON.parse(src.slice(open, end)) as {
      type?: unknown; displayName?: unknown; containerContexts?: unknown;
    };
    const rawKind = String(parsed.type ?? '').toUpperCase();
    const kind: TemplateKind | null =
      rawKind === 'TAG' || rawKind === 'CLIENT' || rawKind === 'MACRO' ? rawKind : null;
    return {
      kind,
      displayName: String(parsed.displayName ?? '').trim(),
      containerContexts: Array.isArray(parsed.containerContexts)
        ? parsed.containerContexts.map((c) => String(c).toUpperCase())
        : [],
    };
  } catch {
    return null;
  }
}

export interface TemplateSource {
  /** Coordinates `import_from_gallery` actually accepts. null = not in the gallery at all, so the
   *  only way in is a manual upload of the .tpl. */
  gallery: { owner: string; repository: string } | null;
  /** owner/repo on GitHub where the .tpl lives, for the manual install. */
  sourceRepo: string;
  /** The template's own ___INFO___ displayName: how a hand-installed copy identifies itself. */
  displayName: string;
  kind: TemplateKind;
  /** Why this entry exists, in the tool's own words. */
  note: string;
}

const listedElsewhere = (
  repo: string,
  publisher: string,
  displayName: string,
): TemplateSource => ({
  gallery: { owner: publisher, repository: repo },
  sourceRepo: `${publisher}/${repo}`,
  displayName,
  kind: 'TAG',
  note: `stape-io/${repo} is a FORK. The gallery entry belongs to ${publisher}, so the import must name ${publisher}/${repo}.`,
});

/** Keyed by the coordinates a caller spells, lowercased. Holds only the EXCEPTIONS: a template that
 *  imports cleanly under the coordinates our tools already pass needs no entry. */
export const TEMPLATE_SOURCES: Readonly<Record<string, TemplateSource>> = {
  // ── Not in the gallery: manual install only (verified in each repo's README) ──
  'stape-io/data-client': {
    gallery: null,
    sourceRepo: 'stape-io/data-client',
    displayName: 'Data Client',
    kind: 'CLIENT',
    note: 'Stape never listed the Data Client in the gallery, so import_from_gallery cannot install it. It is installed instead by uploading the vendor source, and an existing copy (however it got there) is reused.',
  },
  'stape-io/rtb-house-tag': {
    gallery: null,
    sourceRepo: 'stape-io/rtb-house-tag',
    displayName: 'RTB House Conversions API by Stape',
    kind: 'TAG',
    note: 'Not listed in the gallery (the repo README says so), so it is installed by uploading the vendor source; the RTB House tag then builds against it.',
  },
  'stape-io/tapfiliate-tag': {
    gallery: null,
    sourceRepo: 'stape-io/tapfiliate-tag',
    displayName: 'Tapfiliate',
    kind: 'TAG',
    note: 'Not listed in the gallery (the repo README says so), so it is installed by uploading the vendor source.',
  },

  // ── Listed, but under the UPSTREAM author: stape-io holds only a fork ──
  'stape-io/pirsch-tag-server': listedElsewhere('pirsch-tag-server', 'mbaersch', 'Pirsch Analytics'),
  'stape-io/plausible-analytics-tag-server': listedElsewhere('plausible-analytics-tag-server', 'mbaersch', 'Plausible Analytics'),
  'stape-io/umami-tag-server': listedElsewhere('umami-tag-server', 'mbaersch', 'Umami'),
  'stape-io/snowplow-gtm-server-side-tag': listedElsewhere('snowplow-gtm-server-side-tag', 'snowplow', 'Snowplow'),

  // The canonical coordinates resolve too, so a caller that already passes the publisher gets the
  // same displayName for matching a hand-installed copy.
  'mbaersch/pirsch-tag-server': listedElsewhere('pirsch-tag-server', 'mbaersch', 'Pirsch Analytics'),
  'mbaersch/plausible-analytics-tag-server': listedElsewhere('plausible-analytics-tag-server', 'mbaersch', 'Plausible Analytics'),
  'mbaersch/umami-tag-server': listedElsewhere('umami-tag-server', 'mbaersch', 'Umami'),
  'snowplow/snowplow-gtm-server-side-tag': listedElsewhere('snowplow-gtm-server-side-tag', 'snowplow', 'Snowplow'),
};

const key = (owner: string, repository: string): string =>
  `${(owner ?? '').trim().toLowerCase()}/${(repository ?? '').trim().toLowerCase()}`;

/** The verified facts for these coordinates, or null when they are unexceptional (import as given). PURE. */
export function resolveTemplateSource(owner: string, repository: string): TemplateSource | null {
  return TEMPLATE_SOURCES[key(owner, repository)] ?? null;
}

/** The coordinates to actually import with, or null when the template is not in the gallery and an
 *  import would be pointless. Unknown coordinates pass through unchanged. PURE. */
export function galleryCoordinatesFor(
  owner: string,
  repository: string,
): { owner: string; repository: string } | null {
  const src = resolveTemplateSource(owner, repository);
  if (!src) return { owner, repository };
  return src.gallery;
}

/** Interface of an installed custom template, as both surfaces already list them. */
export interface InstalledTemplateLike {
  galleryReference?: { owner?: string | null; repository?: string | null } | null;
  name?: string | null;
  templateData?: string | null;
}

/**
 * Find the already-installed template for these coordinates, INCLUDING one uploaded by hand.
 *
 * Order (most to least certain):
 *   1. its galleryReference names the requested coordinates;
 *   2. its galleryReference names the canonical publisher (the fork case);
 *   3. its own ___INFO___ displayName matches - the identity a manual upload keeps;
 *   4. its GTM name matches that displayName - the default a manual upload lands with.
 *
 * Steps 3 and 4 only run for a registered template, so an unknown repo is never matched by a guess. PURE.
 */
export function matchInstalledTemplate<T extends InstalledTemplateLike>(
  templates: readonly T[],
  owner: string,
  repository: string,
): T | undefined {
  const list = templates ?? [];
  const wantOwner = (owner ?? '').trim().toLowerCase();
  const wantRepo = (repository ?? '').trim().toLowerCase();
  const refMatches = (t: T, o: string, r: string): boolean => {
    const ref = t.galleryReference;
    return !!ref
      && (ref.owner ?? '').trim().toLowerCase() === o
      && (ref.repository ?? '').trim().toLowerCase() === r;
  };

  const byRef = list.find((t) => refMatches(t, wantOwner, wantRepo));
  if (byRef) return byRef;

  const src = resolveTemplateSource(owner, repository);
  if (!src) return undefined;

  if (src.gallery) {
    const canonical = list.find((t) =>
      refMatches(t, src.gallery!.owner.toLowerCase(), src.gallery!.repository.toLowerCase()));
    if (canonical) return canonical;
  }

  const want = src.displayName.trim().toLowerCase();
  if (!want) return undefined;
  const byInfo = list.find((t) => (parseTemplateInfo(t.templateData)?.displayName ?? '').trim().toLowerCase() === want);
  if (byInfo) return byInfo;
  return list.find((t) => (t.name ?? '').trim().toLowerCase() === want);
}

/** Raw URLs to try for this template's source file, in order. Only ever built from the REGISTRY, so
 *  a caller cannot point the installer at an arbitrary repository. Empty for an unknown template. PURE. */
export function templateSourceUrls(owner: string, repository: string): string[] {
  const src = resolveTemplateSource(owner, repository);
  if (!src) return [];
  // Branch fallback: most of these repos are on main, a few are still on master.
  return ['main', 'master'].map((b) => `https://raw.githubusercontent.com/${src.sourceRepo}/${b}/template.tpl`);
}

export type TemplateVerdict = { ok: true; info: TemplateInfo } | { ok: false; reason: string };

/**
 * Is this downloaded file really the template we asked for?
 *
 * Checked before anything is written into a container, because the installer fetches over the
 * network: the file has to parse as a GTM template, call itself the name the registry recorded, be
 * the right kind (a CLIENT is not a TAG), and declare the SERVER context these all target. A
 * mismatch means the upstream repo moved or the download is not what it claims, and the right
 * answer is to refuse rather than install it. PURE.
 */
export function verifyTemplateSource(
  templateData: string,
  owner: string,
  repository: string,
): TemplateVerdict {
  const src = resolveTemplateSource(owner, repository);
  if (!src) return { ok: false, reason: `${owner}/${repository} is not a known template source.` };
  const info = parseTemplateInfo(templateData);
  if (!info) return { ok: false, reason: 'the downloaded file has no readable ___INFO___ block, so it is not a GTM template.' };
  if (info.kind !== src.kind) {
    return { ok: false, reason: `expected a ${src.kind} template, but the download declares ${info.kind ?? 'no kind'}.` };
  }
  if (info.displayName.trim().toLowerCase() !== src.displayName.trim().toLowerCase()) {
    return { ok: false, reason: `expected the template to call itself "${src.displayName}", but it calls itself "${info.displayName}".` };
  }
  if (info.containerContexts.length > 0 && !info.containerContexts.includes('SERVER')) {
    return { ok: false, reason: `this template targets ${info.containerContexts.join('/')}, not a SERVER container.` };
  }
  return { ok: true, info };
}

/** The exact manual-install steps for a template that is not in the gallery. PURE. */
export function manualInstallSteps(owner: string, repository: string): string[] {
  const src = resolveTemplateSource(owner, repository);
  const repo = src?.sourceRepo ?? `${owner}/${repository}`;
  const what = src?.kind === 'CLIENT' ? 'Client' : 'Tag';
  return [
    `Download template.tpl from https://github.com/${repo} (the raw file at https://raw.githubusercontent.com/${repo}/main/template.tpl).`,
    `In the SERVER container open Templates > ${what} Templates > New.`,
    'Use the kebab menu > Import, pick the downloaded template.tpl, then Save.',
    'Re-run this step: it now finds the installed template and continues.',
  ];
}

/** One message that says why the install could not proceed and what to do, with the steps inline.
 *  `cause` carries the underlying API error when there was one. PURE. */
export function templateInstallError(owner: string, repository: string, cause?: string): string {
  const src = resolveTemplateSource(owner, repository);
  const head = src && !src.gallery
    ? `Could not install ${owner}/${repository}. It is NOT in the GTM Community Template Gallery, so it is installed by `
      + `uploading the source from ${src.sourceRepo}, and that did not succeed.${cause ? ` Cause: ${cause}` : ''}`
    : `Could not install the ${owner}/${repository} template.${cause ? ` GTM said: ${cause}` : ''}`;
  return [head, 'Install it by hand instead:', ...manualInstallSteps(owner, repository).map((s, i) => `  ${i + 1}. ${s}`)].join('\n');
}
