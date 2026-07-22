// What each LLM provider can actually do IN THIS APP, so the choice is visible where it is made.
//
// These are not vendor marketing claims. Every row states what this codebase really does with that
// provider, which is why the differences are narrow and specific: a PDF reaches Anthropic as a
// document block and Gemini as inline data, so both see the PAGES, while OpenAI Chat Completions has
// no PDF slot and receives the extracted TEXT instead. That single difference decides whether a
// scanned report is readable at all, and until now the only way to learn it was to attach one and
// wonder why the model ignored the charts.
//
// The rules this file follows:
//
//   NO CLAIM WITHOUT A REASON. Every cell carries a plain-language note, so a "no" explains itself
//   instead of reading as an arbitrary limitation.
//
//   MATCH THE CODE, NOT THE DOCS. The embeddings row is cross-checked against supportsEmbeddings()
//   in the tests, so the table cannot drift into promising something the app does not do.
//
//   NO ACCOUNT-SPECIFIC CLAIMS. Rate limits and pricing depend on the user's own tier, so they are
//   described as "set by your account", never asserted as a fact about the provider.
import { supportsEmbeddings } from './embeddings';

export type CapabilityLevel = 'yes' | 'no' | 'partial';

export interface Capability {
  /** Stable id, so the renderer can key rows without matching on prose. */
  id: string;
  /** Row label. */
  label: string;
  level: CapabilityLevel;
  /** Why, in one line. Shown next to the mark. */
  note: string;
}

export interface ProviderProfile {
  provider: string;
  label: string;
  /** One line on when to pick this provider. */
  bestFor: string;
  capabilities: Capability[];
}

/** The capabilities that genuinely differ between providers in this app. */
export const CAPABILITY_IDS = ['images', 'pdfPages', 'scannedPdf', 'embeddings'] as const;

const IMAGES_YES: Capability = {
  id: 'images',
  label: 'Screenshots and images',
  level: 'yes',
  note: 'Attached images are sent as real pixels, so charts and screenshots are read, not guessed.',
};

export const PROVIDER_PROFILES: ProviderProfile[] = [
  {
    provider: 'anthropic',
    label: 'Anthropic (Claude)',
    bestFor: 'Reading documents. The only gap is semantic corpus search, which needs an embeddings API Anthropic does not publish.',
    capabilities: [
      IMAGES_YES,
      { id: 'pdfPages', label: 'PDF charts and figures', level: 'yes', note: 'A PDF is sent as a document, so the model sees the pages themselves.' },
      { id: 'scannedPdf', label: 'Scanned PDFs', level: 'yes', note: 'Readable, because the pages are seen rather than text-extracted.' },
      { id: 'embeddings', label: 'Semantic corpus search', level: 'no', note: 'Anthropic publishes no embeddings API, so corpus search stays on keyword matching.' },
    ],
  },
  {
    provider: 'openai',
    label: 'OpenAI (GPT)',
    bestFor: 'Everyday tag work and semantic corpus search. Attach picture-heavy PDFs elsewhere.',
    capabilities: [
      IMAGES_YES,
      { id: 'pdfPages', label: 'PDF charts and figures', level: 'no', note: 'Chat Completions has no PDF slot, so only the extracted WORDS are sent. Diagrams and screenshots inside the PDF are not seen.' },
      { id: 'scannedPdf', label: 'Scanned PDFs', level: 'no', note: 'A scan has no extractable text, so almost nothing reaches the model. Attach the pages as images instead.' },
      { id: 'embeddings', label: 'Semantic corpus search', level: 'yes', note: 'Supported, so corpus lookup can match on meaning as well as words.' },
    ],
  },
  {
    provider: 'gemini',
    label: 'Google (Gemini)',
    bestFor: 'The broadest coverage here: it reads document pages AND supports semantic corpus search.',
    capabilities: [
      IMAGES_YES,
      { id: 'pdfPages', label: 'PDF charts and figures', level: 'yes', note: 'A PDF is sent inline, so the model sees the pages themselves.' },
      { id: 'scannedPdf', label: 'Scanned PDFs', level: 'yes', note: 'Readable, because the pages are seen rather than text-extracted.' },
      { id: 'embeddings', label: 'Semantic corpus search', level: 'yes', note: 'Supported, so corpus lookup can match on meaning as well as words.' },
    ],
  },
];

/** The profile for a provider, or undefined for one this app does not support. */
export function providerProfile(provider: string): ProviderProfile | undefined {
  return PROVIDER_PROFILES.find((p) => p.provider === String(provider ?? ''));
}

/**
 * What this provider CANNOT do, for a short warning next to the active account.
 *
 * Only real gaps: an empty list means nothing here is worth interrupting the user about.
 */
export function providerLimitations(provider: string): Capability[] {
  return (providerProfile(provider)?.capabilities ?? []).filter((c) => c.level !== 'yes');
}

/** True when the table agrees with what the app actually does. Asserted in the tests. */
export function capabilityTableMatchesCode(): boolean {
  return PROVIDER_PROFILES.every((p) => {
    const row = p.capabilities.find((c) => c.id === 'embeddings');
    return !!row && (row.level === 'yes') === supportsEmbeddings(p.provider);
  });
}
