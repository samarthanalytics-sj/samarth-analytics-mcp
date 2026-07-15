// Light/dark theming via CSS custom properties. The styles object references var(--…) for ALL
// colors - structural (backgrounds, surfaces, text, borders) AND semantic accents (blue/cyan/amber/
// red/green, each with a text / soft-bg / soft-border variant). Switching a theme just rewrites
// these variables on :root, which updates every inline var() instantly (no React re-render).
// The dark accent values are the originals; the light ones are darker text on tinted backgrounds so
// chips/badges/banners read on a light surface instead of staying dark-on-light.

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'samarth.theme.v1';

const VARS: Record<Theme, Record<string, string>> = {
  dark: {
    '--bg': '#0b0f17',
    '--surface': '#0d1320',
    '--surface-2': '#161e2e',
    '--surface-3': '#16223a',
    '--surface-alt': '#111827',
    '--border': '#1f2937',
    '--border-2': '#334155',
    '--text': '#e5e7eb',
    '--text-dim': '#cbd5e1',
    '--text-muted': '#9ca3af',
    '--text-faint': '#6b7280',
    // semantic accents - text / soft background / soft border
    '--c-blue': '#93c5fd',
    '--c-blue-bg': '#1e3a5f',
    '--c-blue-border': '#1e3a5f',
    '--c-cyan': '#7dd3fc',
    '--c-cyan-bg': '#0c2030',
    '--c-cyan-border': '#1e4258',
    '--c-amber': '#fcd34d',
    '--c-amber-bg': '#3a2c0a',
    '--c-amber-border': '#92651a',
    '--c-red': '#fca5a5',
    '--c-red-bg': '#3a1416',
    '--c-red-border': '#7f1d1d',
    '--c-green': '#6ee7b7',
    '--c-green-bg': '#064e3b',
    '--c-green-border': '#065f46',
  },
  light: {
    '--bg': '#f4f6f9',
    '--surface': '#ffffff',
    '--surface-2': '#eef2f8',
    '--surface-3': '#e4ecf7',
    '--surface-alt': '#eaeef4',
    '--border': '#e2e8f0',
    '--border-2': '#cbd5e1',
    '--text': '#0f172a',
    '--text-dim': '#334155',
    '--text-muted': '#5b6776',
    '--text-faint': '#94a3b8',
    // semantic accents - darker text on a tinted bg so they read on a light surface
    '--c-blue': '#1d4ed8',
    '--c-blue-bg': '#dbeafe',
    '--c-blue-border': '#bfdbfe',
    '--c-cyan': '#0369a1',
    '--c-cyan-bg': '#e0f2fe',
    '--c-cyan-border': '#bae6fd',
    '--c-amber': '#b45309',
    '--c-amber-bg': '#fef3c7',
    '--c-amber-border': '#fcd34d',
    '--c-red': '#b91c1c',
    '--c-red-bg': '#fee2e2',
    '--c-red-border': '#fecaca',
    '--c-green': '#047857',
    '--c-green-bg': '#d1fae5',
    '--c-green-border': '#a7f3d0',
  },
};

export function loadTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable - non-fatal */
  }
}

/** Apply a theme by writing its CSS variables onto :root (and the body background). */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const vars = VARS[theme];
  for (const name of Object.keys(vars)) root.style.setProperty(name, vars[name]);
  root.setAttribute('data-theme', theme);
  document.body.style.background = vars['--bg'];
  document.body.style.color = vars['--text'];
}
