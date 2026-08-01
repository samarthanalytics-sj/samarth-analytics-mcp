// Reusable "premium" UI primitives shared across views: shimmer skeletons for loading, a polished
// empty state, and the keyboard-shortcuts overlay. Framework-free (inline styles + the .skeleton /
// .overlay-in / .sheet-in classes from global.css) so any view can drop them in.

import { useEffect, type CSSProperties, type ReactNode } from 'react';

/** A single shimmering placeholder block. Size it via width/height (number = px, or any CSS length). */
export function Skeleton({ width = '100%', height = 14, radius = 8, style }: { width?: number | string; height?: number | string; radius?: number; style?: CSSProperties }): JSX.Element {
  return <div className="skeleton" style={{ width, height, borderRadius: radius, ...style }} aria-hidden />;
}

/** A few skeleton lines (last one shorter) - a loading stand-in for a paragraph / list row. */
export function SkeletonText({ lines = 3, gap = 8 }: { lines?: number; gap?: number }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }} aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height={12} width={i === lines - 1 ? '62%' : '100%'} />
      ))}
    </div>
  );
}

/** A loading card matching the app's card metrics - title bar + body lines. */
export function SkeletonCard({ lines = 3 }: { lines?: number }): JSX.Element {
  return (
    <div style={{ background: 'var(--surface-alt)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 16 }}>
      <Skeleton width={160} height={16} style={{ marginBottom: 14 }} />
      <SkeletonText lines={lines} />
    </div>
  );
}

/** A row of loading stat tiles (mirrors a scorecard while numbers load). */
export function SkeletonStats({ count = 4 }: { count?: number }): JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(128px, 1fr))`, gap: 10, margin: '12px 0' }} aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '12px 14px', background: 'var(--surface-alt)' }}>
          <Skeleton width={44} height={26} style={{ marginBottom: 8 }} />
          <Skeleton width="70%" height={11} />
        </div>
      ))}
    </div>
  );
}

/** A polished empty state - big soft icon, title, one-line hint, optional call-to-action. */
export function EmptyState({ icon = '✨', title, hint, action, compact }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode; compact?: boolean }): JSX.Element {
  return (
    <div className="pop-in" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 8, padding: compact ? '24px 16px' : '48px 24px', color: 'var(--text-dim)' }}>
      <div style={{ width: compact ? 44 : 58, height: compact ? 44 : 58, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: compact ? 22 : 28, background: 'var(--surface-3)', border: '1px solid var(--border)' }} aria-hidden>
        {icon}
      </div>
      <div role="heading" aria-level={3} style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{title}</div>
      {hint && <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 380, lineHeight: 1.55 }}>{hint}</div>}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}

const KEY_HINT: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 22, height: 22, padding: '0 6px', borderRadius: 6, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text)', fontSize: 12, fontWeight: 600, fontFamily: 'ui-monospace, monospace' };

/** The keyboard-shortcuts overlay (opened with ?). Closes on Esc / backdrop click / the ✕. */
export function ShortcutsOverlay({ onClose, shortcuts }: { onClose: () => void; shortcuts: Array<{ keys: string[]; label: string }> }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="overlay-in"
      onClick={onClose}
      role="dialog"
      aria-modal
      aria-label="Keyboard shortcuts"
      style={{ position: 'absolute', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(2,6,23,0.42)', backdropFilter: 'blur(2px)' }}
    >
      <div className="sheet-in" onClick={(e) => e.stopPropagation()} style={{ width: 'min(460px, 92%)', maxHeight: '80%', overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 16, boxShadow: '0 20px 60px rgba(2,6,23,0.35)', padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text)' }}>Keyboard shortcuts</div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {shortcuts.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 4px', borderBottom: i < shortcuts.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <span style={{ fontSize: 13.5, color: 'var(--text-dim)' }}>{s.label}</span>
              <span style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }}>
                {s.keys.map((k, j) => <kbd key={j} style={KEY_HINT}>{k}</kbd>)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
