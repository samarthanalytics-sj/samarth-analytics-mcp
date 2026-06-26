// Light/dark theming via CSS custom properties. The styles object references var(--…) for all
// structural colors (backgrounds, surfaces, text, borders); switching a theme just rewrites
// those variables on :root, which updates every inline var() instantly (no React re-render).
// Semantic accents (blue/green/red/amber) are intentionally NOT themed — they read on both.

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
    /* storage unavailable — non-fatal */
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
