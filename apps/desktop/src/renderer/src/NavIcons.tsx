// Sidebar nav icons. The two Google services use their brand marks (fixed brand colours that read on
// either theme's sidebar surface); the app sections use monochrome line icons that inherit the nav
// text colour via currentColor. All 18px, inlined as SVG so there is no icon-library dependency.

const SZ = 18;
const line = {
  width: SZ, height: SZ, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  'aria-hidden': true, style: { flexShrink: 0 } as const,
};

/** Chat — a message bubble. */
export function ChatIcon(): JSX.Element {
  return (
    <svg {...line}>
      <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.6 8.6 0 0 1-3.9-.9L3 21l1.9-5.6A8.4 8.4 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z" />
    </svg>
  );
}

/** Prompts — an open book. */
export function PromptsIcon(): JSX.Element {
  return (
    <svg {...line}>
      <path d="M12 6C10 4.6 6.7 4.6 4 5.2V19c2.7-.6 6-.6 8 .8 2-1.4 5.3-1.4 8-.8V5.2c-2.7-.6-6-.6-8 .8z" />
      <path d="M12 6.8V20.8" />
    </svg>
  );
}

/** Settings — a gear. */
export function SettingsIcon(): JSX.Element {
  return (
    <svg {...line}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** Google Tag Manager — the blue tag mark (two-tone diamond). */
export function GtmLogo(): JSX.Element {
  return (
    <svg width={SZ} height={SZ} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M12 1.4 22.6 12 12 22.6 1.4 12Z" fill="#8AB4F8" />
      <path d="M12 1.4 22.6 12 12 22.6Z" fill="#4285F4" />
    </svg>
  );
}

/** Google Analytics — the orange bar-chart mark. */
export function Ga4Logo(): JSX.Element {
  return (
    <svg width={SZ} height={SZ} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="13" y="2" width="7" height="20" rx="3.5" fill="#F9AB00" />
      <rect x="4" y="9" width="7" height="13" rx="3.5" fill="#E8710A" />
    </svg>
  );
}
