// Light/dark theming via CSS custom properties. The styles object references var(--…) for ALL
// colors - structural (backgrounds, surfaces, text, borders) AND semantic accents (blue/cyan/amber/
// red/green, each with a text / soft-bg / soft-border variant). Switching a theme just rewrites
// these variables on :root, which updates every inline var() instantly (no React re-render).
//
// Design system (2026-07 refresh, Linear/Vercel/shadcn-calibre):
// - Slate-scale structural palette; dark is the default look, light is a first-class equal.
// - Every text token is WCAG AA verified against every surface it sits on (contrast-check pass:
//   text/dim/muted >= 4.5:1 on bg/surface/surface-2/surface-3/surface-alt; faint >= 3:1 and is
//   caption/decoration-only; every accent >= 4.5:1 on its soft bg AND on the plain surface).
// - Dark accents are LIGHT pastels with colored text on tinted backgrounds - never white on an
//   accent (the pastels can't carry white). Solid actions use --primary/--danger + --on-*.
// - New semantic aliases (--success/--warning/--error/--info) reference the accent vars, so both
//   naming schemes stay in lockstep by construction.

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'samarth.theme.v1';

// Tokens identical in both themes: type, radii, motion, and the semantic aliases.
const SHARED: Record<string, string> = {
  '--font-sans': "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  '--font-mono': "ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  '--radius-s': '6px',
  '--radius-m': '10px',
  '--radius-l': '14px',
  '--ease': 'cubic-bezier(0.22, 0.61, 0.36, 1)',
  '--success': 'var(--c-green)',
  '--success-bg': 'var(--c-green-bg)',
  '--success-border': 'var(--c-green-border)',
  '--warning': 'var(--c-amber)',
  '--warning-bg': 'var(--c-amber-bg)',
  '--warning-border': 'var(--c-amber-border)',
  '--error': 'var(--c-red)',
  '--error-bg': 'var(--c-red-bg)',
  '--error-border': 'var(--c-red-border)',
  '--info': 'var(--c-blue)',
  '--info-bg': 'var(--c-blue-bg)',
  '--info-border': 'var(--c-blue-border)',
};

const VARS: Record<Theme, Record<string, string>> = {
  dark: {
    ...SHARED,
    '--bg': '#0a0d14',
    '--surface': '#0f1420',
    '--surface-2': '#161d2c',
    '--surface-3': '#1d2637',
    '--surface-alt': '#121826',
    '--border': '#1e2635',
    '--border-2': '#2e3a4f',
    '--text': '#f1f5f9',
    '--text-dim': '#cbd5e1',
    '--text-muted': '#9ca9bb',
    '--text-faint': '#6b7a90',
    // Solid interactive colors - the ONLY places light text sits on a saturated fill.
    // White on #2563eb = 4.68:1 (AA). Dark hover goes LIGHTER; light hover goes darker.
    '--primary': '#2563eb',
    '--primary-hover': '#3b82f6',
    '--primary-active': '#1d4ed8',
    '--on-primary': '#ffffff',
    '--primary-soft': 'rgba(37, 99, 235, 0.16)',
    '--primary-soft-border': 'rgba(59, 130, 246, 0.45)',
    // Text selection: a SOLID light-blue highlight with near-black text, so the selection is clearly
    // visible on the dark chat surface AND inside the blue user bubbles (light-on-blue reads; a
    // translucent primary tint did not). Light bg + dark fg is the one pairing readable on every
    // surface text appears on.
    '--selection-bg': '#a7c7f5',
    '--selection-fg': '#0b1220',
    '--danger': '#dc2626',
    '--danger-hover': '#ef4444',
    '--on-danger': '#ffffff',
    // Focus ring + elevation (deeper, softer shadows for the dark surfaces).
    '--ring': 'rgba(59, 130, 246, 0.45)',
    '--shadow-1': '0 1px 2px rgba(0, 0, 0, 0.35)',
    '--shadow-2': '0 4px 14px rgba(0, 0, 0, 0.40)',
    '--shadow-3': '0 16px 44px rgba(0, 0, 0, 0.55)',
    // Semantic accents - pastel text / tinted soft background / visible soft border.
    '--c-blue': '#93c5fd',
    '--c-blue-bg': '#16283f',
    '--c-blue-border': '#2a4a73',
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
    '--c-green-bg': '#0a3d2e',
    '--c-green-border': '#147a5c',
    // Per-platform brand accents for the chat context cards: each product's real identity colour
    // (GTM blue, GA4 the Analytics orange, Google Ads green), as a pastel glyph on a deep tint so it
    // reads on the dark surface without white-on-accent. See [[desktop-theme-accents]].
    '--plat-gtm': '#93c5fd',
    '--plat-gtm-bg': '#16283f',
    '--plat-gtm-border': '#2f4d78',
    '--plat-ga4': '#fdba74',
    '--plat-ga4-bg': '#3a220b',
    '--plat-ga4-border': '#8a4e1c',
    '--plat-ads': '#6ee7b7',
    '--plat-ads-bg': '#0a3d2e',
    '--plat-ads-border': '#177a5c',
  },
  light: {
    ...SHARED,
    '--bg': '#f8fafc',
    '--surface': '#ffffff',
    '--surface-2': '#f1f5f9',
    '--surface-3': '#e8eef5',
    '--surface-alt': '#eef2f7',
    '--border': '#e2e8f0',
    '--border-2': '#cbd5e1',
    '--text': '#0f172a',
    '--text-dim': '#334155',
    '--text-muted': '#5b6776',
    '--text-faint': '#7c8ba1',
    '--primary': '#2563eb',
    '--primary-hover': '#1d4ed8',
    '--primary-active': '#1e40af',
    '--on-primary': '#ffffff',
    '--primary-soft': '#dbeafe',
    '--primary-soft-border': '#93c5fd',
    // Text selection (light): light-blue highlight, dark text - readable on white surfaces and on the
    // blue user bubbles alike.
    '--selection-bg': '#b6d4fb',
    '--selection-fg': '#0b1220',
    '--danger': '#dc2626',
    '--danger-hover': '#b91c1c',
    '--on-danger': '#ffffff',
    '--ring': 'rgba(37, 99, 235, 0.30)',
    '--shadow-1': '0 1px 2px rgba(15, 23, 42, 0.06)',
    '--shadow-2': '0 4px 14px rgba(15, 23, 42, 0.08)',
    '--shadow-3': '0 16px 44px rgba(15, 23, 42, 0.16)',
    // Semantic accents - darker text on a tinted bg so they read on a light surface.
    '--c-blue': '#1d4ed8',
    '--c-blue-bg': '#dbeafe',
    '--c-blue-border': '#bfdbfe',
    '--c-cyan': '#0369a1',
    '--c-cyan-bg': '#e0f2fe',
    '--c-cyan-border': '#bae6fd',
    '--c-amber': '#92400e',
    '--c-amber-bg': '#fef3c7',
    '--c-amber-border': '#fcd34d',
    '--c-red': '#b91c1c',
    '--c-red-bg': '#fee2e2',
    '--c-red-border': '#fecaca',
    '--c-green': '#047857',
    '--c-green-bg': '#d1fae5',
    '--c-green-border': '#a7f3d0',
    // Per-platform brand accents (light): a strong brand-hue glyph on a soft tint. GA4 is the
    // Analytics orange, distinct from the yellow-amber "warning" accent.
    '--plat-gtm': '#1d4ed8',
    '--plat-gtm-bg': '#dbeafe',
    '--plat-gtm-border': '#bfdbfe',
    '--plat-ga4': '#c2410c',
    '--plat-ga4-bg': '#ffedd5',
    '--plat-ga4-border': '#fed7aa',
    '--plat-ads': '#047857',
    '--plat-ads-bg': '#d1fae5',
    '--plat-ads-border': '#a7f3d0',
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
  root.style.colorScheme = theme; // native controls (scrollbars, selects, pickers) match the theme
  document.body.style.background = vars['--bg'];
  document.body.style.color = vars['--text'];
}
