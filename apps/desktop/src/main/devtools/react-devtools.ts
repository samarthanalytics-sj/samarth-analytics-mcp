// Dev-only: load the React DevTools browser extension into the Electron session so the DevTools
// gains the "Components" and "Profiler" tabs (the thing the Console keeps suggesting). The extension
// is fetched from the web on first run, so this is best-effort and fully guarded: a failed download,
// an offline machine, or an interop quirk must never break app startup - it logs and moves on.

import installExtension, { REACT_DEVELOPER_TOOLS } from 'electron-devtools-installer';

let attempted = false;

/**
 * Load React DevTools into the default session. Idempotent. `report` receives the outcome so the
 * caller can surface it through the app's own logger. On the very first run the extension may only
 * appear after one DevTools reload (Electron finishes registering it slightly after this resolves).
 */
export async function installReactDevtools(report?: (ok: boolean, detail: string) => void): Promise<void> {
  if (attempted) return;
  attempted = true;
  try {
    // Interop guard: depending on how the CJS module is wrapped, the callable can be the default
    // export itself or nested one level deeper. Tolerate both rather than assume.
    const install = ((installExtension as unknown as { default?: typeof installExtension }).default ?? installExtension) as typeof installExtension;
    const ext = await install(REACT_DEVELOPER_TOOLS, { loadExtensionOptions: { allowFileAccess: true } });
    const name = typeof ext === 'string' ? ext : (ext as { name?: string } | undefined)?.name ?? 'React Developer Tools';
    report?.(true, name);
  } catch (e) {
    report?.(false, e instanceof Error ? e.message : String(e));
  }
}
