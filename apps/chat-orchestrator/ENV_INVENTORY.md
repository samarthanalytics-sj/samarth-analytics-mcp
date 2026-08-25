# Orchestrator environment: what each key is, and where to get it again

**No values here, and none should ever be added.** This file is the answer to "the laptop died,
how do I rebuild `.env`" — it is deliberately safe to commit, because every entry says *where the
secret lives*, not what it is.

The real `.env` is gitignored and exists in one place. A local backup is at
`C:\Users\admin\Documents\samarth-secrets-backup\` (same machine, so it survives a bad edit but
not a lost laptop). Anything genuinely off-machine should go in a password manager.

## Secrets: cannot be derived, must be recovered from their source

| Key | Where to get it again |
|---|---|
| `OPENAI_API_KEY` | platform.openai.com → API keys. Cannot be re-read after creation; mint a new one and delete the old. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Project Settings → API → `service_role`. Re-readable. **Bypasses RLS**; treat as root. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud Console → APIs & Services → Credentials, project `gtm-ai-agent-463411`. Not re-readable; use "Add secret" and remove the old one. |
| `ORCHESTRATOR_SLACK_WEBHOOK_URL` | Slack → the app's Incoming Webhooks page. Re-readable there. Optional: without it lifecycle events are recorded but never posted. Which events post is set on the website, not here. |

## Public or re-derivable: no recovery needed

| Key | Notes |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Public by design. Currently `678847533961-...` (project `gtm-ai-agent-463411`). Must match the Google provider configured in Supabase Auth **and** the `GOOGLE_CLIENT_ID` edge-function secret. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Public; both ship in the frontend bundle. |
| `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`, `SUPABASE_JWT_AUDIENCE`, `SUPABASE_FUNCTIONS_URL` | Derived from the project ref. |

## Behaviour flags: policy decisions, not secrets

These are the ones worth reviewing after any rebuild, because a wrong default here changes what
the assistant is allowed to do rather than whether it starts.

| Key | Meaning |
|---|---|
| `ORCHESTRATOR_ENABLE_WRITE_TOOLS` | Offers write tools at all. Without it the chat is read-only and no approval broker exists. |
| `ORCHESTRATOR_ENABLE_DELETE_TOOLS` | Offers deletes, which always require a typed confirmation. Requires the write flag. |
| `GTM_MCP_ENABLE_WRITES` / `_DELETES` / `_PUBLISH` | Forwarded to the MCP child, which refuses again at call time. Publishing is off and should stay off. |
| `GOOGLE_IDENTITY_MODE` | `supabase` = each user's own Google token. Any other value makes every user share one Google account. |
| `ALLOWED_ORIGINS` | CORS allowlist. A missing origin here is why a deployed frontend gets a CORS failure. |
| `ORCHESTRATOR_DEV_NO_AUTH` | Local only. Must never be true anywhere reachable. |
| `ORCHESTRATOR_NAME`, `ORCHESTRATOR_TIMEZONE` | How events and Slack messages name this process and which zone they write times in (default `Asia/Kolkata`, always named in the message). |

## Budgets and tuning

`MAX_TURN_MS`, `MAX_TOOL_CALLS_PER_TURN`, `MAX_TOOL_RESULT_CHARS`, `MAX_HISTORY_MESSAGES`,
`TURNS_PER_MINUTE_PER_USER`, `OPENAI_MODEL`, `OPENAI_LIGHT_MODEL`, `OPENAI_MAX_OUTPUT_TOKENS`,
`OPENAI_TIMEOUT_MS`, `MCP_POOL_MAX_SESSIONS`, `MCP_POOL_IDLE_TTL_MS`, `PORT`,
`ORCHESTRATOR_HOST`, `MCP_TRANSPORT`, `MCP_ARGS`, `GTM_MCP_TOKEN_FILE`.

All have working defaults in `src/config.ts`; a rebuilt `.env` can omit them entirely.

## After a rebuild

1. `npm run build && node scripts/supervise.mjs`
2. Check the boot banner: identity mode, tool counts, audit trail ON, chat memory ON.
3. Confirm no `WARNING` lines — particularly the cross-platform allowlist check, which fires when a
   tool name in `integrations.ts` matches nothing the server registered.
