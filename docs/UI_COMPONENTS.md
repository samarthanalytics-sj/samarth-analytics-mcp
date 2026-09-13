# Portal UI System — Shared State & Layout Components

Reusable, production-grade building blocks for the customer portal client
(`apps/portal/client/src`). These exist to remove the copy-pasted loading,
empty, error, not-connected and section-header markup that had drifted across
`audit`, `consent-v2`, `containers` and `server-side` pages.

All components live under `@/components/common` and are re-exported from its
barrel:

```ts
import {
  StateCard,
  EmptyRow,
  NotConnectedState,
  LoadingBlock,
  SkeletonGrid,
  ErrorState,
  ToolFailureList,
  SectionHeader,
  StatusBadge,
  ConsentStatePills,
} from "@/components/common";
```

They build on the existing shadcn/ui primitives (`Card`, `Button`,
`Skeleton`, `Badge`) and the project's Tailwind tone tokens. They do **not**
introduce new dependencies and are framework-light by design.

## Design principles

- **Composable, not configurable-to-death.** Each component covers one job and
  accepts `children` / slot props (`actions`, `right`) for the rest. Prefer
  composing two simple components over adding a flag.
- **Accessible by default.** Loading regions are `aria-busy` polite live
  regions with an off-screen label; error surfaces use `role="alert"`; empty
  states use `role="status"`; section titles render real `<h3>`s.
- **Tone system over ad-hoc colors.** A single `StatusTone` /`tone` vocabulary
  (`neutral | info | success | warning | danger | accent`) replaces scattered
  `bg-emerald-500/10 text-emerald-700 …` strings.
- **Responsive-safe.** Components ship sensible mobile-first defaults and never
  hard-code a desktop-only layout; sizing is overridable via `className`.

---

## `StateCard`

Centered, icon-led card for empty / not-connected / clean / error states.

| Prop          | Type                                                             | Notes                                              |
| ------------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| `icon`        | `ComponentType<{ className?: string }>`                          | Optional lucide icon, shown in a tinted circle.    |
| `title`       | `ReactNode`                                                      | Optional heading.                                  |
| `description` | `ReactNode`                                                      | Optional muted body copy.                          |
| `tone`        | `neutral \| primary \| warning \| success \| destructive`        | Drives icon-wrap and (for warning/destructive) card border. Default `neutral`. |
| `role`        | `status \| alert`                                                | `status` (polite) for empty/info, `alert` for errors. Default `status`. |
| `actions`     | `ReactNode`                                                      | Buttons rendered centered below the body.          |
| `children`    | `ReactNode`                                                      | Extra content (e.g. an admin notice).              |
| `className`   | `string`                                                         | Layout overrides (e.g. `mt-6`).                    |
| `testId`      | `string`                                                         | `data-testid` on the card.                         |

```tsx
// Clean / success state
<StateCard
  icon={CheckCircle2}
  tone="success"
  title="Clean audit. No issues detected."
/>

// Neutral "pick a workspace" prompt
<StateCard description="Choose an account, container, and workspace, then run the audit." />
```

## `EmptyRow`

Compact inline empty placeholder (single muted line in a small card) for gaps
inside a section, e.g. "No clients on this server container."

```tsx
<EmptyRow>No transformations on this server container.</EmptyRow>
```

## `NotConnectedState`

The "Connect Google Tag Manager" gate shown on every authenticated page before
OAuth completes. Wraps `StateCard` and handles the `oauth.configured === false`
admin-notice branch automatically.

| Prop           | Type         | Notes                                                  |
| -------------- | ------------ | ------------------------------------------------------ |
| `oauth`        | `OAuthState` | From `usePortal()`.                                    |
| `title`        | `string`     | Page-specific connect heading.                         |
| `description`  | `ReactNode`  | Page-specific explanation.                             |
| `connectLabel` | `string`     | Defaults to "Connect Google Tag Manager".              |
| `testId`       | `string`     | `data-testid` on the connect button.                   |

```tsx
if (!oauth.connected) {
  return (
    <>
      <PageHeader eyebrow="Audit" title="Audit workspace" />
      <PageBody>
        <NotConnectedState
          oauth={oauth}
          title="Connect Google Tag Manager to run a live audit"
          description="The audit reads tags, triggers, and variables. Nothing is modified."
          testId="button-audit-connect-google"
        />
      </PageBody>
    </>
  );
}
```

> Note: `containers.tsx` deliberately uses `StateCard` directly (not
> `NotConnectedState`) because it connects via a full-page `<a href="/api/oauth/start">`
> anchor rather than `portalApi.redirectToGoogleOAuth()`.

## `LoadingBlock` / `SkeletonGrid`

Loading placeholders that announce themselves to assistive tech.

`LoadingBlock` — a vertical stack of skeleton rows:

| Prop           | Type     | Default        |
| -------------- | -------- | -------------- |
| `rows`         | `number` | `3`            |
| `rowClassName` | `string` | `h-24 w-full`  |
| `className`    | `string` | —              |
| `label`        | `string` | `"Loading…"`   |

```tsx
{isLoading && <LoadingBlock rows={3} label="Running audit…" />}
```

`SkeletonGrid` — a responsive grid of skeleton cards (for card lists):

```tsx
<SkeletonGrid count={4} className="lg:hidden grid grid-cols-1 sm:grid-cols-2 gap-3" />
```

## `ErrorState` / `ToolFailureList`

`ErrorState` — destructive-bordered `role="alert"` card with optional
"Reconnect Google" button (defaults to `portalApi.redirectToGoogleOAuth()`):

```tsx
{auditError && (
  <ErrorState
    title="Audit failed"
    message={auditError.message}
    showReconnect={needsReconnect}
  />
)}
```

`ToolFailureList` — the amber "some reads failed — results may be incomplete"
banner. Renders nothing when `failures` is empty, so it can be used
unconditionally:

```tsx
<ToolFailureList
  title="Some reads failed — the audit may be incomplete:"
  failures={audit?.toolFailures ?? []}
/>
```

## `SectionHeader`

Consistent section heading: optional icon, uppercase muted `<h3>`, optional
count, optional `hint`, optional trailing `right` slot.

```tsx
<SectionHeader title="Coverage matrix" hint="What each domain needs to be covered." />
<SectionHeader title="Clients" icon={Boxes} count={clients.length} />
<SectionHeader
  title="Findings"
  right={<span className="text-xs text-muted-foreground">{n} issues</span>}
/>
```

## `StatusBadge` / `ConsentStatePills`

`StatusBadge` — tonal pill/chip replacing inline color strings:

| Prop    | Type                                                          | Default     |
| ------- | ------------------------------------------------------------- | ----------- |
| `tone`  | `neutral \| info \| success \| warning \| danger \| accent`   | `neutral`   |
| `pill`  | `boolean` (fully rounded vs chip)                             | `true`      |
| `icon`  | `ReactNode`                                                   | —           |

```tsx
<StatusBadge tone="success" pill={false}>Connected</StatusBadge>
```

`ConsentStatePills` — the denied/granted/partial proof row shared by the audit
and consent-v2 pages. Each state shows a check when proven, a cross otherwise,
each with an accessible label:

```tsx
<ConsentStatePills coverage={result.stateCoverage} />
```

---

## Where these are used

| Component            | audit | consent-v2 | containers | server-side |
| -------------------- | :---: | :--------: | :--------: | :---------: |
| `StateCard`          |  ✓    |     ✓      |     ✓      |     ✓       |
| `NotConnectedState`  |  ✓    |     ✓      |   (direct) |     ✓       |
| `LoadingBlock`       |  ✓    |     ✓      |            |     ✓       |
| `SkeletonGrid`       |       |            |     ✓      |             |
| `ErrorState`         |  ✓    |     ✓      |     ✓      |     ✓       |
| `ToolFailureList`    |  ✓    |     ✓      |            |     ✓       |
| `SectionHeader`      |  ✓    |     ✓      |            |     ✓       |
| `StatusBadge`        |  ✓    |     ✓      |            |             |
| `ConsentStatePills`  |  ✓    |     ✓      |            |             |
| `EmptyRow`           |       |     ✓      |            |     ✓       |

## Extending the system

- Add a new tone by extending `StatusTone` in `status-badge.tsx` and the tone
  maps in `state-card.tsx` — keep the vocabulary small.
- New shared state surface? Add it under `components/common/`, export it from
  `index.ts`, and document it here. Keep the API small and composable.
- Do not move shared components into `apps/portal/api/**` — that directory is
  for Vercel serverless routes only.
