# Releasing Samarth Desktop — build, sign, distribute

How to produce installers users can run without scary warnings. Unsigned builds
work fine for personal/internal use (with a one-time OS prompt); **signing** is
what removes the warnings for public distribution.

> Packaging is configured in [`electron-builder.yml`](../electron-builder.yml).
> electron-vite builds the app into `out/`; electron-builder wraps `out/` + the
> production `node_modules` into installers under `dist/`.

---

## 1. Build (per OS)

Build on the **target OS** — there's no cross-compiling here (a `.dmg` must be
built on macOS, an `.exe` on Windows). No native modules, so no rebuild step.

```bash
cd apps/desktop
npm ci
npm run dist:win     # → dist/Samarth Desktop-<version>-setup.exe   (run on Windows)
npm run dist:mac     # → dist/Samarth Desktop-<version>-<arch>.dmg  (run on macOS)
npm run dist:linux   # → dist/Samarth Desktop-<version>.AppImage    (run on Linux)
```

`npm run pack:dir` produces an unpacked `dist/<platform>-unpacked/` for a quick
smoke test without building a full installer.

---

## 2. Windows code signing

Unsigned `.exe` installers trigger **SmartScreen** ("Windows protected your PC").
To remove it you need an **Authenticode** certificate.

- **OV (Organization Validation)** — cheaper. SmartScreen reputation builds up
  *over time / download volume*, so early users may still see the warning.
- **EV (Extended Validation)** — historically granted *immediate* SmartScreen
  reputation, but **since March 2024 Microsoft no longer gives EV an instant
  pass** — both OV and EV now build reputation over downloads. Don't buy EV just
  to skip SmartScreen; it's still required for some scenarios (e.g. kernel-driver
  signing). Modern OV/EV certs are increasingly issued on **hardware tokens or
  cloud HSM** (e.g. Azure Trusted Signing, DigiCert KeyLocker), not plain `.pfx`.

To pre-clear a brand-new binary, you can also submit it to Microsoft via the
[SmartScreen file-submission form](https://www.microsoft.com/en-us/wdsi/filesubmission).

electron-builder reads signing material from environment variables — you don't
put secrets in `electron-builder.yml`:

```bash
# .pfx-based cert (set in the build shell / CI secret, NEVER committed):
export CSC_LINK="C:/secure/code-sign.pfx"     # path or base64 of the .pfx
export CSC_KEY_PASSWORD="********"
npm run dist:win
```

For cloud/HSM signing (token can't be exported to a `.pfx`), sign as a
**post-build step** with the provider's tool (e.g. `signtool` + Azure Trusted
Signing) against the artifact in `dist/`, or wire `win.sign` to a custom signing
script. See the commented `win:`/`# signing` block in `electron-builder.yml`.

---

## 3. macOS signing + notarization

Unsigned `.dmg`s show a Gatekeeper block. For seamless launch you need an **Apple
Developer ID Application** certificate **and notarization**.

1. Install the *Developer ID Application* cert in your login keychain (or provide
   it via `CSC_LINK`/`CSC_KEY_PASSWORD`).
2. Provide notarization credentials and enable the hardened runtime + notarize in
   `electron-builder.yml` (see the commented `mac:` block):

```bash
export CSC_LINK="/secure/developer-id.p12"
export CSC_KEY_PASSWORD="********"
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"   # appleid.apple.com app password
export APPLE_TEAM_ID="XXXXXXXXXX"
npm run dist:mac
```

With `mac.identity` set (not `null`), `hardenedRuntime: true`, and
`notarize: true`, electron-builder signs, submits to Apple for notarization, and
staples the ticket. **Without** these, the build stays unsigned and the INSTALL
doc's right-click→Open / `xattr -dr com.apple.quarantine` workaround applies.

---

## 4. Linux

`AppImage` is distributed unsigned (normal for the format). Users `chmod +x` and
run it. No signing step.

---

## 5. Distribute

1. Tag the release and attach the artifacts from `dist/` to a **GitHub Release**
   (or your download page).
2. Publish **SHA-256 checksums** alongside each installer so users can verify
   downloads:
   ```bash
   shasum -a 256 dist/Samarth\ Desktop-*  # macOS/Linux
   # Windows (PowerShell): Get-FileHash dist\*.exe -Algorithm SHA256
   ```
3. Point users at [INSTALL.md](../INSTALL.md). First-run on unsigned builds shows
   the documented OS prompt; signed builds launch clean.
4. **Auto-update** is *not* wired up. To add it, configure a `publish` provider
   in `electron-builder.yml` and add `electron-updater` — out of scope here.

---

## 6. Pre-release checklist

- [ ] `npm run typecheck` and `npm test` pass (run from `apps/desktop`).
- [ ] Version bumped where appropriate (the desktop app is private and not on the
      root semantic-release pipeline — see the repo root `CLAUDE.md`).
- [ ] Built on each target OS; installer launches and connects an account.
- [ ] **No secrets bundled**: `oauth-client.json` and `secrets.json` (Google
      tokens + LLM keys, encrypted) live in the user data dir, **not** in the
      app — confirm they aren't in `dist/`.
- [ ] Signing env vars set (for signed releases); artifact signature verified.
- [ ] Checksums published.
