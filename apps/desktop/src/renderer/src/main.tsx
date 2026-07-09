import React from 'react';
import ReactDOM from 'react-dom/client';
// Inter, bundled (embedded woff2 — no network, works fully offline). Weights used across the UI.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './global.css';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { applyTheme, loadTheme } from './theme';

// Apply the saved theme before first paint so there's no flash of the wrong palette.
applyTheme(loadTheme());

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
