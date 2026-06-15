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

export function App() {
  const { session } = useStytchMemberSession();

  // The login flow must return to THIS authorize page WITH the original OAuth
  // authorize params (client_id, code_challenge, state, redirect_uri, scope,
  // resource) preserved — otherwise B2BIdentityProvider has no authorization
  // request to consent to and errors. We keep the full URL but strip any Stytch
  // discovery token so a return pass doesn't loop. This base must be allow-listed
  // in the Stytch dashboard (Redirect URLs → Login + Discovery).
  let authorizeUrl = '';
  if (typeof window !== 'undefined') {
    const u = new URL(window.location.href);
    u.searchParams.delete('stytch_token_type');
    u.searchParams.delete('token');
    authorizeUrl = u.toString();
  }

  const loginConfig: StytchB2BUIConfig = {
    products: [B2BProducts.oauth],
    oauthOptions: {
      providers: [
        {
          type: 'google',
          customScopes: GOOGLE_SCOPES,
          // Force Google to issue a refresh token (Stytch vaults it). Mirrors
          // the spike's provider_access_type=offline + provider_prompt=consent.
          providerParams: { access_type: 'offline', prompt: 'consent' },
        },
      ],
      loginRedirectURL: authorizeUrl,
      signupRedirectURL: authorizeUrl,
    },
    authFlowType: AuthFlowType.Discovery,
    sessionOptions: { sessionDurationMinutes: 60 },
  };

  return (
    <div className="wrap">
      <h1>Authorize access to your Google Tag Manager</h1>
      <div className="panel">
        {session ? (
          // Logged in → show the connected-app consent screen.
          <B2BIdentityProvider />
        ) : (
          // Not logged in yet → Google sign-in (discovery), then consent renders.
          <StytchB2B config={loginConfig} />
        )}
      </div>
      <p className="hint">
        Sign in to grant an MCP client read access to your GTM &amp; GA4 via Samarth Analytics.
      </p>
    </div>
  );
}
