// Detect installed browsers and open a URL in a CHOSEN one. Shared by the IPC handlers (the verify
// gate's "Open in [browser]" picker) and the Google OAuth sign-in flow, so the operator can send both
// GTM links and the account sign-in to whichever browser holds their signed-in Google session (Comet,
// Chrome, or Edge - the app can't know which, so it lets them pick).

import { shell } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';

export interface DetectedBrowser { id: string; name: string; exe: string }

// Standard install paths for the common browsers, per platform. Best-effort: a hit is only kept if the
// exe actually exists (checked in detectBrowsers). The LAST path segment is the exe, not the name.
function browserProbeList(): Array<{ name: string; exe: string }> {
  const out: Array<{ name: string; exe: string }> = [];
  const add = (name: string, base: string | undefined, ...parts: string[]): void => {
    if (base) out.push({ name, exe: join(base, ...parts) });
  };
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'];
    const pf86 = process.env['PROGRAMFILES(X86)'];
    const la = process.env['LOCALAPPDATA'];
    add('Google Chrome', pf, 'Google', 'Chrome', 'Application', 'chrome.exe');
    add('Google Chrome', pf86, 'Google', 'Chrome', 'Application', 'chrome.exe');
    add('Google Chrome', la, 'Google', 'Chrome', 'Application', 'chrome.exe');
    add('Microsoft Edge', pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    add('Microsoft Edge', pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    add('Brave', pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
    add('Brave', la, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
    add('Firefox', pf, 'Mozilla Firefox', 'firefox.exe');
    add('Opera', la, 'Programs', 'Opera', 'opera.exe');
    add('Vivaldi', la, 'Vivaldi', 'Application', 'vivaldi.exe');
    add('Comet', la, 'Perplexity', 'Comet', 'Application', 'comet.exe');
    add('Comet', la, 'Comet', 'Application', 'comet.exe');
  } else if (process.platform === 'darwin') {
    for (const [name, exe] of [
      ['Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['Microsoft Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      ['Brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      ['Firefox', '/Applications/Firefox.app/Contents/MacOS/firefox'],
      ['Comet', '/Applications/Comet.app/Contents/MacOS/Comet'],
    ] as Array<[string, string]>) out.push({ name, exe });
  } else {
    for (const [name, exe] of [
      ['Google Chrome', '/usr/bin/google-chrome'],
      ['Chromium', '/usr/bin/chromium'],
      ['Firefox', '/usr/bin/firefox'],
      ['Brave', '/usr/bin/brave-browser'],
      ['Microsoft Edge', '/usr/bin/microsoft-edge'],
    ] as Array<[string, string]>) out.push({ name, exe });
  }
  return out;
}

// Windows only: enumerate every registered browser from the StartMenuInternet registry keys, so a
// browser we don't hard-code (e.g. Comet) is still offered. Best-effort - a reg failure returns [].
function browsersFromRegistry(): Array<{ name: string; exe: string }> {
  if (process.platform !== 'win32') return [];
  const out: Array<{ name: string; exe: string }> = [];
  for (const root of ['HKLM', 'HKCU']) {
    let text = '';
    try {
      text = execFileSync('reg', ['query', `${root}\\SOFTWARE\\Clients\\StartMenuInternet`, '/s'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    } catch { continue; }
    let name = '';
    let inCommand = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^HKEY_/i.test(line)) {
        const key = line.match(/StartMenuInternet\\([^\\]+)/i);
        name = key ? key[1] : '';
        inCommand = /\\shell\\open\\command\s*$/i.test(line);
        continue;
      }
      if (inCommand && name) {
        const v = line.match(/REG_SZ\s+"?([A-Za-z]:\\[^"]+?\.exe)"?/i);
        if (v) out.push({ name: name.replace(/\.exe$/i, ''), exe: v[1] });
      }
    }
  }
  return out;
}

// Every installed browser we can offer to open a link in - the OS default always first, then each
// detected browser once (deduped by exe path). Hard-coded probes run before the registry sweep so a
// known browser keeps its clean name.
export function detectBrowsers(): DetectedBrowser[] {
  const out: DetectedBrowser[] = [{ id: 'default', name: 'Default browser', exe: '' }];
  const seen = new Set<string>();
  for (const b of [...browserProbeList(), ...browsersFromRegistry()]) {
    const key = b.exe.toLowerCase();
    // Skip Internet Explorer - it just redirects to Edge and clutters the picker.
    if (!b.exe || seen.has(key) || /iexplore\.exe$/i.test(key)) continue;
    try { if (!existsSync(b.exe)) continue; } catch { continue; }
    seen.add(key);
    out.push({ id: key, name: b.name, exe: b.exe });
  }
  return out;
}

// Open a URL in a SPECIFIC browser exe (empty exe = the OS default). http(s) only, so a value can never
// become a browser flag. Falls back to the default browser if the exe is missing or won't launch.
export function openInBrowser(url: string, exe: string): boolean {
  const safe = /^https?:\/\//i.test(url) ? url : '';
  if (!safe) return false;
  if (!exe) { void shell.openExternal(safe); return true; }
  try { if (!existsSync(exe)) { void shell.openExternal(safe); return false; } } catch { void shell.openExternal(safe); return false; }
  try {
    const child = spawn(exe, [safe], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    void shell.openExternal(safe);
    return false;
  }
}
