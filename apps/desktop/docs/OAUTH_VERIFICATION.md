# Google OAuth — consent screen, test users & verification

This guide takes Samarth Desktop's Google sign-in from "works only for me" to
"anyone can sign in." It explains the `access_denied` error, the difference
between **Testing** and **In production**, whether you need Google
**verification** (you do — but only the lighter *sensitive-scope* kind), and
exactly what to submit.

> Creating the OAuth **client** itself is covered in
> [INSTALL.md → Appendix A](../INSTALL.md#appendix-a--create-a-google-oauth-client).
> This doc is about the **consent screen** and **publishing/verification**.

---

## TL;DR — which path do you need?

| Your goal | Publishing status | Verification | Who can sign in |
|---|---|---|---|
| **Just me / a few teammates** | **Testing** | None | Only accounts added as **Test users** (max 100). Refresh tokens expire every **7 days** → users re-auth weekly. |
| **Ship to the public / clients** | **In production** | **Required** (sensitive scopes) | Anyone, once verified. Until verified: an "unverified app" warning + a 100-user cap. |

If you only saw `access_denied` while testing, you almost certainly just need to
**add the account as a Test user** — see the next section. Full verification is
only for public distribution.

---

## The `access_denied` you hit — cause & immediate fix

While the consent screen is in **Testing**, Google blocks any account that
isn't on the **Test users** list. That block surfaces as `access_denied`
(sometimes after a "Google hasn't verified this app" screen with no way
forward).

**Fix (30 seconds):**

1. [Google Cloud Console](https://console.cloud.google.com) → your project →
   **APIs & Services → OAuth consent screen** (newer console:
   **Google Auth platform → Audience**).
2. Under **Test users**, click **+ Add users**, enter the Gmail/Workspace
   address, **Save**.
3. Back in Samarth Desktop, connect that account again.

**Caveats that bite people:**

- **It must be the exact account** you sign in with (not an alias).
- **Workspace / business accounts** can still be blocked by an org policy even
  after you add them as a test user — a Workspace admin may need to allow the
  app under **Admin console → Security → API controls → App access control**.
- **Testing-mode refresh tokens expire after 7 days.** Samarth Desktop stores a
  refresh token per account; in Testing mode Google invalidates it weekly, so
  the account will need to reconnect. Publishing (below) removes this.

---

## Testing vs In production

The OAuth consent screen has a **Publishing status**:

- **Testing** — private. Only listed test users (≤100) can authorize. 7-day
  token expiry. No review. Good for development and a handful of known users.
- **In production** — public. Any Google account can authorize. This is where
  **verification** comes in: if your app requests **sensitive** or
  **restricted** scopes (Samarth Desktop requests sensitive ones), an
  *unverified* production app shows the **"Google hasn't verified this app"**
  warning and is capped at **100 grants** until you complete verification.

Moving to production is a button (**Publish app**) on the consent screen.
Publishing with sensitive scopes automatically puts you in the verification
queue.

---

## Do you need verification? (scope tiers)

Google classifies OAuth scopes into three tiers. What you must do depends on the
**highest** tier you request.

| Tier | Examples | Requirement when published |
|---|---|---|
| **Non-sensitive** | `openid`, `email`, `profile` | None |
| **Sensitive** | Tag Manager & Analytics scopes | **Verification**: brand review + scope justification + demo video |
| **Restricted** | Gmail, Drive (full), etc. | Verification **+ annual third-party security assessment (CASA)** |

**Samarth Desktop's scopes** (from `src/main/google/oauth.ts`):

| Scope | Tier | Used for |
|---|---|---|
| `openid`, `email`, `profile` | Non-sensitive | Identify the signed-in account |
| `https://www.googleapis.com/auth/tagmanager.readonly` | **Sensitive** | Read GTM accounts/containers/workspaces/tags to audit them |
| `https://www.googleapis.com/auth/tagmanager.edit.containers` | **Sensitive** | Create/edit tags, triggers, variables **in a draft workspace** (never publishes) |
| `https://www.googleapis.com/auth/analytics.readonly` | **Sensitive** | Read GA4 config & run reports |
| `https://www.googleapis.com/auth/analytics.edit` | **Sensitive** | Create/edit/delete/archive GA4 Admin config (key events, dimensions, metrics, streams, links, audiences, properties, …) at the user's request |
| `https://www.googleapis.com/auth/analytics.manage.users` | **Sensitive** | Manage GA4 access bindings (grant/change/revoke a user's account/property roles) at the user's request |

**Conclusion: you need sensitive-scope verification — and *not* a security
assessment.** None of these scopes are restricted, so the costly annual CASA
audit does **not** apply. This is the lighter review path.

---

## Verification submission checklist

Complete the OAuth consent screen, then submit. Google reviews against what they
can see and what your demo shows.

### 1. App branding (consent screen)
- **App name** — `Samarth Desktop` (must match what users see; can't contain
  "Google").
- **User support email**.
- **App logo** — 120×120 PNG, no rounded corners added by you. A logo triggers a
  separate brand review (do it once).
- **App home page** — a public URL on a domain you own.
- **Application privacy policy link** — required; must be on a domain you own and
  must actually describe how the app uses Google user data (see §3).
- **Application terms of service** — optional but recommended.
- **Authorized domains** — every domain used in the URLs above.
- **Developer contact information** — your email(s).

### 2. Domain ownership
All authorized domains (and the home page / privacy policy URLs) must be on a
domain you **verify in [Google Search Console](https://search.google.com/search-console)**
with the **same Google account** that owns the Cloud project. Unverified domains
block the submission.

### 3. Privacy policy — what it must say
For each scope, state what data is accessed and why, that data is used only to
provide the app's features, that it isn't sold, and how it's stored. Be explicit
that **GTM/GA4 data is read on the user's machine**, that GTM edits are limited to
**draft workspaces** (never published automatically), and that **GA4 Admin edits
(create/update/delete/archive config and access bindings) are applied to the live
property only at the user's explicit in-app request** (deletes and archives
require a two-step in-app confirmation). If you don't transmit Google user data
off-device, say so — it strengthens the review.

### 4. Scope justifications (copy/adapt per scope)
- **tagmanager.readonly** — "Read the user's GTM accounts, containers,
  workspaces, tags, triggers and variables to run configuration audits and
  produce health reports. Read-only."
- **tagmanager.edit.containers** — "Create and edit tags, triggers and variables
  **in a draft workspace** at the user's request. The app never requests
  publish/version scopes, so it cannot publish changes — every change stays in a
  draft workspace the user reviews and publishes in GTM; deletions additionally
  require explicit two-step in-app confirmation."
- **analytics.readonly** — "Read GA4 property configuration and run reports
  to audit setup and data quality."
- **analytics.edit** — "Create and edit GA4 Admin configuration at the user's
  request — key events, custom dimensions/metrics, data streams, links,
  audiences, channel groups, properties and data-retention settings. Every
  change is initiated by the user in-app; deletes and archives require explicit
  two-step in-app confirmation."
- **analytics.manage.users** — "Manage GA4 access bindings (grant/change/revoke
  a user's roles on an account or property) at the user's explicit request, so
  administrators can manage team access from the app."

### 5. Demo video
A public/unlisted **YouTube** video that shows:
1. The OAuth consent screen for **this exact app** (the URL bar shows your
   `client_id`), with the requested scopes visible.
2. Granting consent and returning to the app.
3. The app **using each sensitive scope** — e.g. listing GTM tags (readonly),
   creating a draft tag from chat (edit.containers), and a GA4
   audit/report (analytics.readonly).

> **Desktop/installed-app note:** Samarth Desktop is an *installed app* using the
> `127.0.0.1` loopback redirect. Google does not treat the installed-app client
> secret as confidential (it ships inside the app), and that is expected for this
> client type — it does not block verification. Branding/scope review still
> applies to the **project**, exactly as above.

### 6. Submit & wait
Consent screen → **Publish app** → **Prepare for verification** → fill the
verification form (justifications + video) → submit. Brand + sensitive-scope
review typically takes a few days to a few weeks; Google may email follow-up
questions. Until it clears, the app works in production but shows the unverified
warning and the 100-user cap.

---

## What changes, and when
- **As soon as you publish to In production** (before verification clears):
  refresh tokens stop expiring on the 7-day Testing cadence. The app still shows
  the unverified warning and is capped at 100 grants until review completes.
- **After verification clears**: the "unverified app" warning disappears and the
  100-user cap is removed.
- Re-verification is only needed if you later add new sensitive/restricted scopes
  or change branding.

## Links
- OAuth verification FAQ: <https://support.google.com/cloud/answer/9110914>
- Scopes & sensitivity: <https://developers.google.com/identity/protocols/oauth2/scopes>
- Unverified apps: <https://support.google.com/cloud/answer/7454865>
