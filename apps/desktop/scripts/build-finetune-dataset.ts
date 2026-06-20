/**
 * Build a fine-tuning dataset from a folder of GTM container exports.
 *
 *   npx tsx scripts/build-finetune-dataset.ts "C:/path/to/exports" out.jsonl
 *
 * For each GA4-event / Google-tag / Ads-conversion tag in the corpus, emits one
 * chat example: a natural-language request → the CORRECT GTM Tag JSON. The
 * answer is regenerated through our own builders (buildGa4EventTag, etc.), so
 * every target is guaranteed-correct (e.g. eventSettingsTable, not the broken
 * eventParameters shape) and free of the user's real measurement IDs / labels —
 * those are replaced with {{placeholders}}. Output is OpenAI chat-fine-tune
 * JSONL; the guide (docs/FINETUNING.md) covers converting it for Gemini.
 *
 * PRIVACY: the OUTPUT file contains derived training text. It is gitignored and
 * must NOT be committed — it's generated locally from your private exports.
 * To minimize leakage into the dataset you send to a provider, we keep only the
 * SCHEMA: GA4 event names and parameter NAMES (e.g. "purchase", "currency"), and
 * replace every parameter VALUE with a "{{value}}" placeholder and every id with
 * a "{{…}}" placeholder. Names still get an id/email scrub as a backstop. Even
 * so, a custom event/parameter NAME could carry business meaning — REVIEW the
 * .jsonl before sending it to any provider.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGa4EventTag, buildGoogleTag, buildGoogleAdsConversionTag } from '../src/main/google/gtm-builders';

const dir = process.argv[2];
const outPath = process.argv[3] ?? 'gtm-finetune.jsonl';
if (!dir) {
  console.error('Usage: tsx scripts/build-finetune-dataset.ts <exports-folder> [out.jsonl]');
  process.exit(2);
}

const SYSTEM =
  'You are a Google Tag Manager expert. Given a request, output ONLY the correct GTM API v2 Tag ' +
  'resource JSON (name, type, parameter[]). Use the exact type codes and parameter keys GTM expects.';

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const param = (tag: any, key: string): string => {
  const p = arr(tag.parameter).find((x) => x.key === key);
  return p ? String(p.value ?? '') : '';
};
// Redact anything that could carry the customer's real data; keep structure.
const redact = (v: string): string =>
  v
    .replace(/\bG-[A-Z0-9]{6,}\b/g, 'G-XXXXXXX')
    .replace(/\bAW-[A-Z0-9-]{6,}\b/g, 'AW-XXXXXXXXX')
    .replace(/\bGT-[A-Z0-9]{4,}\b/g, 'GT-XXXXXX')
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, 'user@example.com')
    .replace(/\b\d{7,}\b/g, '0000000');

// Event params live in eventSettingsTable as maps keyed parameter/parameterValue.
// Keep only the parameter NAME (GA4 schema, id-scrubbed); replace the VALUE with a
// placeholder — the shape is what we're teaching, and values carry the PII risk
// (variable names like {{Customer Email}}, literal URLs, etc.).
function eventParamsOf(tag: any): Array<{ name: string; value: string }> {
  const est = arr(tag.parameter).find((p) => p.key === 'eventSettingsTable');
  return arr(est?.list)
    .map((item) => {
      const name = arr(item.map).find((x) => x.key === 'parameter')?.value;
      return name ? { name: redact(String(name)), value: '{{value}}' } : null;
    })
    .filter((x): x is { name: string; value: string } => x !== null)
    .slice(0, 8);
}

const examples: string[] = [];
const counts: Record<string, number> = { gaawe: 0, googtag: 0, awct: 0 };
const pick = <T,>(xs: T[], i: number): T => xs[i % xs.length];

function emit(user: string, tag: unknown): void {
  examples.push(
    JSON.stringify({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
        { role: 'assistant', content: JSON.stringify(tag) },
      ],
    })
  );
}

let i = 0;
for (const f of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'))) {
  let j: any;
  try {
    j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  } catch {
    continue;
  }
  for (const t of arr(j.containerVersion?.tag)) {
    i++;
    if (t.type === 'gaawe') {
      const eventName = redact(param(t, 'eventName'));
      if (!eventName) continue;
      const eventParameters = eventParamsOf(t);
      const tag = buildGa4EventTag({ name: `GA4 - ${eventName}`, measurementId: '{{GA4 Measurement ID}}', eventName, eventParameters });
      const paramText = eventParameters.length ? ` capturing parameters ${eventParameters.map((p) => p.name).join(', ')}` : '';
      emit(
        pick(
          [
            `Create a GA4 event tag for the "${eventName}" event${paramText}, using the {{GA4 Measurement ID}} variable.`,
            `I need a GTM GA4 event tag that fires "${eventName}"${paramText}.`,
            `Build the GA4 event tag JSON for event ${eventName}${paramText}.`,
          ],
          i
        ),
        tag
      );
      counts.gaawe++;
    } else if (t.type === 'googtag') {
      const tag = buildGoogleTag({ name: 'Google tag', tagId: '{{Google Tag ID}}' });
      emit(pick([`Create the Google tag (gtag) that configures GA4 using the {{Google Tag ID}} variable.`, `Build a Google tag JSON with tag id {{Google Tag ID}}.`], i), tag);
      counts.googtag++;
    } else if (t.type === 'awct') {
      const tag = buildGoogleAdsConversionTag({ name: 'Google Ads conversion', conversionId: 'AW-XXXXXXXXX', conversionLabel: '{{Conversion Label}}' });
      emit(pick([`Create a Google Ads conversion tag with conversion id AW-XXXXXXXXX and label {{Conversion Label}}.`, `Build the Google Ads conversion tracking tag JSON.`], i), tag);
      counts.awct++;
    }
  }
}

writeFileSync(outPath, examples.join('\n') + (examples.length ? '\n' : ''), 'utf8');
console.log(`\nWrote ${examples.length} examples to ${outPath}`);
console.log('by type:', counts);
console.log('(answers regenerated through the builders — guaranteed-correct shapes; IDs/emails redacted)');
console.log('Do NOT commit the .jsonl — it is derived from your private exports.\n');
