# GTM and GA4 Chat: Implementation Plan

| | |
|---|---|
| **Status** | Phase 1 shipped and live. Phases 2-6 planned. |
| **Live at** | `aitagmanager.com/ai-chat`, backed by `chat.aitagmanager.com` |
| **Date** | 6 August 2026 |
| **Supersedes** | The roadmap in `AITAGMANAGER_MCP_INTEGRATION_FEASIBILITY.md` Section 14, which was written before implementation. This document records what was actually built and what the build taught us. |

---

## 1. What is live today

A user signs in at aitagmanager.com, opens **AI Chat**, and asks a question about their own GTM container or GA4 property. The assistant reads their live configuration through MCP tools, streams its answer, and shows every lookup it performed as a chip. It cannot change anything.

Verified working against real data, in production.

### The path a message takes

```
browser (aitagmanager.com, Vercel)
   │  HTTPS + Supabase access token, SSE response
   ▼
chat.aitagmanager.com  ──  Cloudflare named tunnel, 4 HA connections
   ▼
chat orchestrator  (Node, port 8787)
   ├─ verifies the Supabase session
   ├─ fetches that user's Google token from secure-token-manager
   ├─ acquires an MCP child process bound to that one user
   ├─ calls OpenAI with a scoped tool list
   └─ streams tokens, tool calls, and results back
        ▼
   MCP child (per user)  ──  GTM API v2 + GA4 Admin/Data APIs
```

### Concrete numbers

| | |
|---|---|
| Tools registered by the MCP | 178 (53 read, 125 confirm-gated writes) |
| Visible to the model, GTM | 40 read tools, ~5.5k tokens of schema |
| Visible to the model, GA4 | 13 read tools plus 3 shared discovery tools |
| Model | `gpt-4o` |
| Prompt cache hit, second call of a turn | ~98% |
| Cost per turn | roughly ₹4 |
| Write tools visible | none |

### What the GA4 side can actually answer today

`ga4_account_summaries_list`, `ga4_properties_list`, `ga4_property_get`, `ga4_data_streams_list`, `ga4_enhanced_measurement_get`, `ga4_custom_dimensions_list`, `ga4_custom_metrics_list`, `ga4_data_retention_get`, `ga4_key_events_list`, `ga4_google_ads_links_list`, `ga4_run_report`, `ga4_run_realtime_report`, `ga4_check_compatibility`.

So: configuration questions ("which key events exist", "is enhanced measurement on", "what custom dimensions do I have") and reporting questions ("sessions by channel for the last 28 days"). It cannot yet create or modify GA4 configuration.

### Safety posture

Two independent layers, both default-off:

1. **The orchestrator withholds write tools from the model.** It never sees them, so it cannot attempt one.
2. **The MCP refuses them at call time** via `GTM_MCP_ENABLE_WRITES`, `_PUBLISH`, `_DELETES`, `GA4_MCP_ENABLE_WRITES`, `_DELETES`, all false.

A third gate exists underneath: every MCP write tool requires an explicit `confirm=true` argument regardless of flags.

---

## 2. Architecture, and why each piece is shaped that way

### Why a separate orchestrator exists

Three independent constraints, each sufficient on its own:

- The MCP HTTP transport **sets no CORS headers**, so a browser cannot call it.
- MCP sessions are **stateful, held in process memory**, one server instance per session. A stateless function host has nowhere to keep that.
- An agentic turn is a loop of model call, tool call, model call, running 30 to 90 seconds with a stream held open. That is the opposite of the serverless execution model.

### Why one MCP process per user

The MCP resolves Google credentials from its own environment, and its request-scoped identity falls back to process-global credentials when none is present. On a shared process that fallback is a cross-tenant read waiting to happen.

Giving each user their own child removes the failure mode rather than guarding against it: the process running user A's tool call holds only A's access token, and every ambient credential is stripped from its environment (`buildChildEnv` in `mcp-client.ts`, asserted by `identity.test.ts`).

Cost: roughly 150-300 MB per active user. Mitigated by pooling, 15-minute idle eviction, and a hard cap.

### Why tool scoping is not optional

Advertising all 178 tools would cost roughly 25k tokens of schema on **every** request. Filtering by product and read/write brings that to 5.5k for GTM and 2.8k for GA4. At a 4x cost-plus model that is a margin line, not a nicety.

Read versus write is derived from the presence of a `confirm` argument in the tool's own schema, so there is no name list to drift as tools are added.

### Why the prompt is ordered the way it is

Static content first (role, methodology, tool schemas), volatile content last (date, signed-in user, selected container). This keeps the prefix byte-identical across turns so OpenAI's prompt cache actually hits. Measured 98% cached input on the second call of a turn. Reordering these silently costs most of the discount.

### Authentication, and a live-system surprise

The orchestrator verifies the Supabase access token before anything else. Identity comes only from verified claims, never the request body.

The project turned out to publish an **empty JWKS**: it signs sessions with the legacy shared secret (HS256), not asymmetric keys. Local verification would require holding the project's JWT secret, which can mint tokens as well as check them. So an HS256 token is verified by asking Supabase's `/auth/v1/user`, which is authoritative, needs only the public anon key, and is what the platform's own Edge Functions already do. Cached 60 seconds, bounded by the token's own expiry.

An asymmetric token also falls back when no keys are published, so a future migration to signing keys needs no change.

### Google identity, and a gap in the platform

Each user's Google token comes from the platform's `secure-token-manager`, called with that user's own JWT so the platform authorizes the decrypt against them and nobody else.

That function exposes `store | retrieve | delete | get_token | check_permission` and **has no refresh action**, so the orchestrator performs the Google refresh exchange itself using the website's OAuth client. The refresh token exists in the process only for that exchange: never logged, never persisted, never passed into a child.

A cleaner long-term shape is to add a `refresh` action to `secure-token-manager` so the refresh token never leaves the platform. One function change, and the orchestrator drops its exchange.

### Hosting

`chat.aitagmanager.com` is a Cloudflare **named** tunnel with four HA connections to Mumbai edges. This required moving `aitagmanager.com` DNS from Vercel to Cloudflare, because a tunnel target resolves to a private `fd10::` address that only Cloudflare's edge can route.

The tunnel terminates at a process on a developer laptop. That is the single largest gap and Phase 2 addresses it.
---

## 3. What the build taught us

Five bugs surfaced only by running the thing against live systems. Each would have reached production, and none was findable by reading code. They are recorded because they shape the phases that follow.

| # | Bug | Why it was invisible | Fixed in |
|---|---|---|---|
| 1 | The compiled build crashed at startup: `apps/desktop` has no `"type": "module"`, so the shared GTM methodology emitted as CommonJS inside an ESM package | `tsx` transpiles per file in dev and never hits it | PR #825, plus `build.test.ts` guarding four properties a typecheck cannot see |
| 2 | Empty `.env` values shadowed real ones. dotenv treats a key present with an empty value as already set, so a blank `GOOGLE_OAUTH_CLIENT_ID` copied from the example blocked the real one | Sign-in succeeded, token file existed, and the MCP still reported "No explicit credentials found" | PR #825 |
| 3 | Supabase publishes an **empty JWKS**, so every authenticated request would have 401'd | Startup and `/health` both look perfect | PR #833 |
| 4 | **The `dist/` build was three weeks stale**, missing `tokenSource.js` entirely, so the MCP ignored per-user tokens and silently used the developer's own Google account | Behaved identically to a correct build until per-user identity mattered | Rebuild; `npm run build` is now a required deploy step |
| 5 | An auth failure in single-identity mode attempted a refresh that cannot exist there, replacing the MCP's actionable error with a confusing one | Only visible in a mode not used in production | PR #825 |

**The lesson that shapes everything below:** the orchestrator had no server-side logging at all, and bugs 3, 4, and 5 each cost a full debugging round because the only signal was the model's paraphrase of an error. PR #837 added `[req]`, `[tool]`, and `[identity]` lines with secret redaction. Every phase below assumes that observability exists and extends it.

**Bug 4 deserves special emphasis.** A stale build meant every user's chat ran as one shared Google account while appearing to work. That is a cross-tenant data leak that no test caught, because the code was correct and the artifact was not. Any deploy procedure that does not rebuild is unsafe.

---

## 4. Phases

Ordered by dependency, not ambition. Each phase leaves the product working and is independently shippable.

### Phase 2: Get off the laptop

**The problem.** The backend is an unsupervised process on a developer machine. A closed terminal, a sleep, or a reboot stops the chat for every user. The permanent hostname makes recovery trivial but does not prevent the outage.

**The work.** Provision a host. Deploy with the existing `Dockerfile` and `compose.yaml`. Run cloudflared as a service on the same box so the tunnel restarts with it, or expose nginx directly with certbot. Both paths are written in `deploy/DEPLOY.md`.

Two additions to that runbook, learned the hard way:

1. `npm run build` at the repo root is **mandatory** before starting. The orchestrator spawns `dist/index.js`, not TypeScript source.
2. The deploy must assert `tokens: env` in the startup log. `tokens: file` silently means every user shares one Google account.

**Sizing.** Roughly 150-300 MB per concurrently active user, held 15 minutes after their last message. A 4 GB / 2 vCPU box handles about 10 concurrent users. Keep `mem_limit` and `MCP_POOL_MAX_SESSIONS` in agreement or the OOM killer enforces the real limit and takes the container with it.

**Estimate.** 1 to 2 days once a host exists. **Exit:** the chat survives closing every terminal, and a reboot brings it back unattended.

---

### Phase 3: Conversation persistence

**The problem.** History lives in browser state. A refresh loses the thread. This is the most visible gap to a user and the first thing they will report.

**The work.** Three tables in the AI-plane Postgres, with row-level security, from the schema already written in `infra/database/0001_init.sql`:

```sql
conversations (id, org_id, user_id, title, product, container_ref, model, created_at, updated_at, archived)
messages      (id, conversation_id, role, content, tool_calls jsonb, tokens_in, tokens_out, created_at)
tool_events   (id, conversation_id, message_id, tool_name, args_redacted jsonb, result_ref,
               status, duration_ms, approval_state, created_at)
```

`tool_events` is built now rather than with the write path, because it is the audit trail and it is far easier to add before writes exist than to backfill after.

Arguments are stored **redacted** through the same `redact.ts` used for logs. Large tool results are stored by reference, not inline.

The UI gains a conversation list and resume. History replay reuses the existing bounded-history logic.

**Estimate.** 5 to 7 days. **Exit:** a refresh resumes the thread; every tool call in the last 30 days is reconstructable.

---

### Phase 4: Metering and per-plan caps

**The problem.** Every turn costs roughly ₹4 and nothing counts it. At the intended 4x markup, free-tier turns are pure loss, and entitlements are still enforced only in the browser.

**The work.** Append-only `usage_events` keyed by request id so a retry cannot double-charge. Per-plan turn caps enforced **server-side** in the orchestrator, not the client. A user-visible usage panel. Monthly reconciliation against OpenAI's own reporting, because unreconciled metering eventually becomes a customer dispute you cannot win.

A policy decision to make explicitly: **do not bill failed turns.** That makes a rising failure rate simultaneously a margin leak and a quality alarm on the same dashboard, which is the right incentive.

**Pricing note.** Bill per action, not per raw token. One question triggers 5 to 8 model calls, per-turn cost varies about 40x between a definitional question and a container audit, and per-token pricing turns every optimization into an equal revenue cut. Weighted credits (simple chat 1, tool-using turn 2-3, audit 10), each priced at 4x its own measured cost, keeps the margin and makes optimization pure profit.

**Estimate.** 5 to 7 days, plus the Stripe subscription state machine (currently a no-op) if plans are to be enforced for real. **Exit:** a free-tier user cannot exceed their cap; a weekly revenue-over-cost ratio is visible per plan.

---

### Phase 5: Writes, behind approval

**The problem.** The assistant can diagnose but not fix. This is the largest product gap and the highest-risk phase.

**The work.**

*Orchestrator:* when the model calls a write tool, do not execute. Emit `approval_required` with a human-readable summary and the parsed arguments, and park the turn. Resume only on an explicit decision, executing with `confirm=true`.

*Frontend:* an approval card rendering the parsed arguments in **editable** form. The existing "Apply Fix" seam in `GTMChatAssistantUI.tsx` is the right shape to model it on.

*Configuration:* enable `ORCHESTRATOR_ENABLE_WRITE_TOOLS` and `GTM_MCP_ENABLE_WRITES`. Keep `_PUBLISH` and `_DELETES` **off**.

**Four safeguards, deliberately redundant:**

1. The model can only propose; a human approves the actual parsed arguments.
2. Writes land in a **draft workspace**, never published, so every change is reversible.
3. The MCP requires `confirm=true` on every write regardless of flags.
4. Publishing and deleting stay disabled entirely.

**Prerequisite:** Phase 3. A write with no durable record of who requested it, what arguments were used, and who approved it is unacceptable, and an approval that spans a page refresh must survive.

**Sequencing within the phase.** Start with the narrowest useful surface: create a GA4 event tag, its trigger, and its variables. That is one workflow, it maps to the `create-tag` MCP prompt that already exists and is tested, and it exercises the whole approval path. Broaden only after it has been used in anger.

**Estimate.** 6 to 8 days for the approval flow, assuming Phase 3 is done. **Exit:** a tag is created only after explicit approval, is fully reconstructable from `tool_events`, and lands in a draft workspace.

---

### Phase 6: Depth and scale

Not urgent, and worth doing only once the basics are in production and real usage shows what people ask.

**Audits in chat.** Host `web-audit-mcp` and let the assistant launch a site or Consent Mode v2 audit as a queued job and read the findings back. The engines exist and are tested; this is hosting and job plumbing, not new logic.

**GA4 configuration writes.** The MCP has 68 GA4 Admin write tools behind flags. Same approval flow as Phase 5, wider surface.

**Retrieval.** The corpus pattern library (490 containers, k-anonymity floor) is built and unused by the web chat. Semantic search over the recipe library needs an embedding model, which the **current OpenAI key cannot access**: it has seven models and zero embedding models. That must be enabled on the project first.

**Scale hardening.** Rate limiting and approval state move to Redis (the current limiter is per-process, correct for one node and wrong for two). Session affinity for the orchestrator-to-MCP pairing. A second app node.

---

## 5. Sequencing and dependencies

```
Phase 2  Host          ──┬─→ Phase 3  Persistence ──┬─→ Phase 5  Writes
                         │                          │
                         └─→ Phase 4  Metering ─────┘
                                                    └─→ Phase 6  Depth and scale
```

Phase 2 gates everything: there is no point persisting conversations on a machine that sleeps. Phases 3 and 4 are independent of each other and can run in parallel. Phase 5 depends on both, because writes need an audit trail and metering makes them accountable.

**Total to a commercially sound product with writes: 4 to 6 weeks of focused work**, plus whatever the host provisioning takes.

---

## 6. Risks

| Risk | Why it is real here | Mitigation |
|---|---|---|
| A stale build silently reverts per-user identity | It already happened, and looked healthy for weeks | `npm run build` in the deploy path; assert `tokens: env` at startup; consider failing startup outright when the mode is `supabase` but the resolved source is `file` |
| Unbounded LLM cost | ~₹4/turn with no counter and no server-side cap | Phase 4, and do not open a free tier before it |
| An unwanted GTM change | The whole point of Phase 5 | Approval on parsed arguments, draft workspace, publish disabled, full audit trail |
| Single host failure | Phase 2 fixes the laptop, not redundancy | Accept for now; a second node is Phase 6 |
| OpenAI model access | The key has 7 models, no GPT-5 family, **no embeddings** | `gpt-4o` is the ceiling today; enable embeddings before planning retrieval work |
| Google API quota | Per OAuth client, shared across all users | Discovery read cache with stale-while-revalidate; per-tenant fairness; request an uplift before any marketing push |
| Prompt injection via container content | Tool results are untrusted input | Capability gating already does the heavy lifting: a read-only profile has no destructive tool to hijack. Revisit hard at Phase 5 |

---

## 7. Open items carried forward

Independent of the phases, and worth closing:

- **[#21](https://github.com/samarthanalytics-sj/gtm-ai-automator/pull/21)** removes the simulated MCP engines and their dead UI, 2,751 lines deleted. Ready.
- **[#22](https://github.com/samarthanalytics-sj/gtm-ai-automator/pull/22)** replaces the bare "Failed to fetch" with the address that failed. Ready.
- **The Cloud Run scanner** is still deployed unauthenticated, with no SSRF guard, and an `/inject` route that accepts a Google access token in the request body. Unrelated to chat, and the highest-severity item in either codebase.
- **`/phase4-testing`** is routed with no auth guard, so an unauthenticated visitor can run the test suite and write rows to `model_usage_logs`.
- **A `refresh` action on `secure-token-manager`** would let the refresh token stop leaving the platform.
- **Google OAuth scopes** are requested from five different places with five different scope sets, and the signup path omits `access_type=offline`, so those users have no refresh token at all.
