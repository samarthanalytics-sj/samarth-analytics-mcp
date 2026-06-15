import { useStytchMemberSession, StytchB2B, B2BIdentityProvider } from '@stytch/react/b2b';
import {
  AuthFlowType,
  B2BProducts,
  type StytchB2BUIConfig,
} from '@stytch/vanilla-js';

// GTM + GA4 scopes brokered through Google. These must match the consent-screen
// + the resolver's expectations (see docs/PHASE3_IMPLEMENTATION_SPEC.md).
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/tagmanager.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
];

// Key under which we stash the connected-app authorize request across the login
// round-trip (see main.tsx, which saves it before React mounts).
const STORE_KEY = 'mcp_authorize_params';

export function App() {
  const { session } = useStytchMemberSession();

  // The login flow returns to a CLEAN /oauth/authorize (no params). We do NOT
  // stuff the OAuth params into this URL — a nested encoded redirect_uri breaks
  // Stytch's URL parser. Param preservation is handled via sessionStorage.
  const loginRedirectUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/oauth/authorize` : '';

  const loginConfig: StytchB2BUIConfig = {
    products: [B2BProducts.oauth],
    oauthOptions: {
      providers: [
        {
          type: 'google',
          customScopes: GOOGLE_SCOPES,
          // Force Google to issue a refresh token (Stytch vaults it).
          providerParams: { access_type: 'offline', prompt: 'consent' },
        },
      ],
      loginRedirectURL: loginRedirectUrl,
      signupRedirectURL: loginRedirectUrl,
    },
    authFlowType: AuthFlowType.Discovery,
    sessionOptions: { sessionDurationMinutes: 60 },
  };

  // Once the member is logged in, B2BIdentityProvider needs the original
  // authorize request (client_id, code_challenge, state, redirect_uri, scope,
  // resource) in the URL. If the login round-trip dropped them, restore from
  // sessionStorage BEFORE the component mounts and reads window.location.
  if (session && typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('client_id')) {
      const saved = sessionStorage.getItem(STORE_KEY);
      if (saved) {
        window.history.replaceState({}, '', `/oauth/authorize${saved}`);
      }
    }
  }

  return (
    <div className="wrap">
      <h1>Authorize access to your Google Tag Manager</h1>
      <div className="panel">
        {session ? <B2BIdentityProvider /> : <StytchB2B config={loginConfig} />}
      </div>
      <p className="hint">
        Sign in to grant an MCP client read access to your GTM &amp; GA4 via Samarth Analytics.
      </p>
    </div>
  );
}
