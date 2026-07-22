// Tests for the provider capability matrix. This table is shown to the user as fact, so the rule
// that matters is that it agrees with what the app ACTUALLY does: a cell claiming support the code
// does not have would be worse than showing nothing.
// Run: tsx src/shared/__tests__/provider-capabilities.test.ts
import {
  PROVIDER_PROFILES, CAPABILITY_IDS, providerProfile, providerLimitations, capabilityTableMatchesCode,
} from '../provider-capabilities';
import { supportsEmbeddings } from '../embeddings';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── The table must not out-claim the code ──────────────────────────────────────
check('the embeddings row agrees with supportsEmbeddings() for every provider', capabilityTableMatchesCode());
for (const p of PROVIDER_PROFILES) {
  const row = p.capabilities.find((c) => c.id === 'embeddings');
  check(`${p.provider}: embeddings cell matches the code`, (row?.level === 'yes') === supportsEmbeddings(p.provider),
    `table says ${row?.level}, code says ${supportsEmbeddings(p.provider)}`);
}

// ── Shape: every provider, every capability, every claim explained ─────────────
check('all three supported providers are covered',
  ['openai', 'anthropic', 'gemini'].every((p) => !!providerProfile(p)) && PROVIDER_PROFILES.length === 3);
check('an unsupported provider has no profile rather than a fabricated one', providerProfile('whatever') === undefined);
for (const p of PROVIDER_PROFILES) {
  check(`${p.provider}: covers every capability exactly once`,
    CAPABILITY_IDS.every((id) => p.capabilities.filter((c) => c.id === id).length === 1)
    && p.capabilities.length === CAPABILITY_IDS.length);
  check(`${p.provider}: every cell explains itself`, p.capabilities.every((c) => c.note.trim().length > 20));
  check(`${p.provider}: every cell has a label and a valid level`,
    p.capabilities.every((c) => !!c.label && ['yes', 'no', 'partial'].includes(c.level)));
  check(`${p.provider}: has a "best for" line`, p.bestFor.trim().length > 20);
}

// ── The specific facts this table exists to communicate ────────────────────────
check('images are readable on ALL providers (that is the point of the native media path)',
  PROVIDER_PROFILES.every((p) => p.capabilities.find((c) => c.id === 'images')?.level === 'yes'));
check('OpenAI is marked as NOT seeing PDF pages, which is the trap being documented',
  providerProfile('openai')?.capabilities.find((c) => c.id === 'pdfPages')?.level === 'no');
check('the OpenAI PDF note says only the WORDS are sent',
  /extracted WORDS/i.test(providerProfile('openai')?.capabilities.find((c) => c.id === 'pdfPages')?.note ?? ''));
check('the OpenAI scanned-PDF note tells the user what to do instead',
  /as images/i.test(providerProfile('openai')?.capabilities.find((c) => c.id === 'scannedPdf')?.note ?? ''));
check('Anthropic and Gemini are marked as seeing PDF pages',
  ['anthropic', 'gemini'].every((p) => providerProfile(p)?.capabilities.find((c) => c.id === 'pdfPages')?.level === 'yes'));

// ── Limitations: only real gaps, so a warning means something ──────────────────
check('anthropic reports exactly one gap (embeddings)', (() => {
  const gaps = providerLimitations('anthropic');
  return gaps.length === 1 && gaps[0].id === 'embeddings';
})(), JSON.stringify(providerLimitations('anthropic').map((g) => g.id)));
check('openai reports its two PDF gaps', (() => {
  const ids = providerLimitations('openai').map((g) => g.id).sort();
  return ids.join() === 'pdfPages,scannedPdf';
})());
check('gemini reports no gaps at all', providerLimitations('gemini').length === 0);
check('an unknown provider reports nothing rather than throwing', providerLimitations('nope').length === 0);

// ── House style ────────────────────────────────────────────────────────────────
check('no em dashes anywhere in the table (it renders straight into the UI)',
  !PROVIDER_PROFILES.some((p) => /[—–]/.test(p.bestFor + p.capabilities.map((c) => c.label + c.note).join())));
check('no vendor marketing language, only what this app does',
  !PROVIDER_PROFILES.some((p) => /\b(best-in-class|state of the art|most powerful|industry leading|cutting edge)\b/i.test(p.bestFor + p.capabilities.map((c) => c.note).join())));

console.log(`\nprovider-capabilities: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
