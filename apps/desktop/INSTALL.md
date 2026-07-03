# Samarth Desktop — Install & Run (Windows & macOS)

**Samarth Desktop** is a local app that connects one or more Google accounts and
lets you read and edit your **Google Tag Manager / GA4** setup by chat — using
your own LLM (OpenAI, Anthropic, or Gemini). Everything runs on your machine;
secrets are encrypted by the OS keychain (Windows **DPAPI** / macOS **Keychain**).

There are two ways to use it:

| | |
|---|---|
| **A. Run from source** | Quickest. Works on Windows, macOS, Linux. Good for trying it / dev. |
| **B. Build an installer** | A real app you install: `.exe` (Windows) or `.dmg` (macOS). |

---

## 1. Prerequisites (both OS)

- **Node.js 18 or newer** and **Git**
  - **Windows:** install from <https://nodejs.org> and <https://git-scm.com>
  - **macOS:** `brew install node git` (and `xcode-select --install` for build tools)
  - Verify: `node -v` → `v18.x` or higher
- A **Google "Desktop app" OAuth client** (Client ID + Secret) — see [Appendix A](#appendix-a--create-a-google-oauth-client)
- At least one **LLM API key** (OpenAI / Anthropic / Gemini)

---

## 2. Get the code

Clone into your **home folder** (not inside another copy, or you get a nested path):

```bash
git clone https://github.com/samarthanalytics-sj/samarth-analytics-mcp.git
cd samarth-analytics-mcp/apps/desktop
```

> The desktop app lives in `apps/desktop`. (The same app is mirrored in the
> `samarth-web-audit-mcp` repo — either works.)

---

## 3A. Run from source (any OS)

```bash
npm install
npm run dev
```

**If you see `Error: Electron uninstall`** when running `npm run dev`: the
Electron binary downloaded but never finished **extracting** into
`node_modules/electron/dist` — that folder ends up with only a `locales/`
subfolder (no `electron.exe`) and `path.txt` is missing. Reinstalling usually
does **not** fix it, because the cached `.zip` is already present so the
installer reports a "cache hit" and skips re-extracting.

**Reliable fix — re-extract the cached binary straight into `dist`** (run from
`apps/desktop`):

**Windows (PowerShell):**
```powershell
$e = ".\node_modules\electron"
$zip = Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Recurse -Filter "electron-v*-win32-*.zip" | Select-Object -First 1
Remove-Item -Recurse -Force "$e\dist" -ErrorAction SilentlyContinue
Expand-Archive $zip.FullName "$e\dist" -Force
[IO.File]::WriteAllText("$e\path.txt", "electron.exe")
node -p "require('electron')"   # should print ...\node_modules\electron\dist\electron.exe
npm run dev
```

**macOS / Linux:**
```bash
rm -rf node_modules/electron/dist
node node_modules/electron/install.js   # re-extracts from the cache (or re-downloads)
node -p "require('electron')"           # should print a path ending in .../dist/electron
npm run dev
```

If the cache is empty/corrupt (no `electron-v*.zip` under the cache folder, or
the fix above still fails), force a clean re-download, then re-run `npm install`:
```bash
# Windows:  Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electron\Cache"
# macOS:    rm -rf ~/Library/Caches/electron
# Linux:    rm -rf ~/.cache/electron
```

> **Install into your home folder** (`C:\Users\<you>\…` or `~`), never a
> protected/system directory like `C:\Windows\System32` — Windows can block
> Electron from writing `electron.exe` there, which causes this same error.

### One-line setup + launch

**macOS / Linux:**
```bash
cd ~ && git clone https://github.com/samarthanalytics-sj/samarth-analytics-mcp.git && cd samarth-analytics-mcp/apps/desktop && npm install && node node_modules/electron/install.js && npm run dev
```

**Windows (PowerShell):**
```powershell
cd ~; git clone https://github.com/samarthanalytics-sj/samarth-analytics-mcp.git; cd samarth-analytics-mcp/apps/desktop; npm install; node node_modules/electron/install.js; npm run dev
```

---

## 3B. Build a desktop installer

Build **on the target OS** — a `.dmg` must be built on a Mac, an `.exe` on
Windows (no cross-building). No native modules, so there's no compile step.

```bash
npm install
npm run dist          # build for the current OS → apps/desktop/dist/
npm run dist:mac      # macOS .dmg (arm64 + x64) — run on a Mac
npm run dist:win      # Windows NSIS installer — run on Windows
```

### macOS — install the `.dmg`
1. Open the `.dmg` for your chip (`arm64` = Apple Silicon, `x64` = Intel) → drag
   **Samarth Desktop** into **Applications**.
2. First launch (the app is **unsigned**): **right-click** the app → **Open** →
   **Open**, or run
   `xattr -dr com.apple.quarantine "/Applications/Samarth Desktop.app"`.

### Windows — install the `.exe`
1. Run `Samarth Desktop-<version>-setup.exe` from `apps/desktop/dist/`.
2. SmartScreen may warn (unsigned) → **More info → Run anyway**.
3. **Build note:** if `npm run dist:win` fails extracting `winCodeSign` with
   *"a required privilege is not held"*, enable **Developer Mode**
   (Settings → Privacy & security → For developers) or run the terminal **as
   Administrator**, then retry.

---

## 4. First-run setup (once)

Secrets are keychain-bound and **do not transfer between machines** — set these up
fresh on each computer.

1. **Add the Google OAuth client.** Open **Settings** — if it isn't configured, a
   banner shows the **exact path** to create `oauth-client.json`. Create it there:
   ```json
   { "clientId": "XXXX.apps.googleusercontent.com", "clientSecret": "GOCSPX-XXXX" }
   ```
   (Google's downloaded `{ "installed": { ... } }` JSON is also accepted.) Then
   restart the app.
2. **Connect your Google account(s)** → **+ Connect account** → approve access
   (include *"Manage your Google Tag Manager container"* for tag edits).
3. **Add your LLM key** → **Settings → Providers** → paste your OpenAI / Anthropic
   / Gemini key (one per provider, shared by all accounts).
4. **Pick a model** → Settings → Language model (e.g. OpenAI / `gpt-4o`).
5. **Use it** → choose **GTM** or **GA4**, set the **context bar** (account →
   container → workspace) once, and chat. Creates and edits apply directly to a
   **draft workspace** (never published); deletes show a two-step approval card.

---

## 5. Where your data lives

| OS | Packaged app | Run from source |
|---|---|---|
| **Windows** | `%APPDATA%\Samarth Desktop\data\` | `<repo>\data\` |
| **macOS** | `~/Library/Application Support/Samarth Desktop/data/` | `<repo>/data/` |

```
data/
├── oauth-client.json    # you place this (Google client id/secret)
├── registry.json        # accounts + settings (no secrets)
├── secrets.json         # Google tokens + LLM keys — encrypted (DPAPI / Keychain)
└── app-settings.json    # app-level provider key references
```

The exact path is also shown in the app's **Settings** banner (and printed to the
terminal at startup: `[samarth-desktop] data dir: …`). Uninstalling does not
delete this folder.

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `Error: Electron uninstall` | Binary downloaded but didn't extract into `node_modules/electron/dist` (only `locales/` present) — see [3A](#3a-run-from-source-any-os): re-extract the cached `.zip` into `dist` and write `path.txt`. Reinstalling alone won't fix it (cache hit). |
| Doubled path like `…/apps/desktop/samarth-analytics-mcp/apps/desktop/…` | You cloned inside an existing copy — delete it and clone into `~` |
| macOS "unidentified developer" | Right-click → **Open**, or `xattr -dr com.apple.quarantine "/Applications/Samarth Desktop.app"` |
| Windows `winCodeSign` "privilege not held" during build | Enable **Developer Mode** or run the terminal as **Administrator** |
| **"OAuth client not configured"** | Create `oauth-client.json` at the path in the Settings banner; restart |
| **`invalid_client`** at sign-in | Wrong/empty `clientId` — paste the **Client ID** (ends `.apps.googleusercontent.com`), not the secret; use a **Desktop** client |
| **`access_denied`** (Workspace/business account) | Add the account as a **Test user** on the consent screen; a Workspace admin may need to allow the app |
| **"Login Required" / 403** on a GTM/GA4 action | **Disconnect** and **reconnect** the account, approving the GTM "Manage" scope |

When a tool call fails, the real Google error appears in chat (and in the terminal
log if launched from a terminal).

---

## 7. Updating

```bash
cd samarth-analytics-mcp
git pull
cd apps/desktop
npm install
npm run dev          # or: npm run dist:mac / npm run dist:win to rebuild the installer
```

Your accounts and keys persist (they live in the data folder above, not in the
app), so updating doesn't lose them.

---

## Appendix A — Create a Google OAuth client

1. [Google Cloud Console](https://console.cloud.google.com) → create / select a project.
2. **APIs & Services → Library** → enable **Tag Manager API**, **Google Analytics
   Admin API**, **Google Analytics Data API**.
3. **OAuth consent screen** → User type **External** → add your Gmail address(es)
   under **Test users** (required while the app is unverified).
4. **Credentials → Create credentials → OAuth client ID** → Application type:
   **Desktop app** → **Create**. Copy the **Client ID** and **Client secret** into
   `oauth-client.json` (step 4 above). No redirect URIs to register — desktop
   clients allow the `127.0.0.1` loopback automatically.

> **Getting `access_denied`, or want anyone (not just test users) to sign in?**
> See [docs/OAUTH_VERIFICATION.md](docs/OAUTH_VERIFICATION.md) — it covers test
> users, the Testing→Production switch, and Google's (sensitive-scope)
> verification.

---

## Appendix B — Signed builds (optional)

To distribute without the Gatekeeper/SmartScreen warnings you need a code-signing
certificate (Apple Developer ID for macOS, an Authenticode cert for Windows) and,
on macOS, notarization. Not required for personal/internal use. The full
build → sign → notarize → distribute process is in
[docs/RELEASE.md](docs/RELEASE.md); `electron-builder.yml` has the commented
signing blocks to wire in.
