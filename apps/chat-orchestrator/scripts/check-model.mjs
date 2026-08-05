#!/usr/bin/env node
/**
 * Lists the model ids the configured OpenAI key can actually use.
 *
 * Model ids move faster than documentation, so this answers "what should OPENAI_MODEL be" from the
 * account itself rather than from a guess.
 */
import 'dotenv/config';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const base = process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';

const res = await fetch(`${base}/models`, {
  headers: { Authorization: `Bearer ${apiKey}` },
});

if (!res.ok) {
  console.error(`Failed to list models: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const { data } = await res.json();
const ids = data.map((m) => m.id).sort();

const chat = ids.filter((id) => /^(gpt|o[0-9])/.test(id) && !/(embedding|audio|image|tts|whisper|moderation|realtime)/.test(id));
const embeddings = ids.filter((id) => id.includes('embedding'));

console.log(`\nChat-capable models available to this key (${chat.length}):`);
for (const id of chat) console.log(`  ${id}`);

console.log(`\nEmbedding models (${embeddings.length}):`);
for (const id of embeddings) console.log(`  ${id}`);

const configured = process.env.OPENAI_MODEL?.trim() || 'gpt-5.4';
console.log(
  ids.includes(configured)
    ? `\nOPENAI_MODEL="${configured}" is available.`
    : `\nWARNING: OPENAI_MODEL="${configured}" is NOT in this key's model list. Set it to one of the ids above.`,
);
