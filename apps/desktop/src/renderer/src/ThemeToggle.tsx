import { useEffect, useState } from 'react';
import { applyTheme, loadTheme, saveTheme, type Theme } from './theme';

// A shared light/dark control. `useTheme` is a tiny event-synced store so multiple toggles (the
// fixed header button + the Settings toggle) always agree: whoever flips the theme applies + persists
// it and broadcasts a window event, and every other consumer updates in lockstep - no lifted state,
// no prop threading through the (large) App tree.

const THEME_EVENT = 'samarth-theme-change';

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>(loadTheme());
  useEffect(() => {
    const onChange = (e: Event): void => {
      const d = (e as CustomEvent<Theme>).detail;
      if (d === 'dark' || d === 'light') set(d);
    };
    window.addEventListener(THEME_EVENT, onChange);
    return () => window.removeEventListener(THEME_EVENT, onChange);
  }, []);
  const setTheme = (t: Theme): void => {
    set(t);
    saveTheme(t);
    applyTheme(t);
    window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: t }));
  };
  return [theme, setTheme];
}

/** Monochrome sun / moon marks (currentColor) so they read in either theme without an icon library. */
function SunIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}
function MoonIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

/** A compact light/dark switch pinned to the top-right corner of the window, above the content on
 *  every view. It shows the icon of the theme you'd switch TO (sun while dark, moon while light). */
export function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useTheme();
  const dark = theme === 'dark';
  const next: Theme = dark ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme (currently ${theme})`}
      style={{
        position: 'fixed',
        top: 10,
        right: 14,
        zIndex: 50,
        width: 34,
        height: 34,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--surface-2)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(0,0,0,.14)',
      }}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
