# Web client files

Reference implementation of the chat tab for the AI Tag Manager website. These files belong in the
`gtm-ai-automator` repo, not in this one, so they are kept here as a handover unit and excluded from
this project's typecheck (they import `@/` paths that only exist there).

## Where each file goes

| File here | Copy to, in `gtm-ai-automator` |
|---|---|
| `useMcpChat.ts` | `src/hooks/useMcpChat.ts` |
| `McpChatPanel.tsx` | `src/components/McpChatPanel.tsx` |

## Wiring it up

**1. Point the client at the orchestrator.** In `.env.local`:

```
VITE_ORCHESTRATOR_URL=http://127.0.0.1:8787
```

For production this becomes `https://chat.aitagmanager.com`.

**2. Add the route.** In `src/App.tsx`, next to the existing `/gtm-assistant` route:

```tsx
const McpChat = lazy(() => import('./pages/McpChat'));
// ...
<Route path="/ai-chat" element={<McpChat />} />
```

And a thin page wrapper at `src/pages/McpChat.tsx`, matching how `GTMChatAssistant.tsx` is written:

```tsx
import { AuthGuard } from '@/components/auth/AuthGuard';
import { Navigation } from '@/components/Navigation';
import { McpChatPanel } from '@/components/McpChatPanel';

export default function McpChat() {
  return (
    <AuthGuard requireAuth>
      <Navigation />
      <main className="container mx-auto px-4 py-6">
        <McpChatPanel />
      </main>
    </AuthGuard>
  );
}
```

**3. Allow the connection in the CSP.** `vercel.json` currently lists `https://api.openai.com` in
`connect-src`, which no code uses and should be removed. Replace it with the orchestrator origin:

```
connect-src 'self' https://YOUR_PROJECT.supabase.co wss://YOUR_PROJECT.supabase.co https://chat.aitagmanager.com ...
```

**4. Set `ALLOWED_ORIGINS` on the orchestrator** to the exact origins that will call it, including
`https://www.aitagmanager.com` if that host is served.

## How this differs from the existing chat

The existing `GTMChatAssistantUI.tsx` is a good shell and worth keeping for reference. This one
differs in three ways that matter:

- **It streams.** Tokens render as they arrive instead of a spinner until the whole answer lands.
- **It can actually look things up.** Tool calls run against the user's live container or property,
  so the assistant is answering from configuration rather than from a container name string.
- **It shows its work.** Every tool call renders as a chip with a success or failure state, so a
  claim about the container is visibly backed by a read that happened.

## Still to add

The panel is read-only on purpose. When the write path lands, two things get added here: an
`approval_required` SSE event handler, and an approval card that renders the parsed tool arguments
in an editable form before anything executes. The existing "Apply Fix" seam in
`GTMChatAssistantUI.tsx` is the right shape to model that on.
