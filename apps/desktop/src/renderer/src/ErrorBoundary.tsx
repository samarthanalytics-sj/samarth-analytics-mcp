import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
  error: unknown;
}

// Catches render-time exceptions anywhere in the tree so one bad component shows a recoverable
// panel instead of white-screening the whole app. (A single undefined prop used to take the
// entire window down - see the Markdown guard.) `error` is typed `unknown` because React passes
// the thrown value verbatim, which is not guaranteed to be an Error; a separate `hasError` flag
// avoids mis-reading a falsy throw (e.g. throw 0) as "no error".
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Renderer error caught by ErrorBoundary:', error, info.componentStack);
  }

  render(): ReactNode {
    const { hasError, error } = this.state;
    if (!hasError) return this.props.children;
    const message = error instanceof Error ? error.message : String(error);
    return (
      <div
        style={{
          maxWidth: 640,
          margin: '48px auto',
          padding: 24,
          background: 'var(--surface, #1b1b1f)',
          border: '1px solid var(--c-red-border, #b4232a)',
          borderRadius: 10,
          color: 'var(--text, #e6e6e6)',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          lineHeight: 1.5,
        }}
      >
        <h2 style={{ marginTop: 0, color: 'var(--c-red, #ff6b6b)' }}>Something went wrong</h2>
        <p>This view hit an unexpected error and was stopped before it could blank the app.</p>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'var(--bg, #111)',
            padding: 12,
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          {message}
        </pre>
        <p style={{ fontSize: 13, color: 'var(--text-muted, #9a9a9a)' }}>
          If you just pulled new code, fully close the app and restart <code>npm run dev</code> - the
          Electron main process doesn&rsquo;t hot-reload, so its data can be out of sync with the UI.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 14px',
              borderRadius: 6,
              border: 'none',
              background: 'var(--c-blue, #2563eb)',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '8px 14px',
              borderRadius: 6,
              border: '1px solid var(--border, #444)',
              background: 'transparent',
              color: 'var(--text, #e6e6e6)',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
