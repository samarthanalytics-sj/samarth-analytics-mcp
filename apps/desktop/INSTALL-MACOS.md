# Installing Samarth Desktop on macOS

Samarth Desktop is a local Electron app that connects multiple Google accounts
and lets you read and edit your Google Tag Manager / GA4 setup by chat (any of
Anthropic, OpenAI, or Gemini). Everything runs on your machine; secrets are
encrypted in the macOS Keychain.

There are two ways to get it running on a Mac:

- **Option A — Install the packaged app (`.dmg`)** — recommended for normal use.
- **Option B — Run from source** — for development.

---

## Prerequisites

- **macOS 11 (Big Sur) or later** — Apple Silicon (M-series) or Intel.
- **Node.js 18+** and **Git**. Easiest via [Homebrew](https://brew.sh):
  ```bash
  brew install node git
  ```
- **Xcode Command Line Tools** (for building): `xcode-select --install`
- A **Google "Desktop app" OAuth client** (Client ID + Secret) — see
  [Appendix A](#appendix-a--create-a-google-desktop-oauth-client). The same
  client you used on Windows works here.
- At least one **LLM API key** (OpenAI, Anthropic, or Gemini).

---

## Option A — Install the packaged app (`.dmg`)

### 1. Build the `.dmg` (on the Mac)

> A macOS `.dmg` must be built **on a Mac** — it can't be built from Windows.

```bash
git clone https://github.com/samarthanalytics-sj/samarth-web-audit-mcp.git
cd samarth-web-audit-mcp/apps/desktop
npm install
npm run dist:mac
```

The installers land in **`apps/desktop/dist/`**:

- `Samarth Desktop-<version>-arm64.dmg` → **Apple Silicon** (M1/M2/M3/M4)
- `Samarth Desktop-<version>-x64.dmg` → **Intel** Macs

### 2. Install

Open the matching `.dmg` and drag **Samarth Desktop** into **Applications**.

### 3. First launch (the app is unsigned)

Because the build is **not code-signed**, macOS Gatekeeper blocks it the first
time. Do **one** of these (only needed once):

- **Right-click** (or Control-click) *Samarth Desktop* in Applications →
  **Open** → **Open** in the dialog, **or**
- System Settings → **Privacy & Security** → scroll down → **Open Anyway**, **or**
- Terminal:
  ```bash
  xattr -dr com.apple.quarantine "/Applications/Samarth Desktop.app"
  ```

After that, launch it normally from Applications/Spotlight.

Now jump to [First-run setup](#first-run-setup).

---

## Option B — Run from source

```bash
git clone https://github.com/samarthanalytics-sj/samarth-web-audit-mcp.git
cd samarth-web-audit-mcp/apps/desktop
npm install        # downloads the macOS Electron binary automatically
npm run dev
```

This opens the app with hot-reload. It's not a packaged app — use Option A for a
real install.

---

## First-run setup

The same steps apply to both options.

### 1. Configure the Google OAuth client

The app needs an `oauth-client.json`. On first launch, open **Settings** — if it
isn't configured, a banner shows the **exact path** to create the file. Create it
there with:

```json
{
  "clientId": "1234567890-abc.apps.googleusercontent.com",
  "clientSecret": "GOCSPX-xxxxxxxxxxxxxxxx"
}
```

Default locations:

| Install type | Path |
|---|---|
| **Packaged app** | `~/Library/Application Support/Samarth Desktop/data/oauth-client.json` |
| **Run from source** | `<repo>/data/oauth-client.json` |

> Create the `data` folder if it doesn't exist. In Finder use **Go → Go to
> Folder…** (`⇧⌘G`) and paste the path. Then **restart the app**.

The app also accepts Google's downloaded credentials JSON
(`{"installed":{...}}`) as-is. To create a client, see
[Appendix A](#appendix-a--create-a-google-desktop-oauth-client).

### 2. Connect your Google account(s)

- Click **+ Connect account** in the sidebar.
- Your default browser opens Google's account chooser → pick the account →
  approve access (including **Manage your Google Tag Manager container** if you
  want to create/edit tags). macOS may ask to allow Keychain access — choose
  **Always Allow**.
- The account appears with a green dot. Repeat **+ Connect** for more accounts.

### 3. Add your LLM API key

**Settings → Providers** → enter your OpenAI / Anthropic / Gemini key → **Save**.
One key per provider, shared by all accounts, stored encrypted in the Keychain.

### 4. Choose a model for the account

**Settings → Language model** → pick provider + model (e.g. OpenAI / `gpt-4o`) →
**Save**.

### 5. Use it

Select the account in the sidebar → **Chat**. Toggle **GTM / GA4**. In GTM mode,
set the **context bar** (Account → Container → Workspace) once; the app remembers
it. Then ask, e.g. *"create a GA4 email-click event tag."* Creates and edits apply
directly to a **draft workspace** (never published); deletes show a two-step
approval card.

---

## Where your data lives (macOS)

Packaged app: `~/Library/Application Support/Samarth Desktop/`

| File | Contents |
|---|---|
| `data/registry.json` | Account list + settings (no secrets) |
| `data/secrets.json` | **Encrypted** Google tokens + LLM keys (macOS Keychain) |
| `data/app-settings.json` | App-level provider key refs |
| `data/oauth-client.json` | Your Google OAuth client config |

Secrets are encrypted by the **Keychain** and bound to your macOS user — they do
**not** transfer from another computer. Moving to a new Mac means re-adding the
`oauth-client.json`, reconnecting Google accounts, and re-entering API keys.

---

## Updating

```bash
cd samarth-web-audit-mcp
git pull
cd apps/desktop && npm install && npm run dist:mac
```

Reinstall the new `.dmg` (drag over the old app). Your accounts and keys persist —
they live in *Application Support*, not inside the app bundle.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| *"App is damaged / can't be opened"* | `xattr -dr com.apple.quarantine "/Applications/Samarth Desktop.app"` |
| *"unidentified developer"* on first open | Right-click the app → **Open** (once), or **Open Anyway** in Privacy & Security |
| **Settings shows "OAuth client not configured"** | Create `oauth-client.json` at the path in the banner, then restart |
| Google **`invalid_client`** | Wrong/empty `clientId` — it must end in `.apps.googleusercontent.com` (paste the Client **ID**, not the secret) |
| Google **`access_denied`** | Add your account as a **Test user** on the OAuth consent screen |
| **"Login Required"** on a GTM/GA4 call | The account's token lacks scope — **disconnect** then **reconnect** it |
| **403** when creating/editing a tag | Reconnect the account so it grants the GTM **edit** scope |
| Can't find the data folder | Finder → **Go → Go to Folder…** → `~/Library/Application Support/Samarth Desktop/` |

When a tool call fails, the underlying Google error is shown in the chat (and, in
dev, logged to the terminal as `[samarth-desktop] tool … failed: …`).

---

## Appendix A — Create a Google "Desktop app" OAuth client

1. [Google Cloud Console](https://console.cloud.google.com) → create or select a
   project.
2. **APIs & Services → Library** → enable: **Tag Manager API**, **Google
   Analytics Admin API**, **Google Analytics Data API**.
3. **OAuth consent screen** → User type **External** → add your Gmail address(es)
   under **Test users** (required while the app is unverified).
4. **Credentials → Create credentials → OAuth client ID** → Application type:
   **Desktop app** → **Create**. Copy the **Client ID** and **Client secret**
   into `oauth-client.json` (above). No redirect URIs to register — desktop
   clients allow the `127.0.0.1` loopback automatically.

---

## Appendix B — Signed / notarized builds (optional)

To distribute without the Gatekeeper warning you need an **Apple Developer
account** ($99/yr): provide a Developer ID certificate (`CSC_LINK` /
`CSC_KEY_PASSWORD`) and enable notarization in `electron-builder.yml`. Not
required for personal/local installs.
