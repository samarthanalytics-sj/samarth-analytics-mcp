# Installing Samarth Desktop on macOS

A step-by-step guide to building and installing the Samarth Desktop app on a Mac
using the Phase 6 (`electron-builder`) packaging. Works on Apple Silicon (M-series)
and Intel Macs.

> A macOS `.dmg` **must be built on a Mac** — it can't be cross-built from Windows.
> The app has no native modules, so there's no compile/rebuild step.

---

## 1. Prerequisites

- **macOS** (Apple Silicon or Intel)
- **Node.js 18 or newer** — `brew install node` (or from <https://nodejs.org>)
- **Git** — comes with the Xcode Command Line Tools: `xcode-select --install`
- A **Google "Desktop app" OAuth client** (see step 4) and at least one **LLM API key**
  (OpenAI / Anthropic / Gemini)

Check Node:

```bash
node -v   # should print v18.x or higher
```

---

## 2. Get the code

```bash
git clone https://github.com/samarthanalytics-sj/samarth-web-audit-mcp.git
cd samarth-web-audit-mcp/apps/desktop
npm install            # downloads the macOS Electron + builder tools (~1–2 min)
```

---

## 3. Build the installer (`.dmg`)

```bash
npm run dist:mac
```

This runs `electron-vite build` then `electron-builder`, producing files in
`apps/desktop/dist/`:

```
Samarth Desktop-0.0.0-arm64.dmg     # Apple Silicon
Samarth Desktop-0.0.0-x64.dmg       # Intel
```

> Prefer to just run it without installing? Use `npm run dev` instead (dev mode).

### Install it

1. Open the `.dmg` for your chip (`arm64` for M-series, `x64` for Intel).
2. Drag **Samarth Desktop** into **Applications**.
3. **First launch — Gatekeeper warning.** The build is *unsigned*, so macOS says
   *"Samarth Desktop can't be opened because it is from an unidentified developer."*
   Bypass it once:
   - **Right-click** the app in Applications → **Open** → **Open**, or
   - in Terminal: `xattr -dr com.apple.quarantine "/Applications/Samarth Desktop.app"`

   After that it opens normally. (To remove the warning entirely you'd sign +
   notarize the app with an Apple Developer ID — optional, see the end.)

---

## 4. First-run setup

Secrets are encrypted with the **macOS Keychain** and are **machine-specific** —
nothing carries over from another computer, so set these up fresh on the Mac.

### 4a. Create a Google "Desktop app" OAuth client (one-time)

In <https://console.cloud.google.com>:

1. Create/select a project.
2. **APIs & Services → Library** → enable: *Tag Manager API*, *Google Analytics
   Admin API*, *Google Analytics Data API*.
3. **OAuth consent screen** → External → fill app name/email. While unverified, add
   each Gmail account you'll connect under **Test users**.
4. **Credentials → Create credentials → OAuth client ID → Application type:
   Desktop app** → copy the **Client ID** and **Client secret**.

### 4b. Drop the client config into the app's data folder

On macOS the packaged app reads it from:

```
~/Library/Application Support/samarth-desktop/data/oauth-client.json
```

Create it:

```bash
mkdir -p ~/Library/Application\ Support/samarth-desktop/data
cat > ~/Library/Application\ Support/samarth-desktop/data/oauth-client.json <<'JSON'
{ "clientId": "XXXX.apps.googleusercontent.com", "clientSecret": "GOCSPX-XXXX" }
JSON
```

> **Not sure of the exact path?** Launch the app from Terminal once and it prints
> its data dir:
> ```bash
> "/Applications/Samarth Desktop.app/Contents/MacOS/Samarth Desktop"
> # → [samarth-desktop] data dir: /Users/<you>/Library/Application Support/samarth-desktop/data
> ```
> The Google download JSON (`{ "installed": { ... } }`) is also accepted as-is.

### 4c. Configure in the app

1. Open **Samarth Desktop**.
2. Click **+ Connect account** → pick your Google account → approve GTM/GA4 access.
   (For tag edits, approve *"Manage your Google Tag Manager container"*.)
3. **Settings → Providers** → paste your LLM API key (OpenAI / Anthropic / Gemini).
4. Per account, set the **LLM provider + model** (Settings).
5. In chat, choose **GTM** or **GA4**, set the **GTM context** (account › container
   › workspace) in the bar, and start chatting.

---

## 5. Where your data lives (macOS)

```
~/Library/Application Support/samarth-desktop/data/
├── oauth-client.json    # you place this (Google client id/secret)
├── registry.json        # accounts + per-account settings (non-secret)
├── secrets.json         # Google tokens + LLM keys — Keychain-encrypted
└── app-settings.json    # app-level provider key references
```

- Secret bytes are encrypted via the macOS Keychain; copying these files to another
  Mac/PC won't work — reconnect + re-enter keys there instead.
- Removing the app does **not** delete this folder. To fully reset, delete it.

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| *"unidentified developer"* on first open | Right-click → Open, or `xattr -dr com.apple.quarantine "/Applications/Samarth Desktop.app"` |
| App says **"Google OAuth client not configured"** | Create `oauth-client.json` in the data folder (step 4b), reopen the app |
| **`invalid_client`** at Google sign-in | The client_id is wrong/not a Desktop client — recheck step 4a and the file |
| **Login Required / 403** on a GTM/GA4 action | Disconnect + reconnect the account and approve the GTM "Manage" scope |
| A Keychain access prompt on first secret save | Click **Allow** (the app stores tokens/keys in your login keychain) |
| Build error mentioning `winCodeSign` / symlinks | That's a Windows-only build issue — ignore it on macOS |

A failed action also prints the real Google error in the Terminal log if you
launched the app from Terminal (`[samarth-desktop] tool "…" failed: …`).

---

## 7. Updating to a newer version

```bash
cd samarth-web-audit-mcp
git pull
cd apps/desktop
npm install
npm run dist:mac
# reinstall the new .dmg (drag over the old app)
```

Your data folder (step 5) is untouched by reinstalling, so accounts and keys stay.

---

## 8. Optional: signed & notarized build (no Gatekeeper warning)

For distributing to other Macs without the right-click-Open step, build with an
**Apple Developer ID** ($99/yr) and notarize:

1. Add your `Developer ID Application` certificate to the login keychain.
2. In `electron-builder.yml` set `mac.identity` to your identity and add
   `mac.notarize: true` (plus `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` /
   `APPLE_TEAM_ID` env vars).
3. `npm run dist:mac` — electron-builder signs and notarizes automatically.

Not required for personal/internal use.
