# Fine-tuning the assistant on your GTM corpus

This is the honest guide to fine-tuning the LLM behind Samarth Desktop's chat,
using your own GTM container exports. **Read the "should you?" section first —
for this use case, the answer is usually "not yet."**

## TL;DR

- **Claude / Anthropic: there is no user fine-tuning.** The Anthropic API has no
  fine-tuning endpoint. You customize Claude with prompting, tool definitions,
  and (for persistent behavior) skills/memory — not by training weights. So if
  you want a *fine-tuned* model in the desktop, it has to be an **OpenAI** or
  **Gemini** model.
- **Google Gemini offers open supervised tuning** — and as of mid-2026 it's the
  practical SFT path: **OpenAI is winding down self-serve fine-tuning**, so a new
  account (one that hasn't fine-tuned before) likely **can't create an OpenAI
  fine-tune** anymore (see the table). Both take a JSONL/JSON dataset and produce
  a custom model id you select in the app.
- **Generate the dataset** from your exports with
  `scripts/build-finetune-dataset.ts` (below). The answers are regenerated
  through this repo's builders, so they're guaranteed-correct GTM JSON, and your
  measurement IDs / labels are redacted to `{{placeholders}}`.
- **Measure first.** A frontier model + the corpus-driven audit (#36) and builder
  fixes (#37) already produce correct GTM JSON. Fine-tuning adds cost, lock-in,
  and a training/eval loop. Try the improved prompts/tools on your hardest cases
  before committing to a fine-tune.

---

## Should you fine-tune at all?

For a tool-using GTM/GA4 assistant, fine-tuning is **rarely the highest-leverage
lever**, because:

- The desktop already constrains output: the LLM fills simple fields and the
  **builders** emit the correct GTM JSON (`create_gtm_tracking_tag`). The shape
  the corpus proved models get wrong (`eventSettingsTable` vs `eventParameters`)
  is now produced by code, not the model — so there's little for a fine-tune to
  "learn" there.
- Frontier models follow good tool descriptions and few-shot examples well.
- Fine-tuning needs labeled input→output pairs (not raw exports), a held-out eval
  set, and ongoing maintenance as models change; it pins you to one provider's
  hosted custom model.

**Fine-tune when**, after trying the above, the model still mis-picks tags,
mangles parameters on *your* specific event taxonomy, or you want a smaller/cheaper
base model to match a larger one on this narrow task. Otherwise prefer:
1. Better tool descriptions + a handful of curated few-shot examples (cheap, no lock-in).
2. Retrieval over your corpus ("search my containers") if the need is recall, not behavior.

---

## Provider comparison

| | Claude (Anthropic) | OpenAI | Google Gemini |
|---|---|---|---|
| **User fine-tuning?** | **No** (no fine-tuning API) | **Winding down** — supervised (+ DPO/RFT), but new orgs blocked since **May 2026**; all orgs lose job creation by **Jan 2027** (inference on existing fine-tunes continues until the base model is deprecated) | **Yes** — supervised tuning ("tuned models"); the open SFT path |
| **Dataset format** | n/a | JSONL of `{"messages":[…]}` chat turns | JSON/JSONL of input→output pairs (Gemini API / AI Studio / Vertex) |
| **Result** | n/a | a `ft:…` model id | a tuned-model resource id |
| **Use it in the desktop** | n/a | put the `ft:…` id in Settings → model | put the tuned-model id in Settings → model |
| **Customize instead via** | prompting, tools, skills/memory, prompt caching | same, or fine-tune | same, or tune |

> Note: a narrow Claude fine-tuning offering has existed via **Amazon Bedrock**
> (Claude 3 Haiku, generally available for fine-tuning since late 2024), but
> that's a separate, hosting-specific path — not the first-party Anthropic API the
> desktop talks to. Treat "Claude = prompt/tools, not fine-tune" as the rule for
> this app.

---

## Step 1 — Build the dataset

```bash
cd apps/desktop
npx tsx scripts/build-finetune-dataset.ts "C:/path/to/GTM_Consolidated" "C:/somewhere/gtm-finetune.jsonl"
```

- One example per GA4-event / Google-tag / Ads-conversion tag: a natural-language
  request → the correct Tag JSON.
- **Answers come from this repo's builders**, so they carry the fixed
  `eventSettingsTable` / `googtag` shapes — you're training on *correct* targets,
  not whatever was in the raw export.
- **Privacy:** the generator keeps only the **schema** — GA4 event names and
  parameter names — and replaces every parameter **value** and every id with a
  `{{placeholder}}`; names also get an id/email scrub. A custom event/parameter
  name could still carry business meaning, so **review the `.jsonl`** before
  sending it anywhere. The output is **gitignored** and derives from your private
  exports — keep it local and write it **outside the repo** to be safe.

The script prints how many examples it wrote, by tag type.

### Split a held-out eval set
Don't fine-tune on 100% of the data. Hold out ~10–15% (by container, not by row,
so the same container's tags don't appear in both) to measure whether the
fine-tune actually beats the base model.

---

## Step 2 — Fine-tune (Gemini is the open path; OpenAI may be closed to you)

**Google Gemini** (recommended for new users): convert each JSONL line to
Gemini's input/output tuning shape (the chat `messages` map to a single
input→output pair) and create a tuned model via the Gemini API / Google AI Studio
/ Vertex AI; you get a tuned-model resource id.

**OpenAI** (only if your org already fine-tunes): the JSONL is already in OpenAI
chat format — upload it (`purpose: "fine-tune"`) and start a job against a
fine-tunable base, yielding a model id like `ft:…:your-org:…`. **Caveat:** OpenAI
is winding down self-serve fine-tuning — orgs that hadn't fine-tuned before lost
job creation in **May 2026**, and all orgs lose it by **Jan 2027**. If you've
never fine-tuned on OpenAI, this path is likely already unavailable — use Gemini.

(Exact endpoints/SDK calls change over time — follow each provider's current
fine-tuning docs. The desktop doesn't run the fine-tune; you do, with your own
provider account and key.)

---

## Step 3 — Use it in the desktop

The desktop's model field is free-text, so point it at your custom model:
**Settings → Language model** → enter the `ft:…` (OpenAI) or tuned-model id
(Gemini) for that provider. The app sends requests to your fine-tuned model with
the same tools and prompt.

---

## Step 4 — Evaluate honestly

Run the held-out set through **both** the base model and the fine-tune and compare:
- Did it pick the right tool/tag type?
- Is the produced GTM JSON valid (correct `type`, parameter keys, the
  `eventSettingsTable` shape)? Feed both through `auditContainer` / the builders
  to check.
- Cost and latency per request.

Keep the fine-tune only if it clearly wins. If the base model already nails these,
you've saved yourself a training pipeline — which is the most likely outcome here.
