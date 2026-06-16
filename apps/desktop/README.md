# Samarth Desktop

Local **multi-account** desktop app (Electron) that wraps the GTM / GA4 MCP
server. One PC, many Google accounts; per-account LLM model + API key; pick GTM
or GA4 and fetch data. Secrets live in the OS keychain (Windows DPAPI via
Electron `safeStorage`), not in the cloud. Google sign-in is a direct desktop
loopback OAuth per account — **no Stytch** (Stytch is only for the hosted
endpoint).

> Not for Vercel. This is a packaged desktop binary (Phase 6 → Windows
> installer via electron-builder).

## Architecture

```
Electron main (Node)                         Renderer (React)
  • account registry (SQLite)                  • account switcher
  • secret store (safeStorage)        IPC      • GTM / GA4 selector + views
  • Google loopback OAuth     ◄── contextBridge ─►• per-account LLM settings
  • embedded MCP server (../../src) via           • chat panel → MCP tools
    InMemoryTransport + runWithAuth(account)
  • multi-provider LLM gateway
```

The MCP server is **already multi-identity capable** (`src/auth/identityContext.ts`
`runWithAuth`/`resolveAuth` + per-auth client caches). The desktop app keeps a
`Map<accountId, OAuth2Client>` and runs each tool call inside
`runWithAuth(active, …)` — no server changes needed to switch accounts.

## Develop

```bash
cd apps/desktop
npm install           # downloads the Electron binary (~100 MB first time)
npm run dev           # electron-vite dev — boots the window with HMR
npm run typecheck     # node (main+preload) + web (renderer)
npm run build         # production bundle into ./out
```

From the repo root (convenience):

```bash
npm run desktop:install
npm run desktop:dev
npm run desktop:check
```

## Status

- **Phase 0 (done):** Electron shell, secure preload IPC bridge, minimal
  renderer proving renderer↔main messaging.
- Phases 1–6: account registry + secret store → per-account Google OAuth →
  embedded MCP dispatch → LLM gateway → full UI → installer.

## Guardrails

Inherits the repo's read-only-by-default posture (`GTM_MCP_ENABLE_*` stay
`false`). Never commit account data or secrets — `data/`, `*.db`, and tokens are
gitignored. `apps/desktop/` is non-shipping for the npm package, so commits use
`feat(desktop)` / `chore(desktop)`, never bare `feat:`.
