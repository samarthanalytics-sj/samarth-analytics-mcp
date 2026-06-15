import React from 'react';
import { createRoot } from 'react-dom/client';
import { StytchB2BProvider } from '@stytch/react/b2b';
import { StytchB2BUIClient } from '@stytch/vanilla-js/b2b';
import { App } from './App';

// The publishable client token (safe in the browser). Injected at RUNTIME by
// the MCP server via /oauth/authorize/config.js, so the static bundle is
// token-agnostic and the same build works across environments. Falls back to a
// Vite build-time var for local `vite dev`.
const runtimeCfg = (
  window as unknown as { __MCP_AUTHORIZE_CONFIG__?: { stytchPublicToken?: string } }
).__MCP_AUTHORIZE_CONFIG__;
const publicToken =
  runtimeCfg?.stytchPublicToken ?? import.meta.env.VITE_STYTCH_PUBLIC_TOKEN ?? '';
const stytch = new StytchB2BUIClient(publicToken);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StytchB2BProvider stytch={stytch}>
      <App />
    </StytchB2BProvider>
  </React.StrictMode>
);
