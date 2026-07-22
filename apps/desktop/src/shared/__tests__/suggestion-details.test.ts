// Pure tests for the suggestion "Details" panel content (evidence parsing + provider names).
// Run: tsx src/shared/__tests__/suggestion-details.test.ts
import { parseSuggestionEvidence, providerDisplayName, isProviderFormIdLabel } from '../suggestion-details';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' - ' + detail : ''}`); }
}

// ── providerDisplayName ─────────────────────────────────────────────────────────
check('hubspot → HubSpot Forms', providerDisplayName('hubspot') === 'HubSpot Forms');
check('contactform7 → Contact Form 7', providerDisplayName('contactform7') === 'Contact Form 7');
check('gravityforms → Gravity Forms', providerDisplayName('gravityforms') === 'Gravity Forms');
check('unknown → Standard HTML form', providerDisplayName('unknown') === 'Standard HTML form');
check('embed → Embedded form (iframe)', providerDisplayName('embed') === 'Embedded form (iframe)');
check('unmapped slug passes through', providerDisplayName('futureforms') === 'futureforms');
check('empty → Standard HTML form', providerDisplayName('') === 'Standard HTML form');

// ── the real HubSpot form-evidence shape (engine: suggest.ts formSuggestion) ────
const HS = 'form purpose=contact; provider=hubspot (class hsForm_ on the form); data-form-id=1a2b3c4d-1111-2222-3333-abcdefabcdef; fields: email, firstname, message; hidden at page load - typically opens in a modal/popup or tab (e.g. a "Book a demo" overlay)';
const hs = parseSuggestionEvidence(HS);
check('hs: five lines', hs.length === 5, String(hs.length));
check('hs: form type capitalized', hs[0]?.label === 'Form type' && hs[0]?.value === 'Contact');
check('hs: provider display name + detection evidence', hs[1]?.label === 'Provider' && hs[1]?.value === 'HubSpot Forms (detected via class hsForm_ on the form)');
check('hs: the GUID is a highlighted provider form id', hs[2]?.label === 'Provider form ID (data-form-id)' && hs[2]?.value === '1a2b3c4d-1111-2222-3333-abcdefabcdef');
check('hs: fields listed', hs[3]?.label === 'Fields' && hs[3]?.value === 'email, firstname, message');
check('hs: modal note kept as Visibility', hs[4]?.label === 'Visibility' && hs[4]?.value.includes('modal/popup'));

// ── a source with spaces splits on the LAST '=' (Gravity: "DOM id gform_2=2") ───
const gf = parseSuggestionEvidence('form purpose=contact; provider=gravityforms (gform_ id); DOM id gform_2=2');
check('gf: spaced source keeps its key', gf[2]?.label === 'Provider form ID (DOM id gform_2)' && gf[2]?.value === '2', JSON.stringify(gf[2]));

// ── plain HTML form scoped by DOM id ────────────────────────────────────────────
const plain = parseSuggestionEvidence('form purpose=newsletter; provider=unknown (no vendor markup); id=#newsletter-footer; fields: email');
check('plain: provider is Standard HTML form', plain[1]?.value.startsWith('Standard HTML form'));
check('plain: DOM id line', plain[2]?.label === 'Form DOM id' && plain[2]?.value === '#newsletter-footer');

// ── non-form evidence passes through as free text ───────────────────────────────
const cta = parseSuggestionEvidence('button text "Get a Free Audit" (intent: contact)');
check('cta: one free-text line', cta.length === 1 && cta[0]?.label === '' && cta[0]?.value.includes('Get a Free Audit'));
const dl = parseSuggestionEvidence('download link "Whitepaper" → https://x.com/wp.pdf');
check('download: arrow segment not split as key=value', dl[0]?.label === '' && dl[0]?.value.includes('→'));

// ── search-bar evidence ─────────────────────────────────────────────────────────
const sb = parseSuggestionEvidence('search bar; method=GET; query key="s"; provider=unknown');
check('search: method upper-cased', sb.some((l) => l.label === 'Method' && l.value === 'GET'));
check('search: query key extracted', sb.some((l) => l.label === 'Query key' && l.value === 's'));

// ── misc ────────────────────────────────────────────────────────────────────────
check('empty evidence → no lines', parseSuggestionEvidence('').length === 0 && parseSuggestionEvidence('  ').length === 0);
check('isProviderFormIdLabel: data-form-id / wpcf7 / formid hit', isProviderFormIdLabel('data-form-id') && isProviderFormIdLabel('data-wpcf7-id') && isProviderFormIdLabel('DOM id wpforms-form-12'));
check('isProviderFormIdLabel: ordinary labels miss', !isProviderFormIdLabel('Fields') && !isProviderFormIdLabel('Provider') && !isProviderFormIdLabel('Method'));

if (failures.length) console.error(failures.join('\n'));
console.log(`suggestion-details: ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
