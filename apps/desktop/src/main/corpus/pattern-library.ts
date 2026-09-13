// Loads the shipped GTM pattern library for the corpus-retrieval chat tool.
//
// The JSON is IMPORTED (not read from disk) so the bundler inlines it into the main bundle: the
// knowledge travels with the app and the tool works on any machine, including ones that have never
// seen the raw GTM exports it was mined from.
//
// Main-process only. `resolveJsonModule` is enabled for the node program alone, so nothing in the
// renderer program has to resolve this file.
import raw from '../../shared/corpus/gtm-pattern-library.json';
import type { PatternLibrary } from '../../shared/corpus-patterns';

let cached: PatternLibrary | null | undefined;

const isArr = (v: unknown): v is unknown[] => Array.isArray(v);

/**
 * The shipped library, or null when the artifact is missing/malformed (the tool then reports that it
 * has no corpus rather than inventing numbers). Validated once and cached.
 */
export function getPatternLibrary(): PatternLibrary | null {
  if (cached !== undefined) return cached;
  const lib = raw as unknown as Partial<PatternLibrary> | null;
  const ok =
    !!lib &&
    lib.version === 1 &&
    typeof lib.minedAt === 'string' &&
    typeof lib.containersScanned === 'number' &&
    lib.containersScanned > 0 &&
    typeof lib.minContainers === 'number' &&
    isArr(lib.tagPatterns) &&
    isArr(lib.triggerPatterns) &&
    isArr(lib.variablePatterns) &&
    isArr(lib.vendorStats);
  if (!ok) {
    console.error('[corpus] shipped pattern library is missing or malformed; lookup_corpus_patterns will report no corpus');
    cached = null;
    return cached;
  }
  cached = lib as PatternLibrary;
  return cached;
}

/** Test seam: drop the cached validation result. */
export function resetPatternLibraryCache(): void {
  cached = undefined;
}
