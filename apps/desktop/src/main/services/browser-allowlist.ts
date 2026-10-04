// Which executable openInBrowser may spawn. Kept free of Electron imports so it is unit-testable
// (browser-launch.ts imports electron's shell, which cannot load outside the app).

/**
 * PURE: the detected browser exe that `requested` names (case-insensitive path match), or null.
 *
 * The exe reaches openInBrowser from the renderer (shell:openInBrowser, google:connect,
 * google:connectAds), so on its own it is an arbitrary path: existsSync only proves that SOMETHING is
 * there. The renderer only ever sends an exe it got from shell:listBrowsers, so anything that
 * detectBrowsers() did not find is not a browser this app offered and must never be spawned.
 * Returns OUR copy of the path, so the spawned binary is the one detection vetted, not the caller's
 * string. The "Default browser" entry (empty exe) never matches.
 */
export function resolveDetectedExe(requested: string, detected: ReadonlyArray<{ exe: string }>): string | null {
  if (!requested) return null;
  const want = requested.toLowerCase();
  return detected.find((b) => b.exe !== '' && b.exe.toLowerCase() === want)?.exe ?? null;
}
