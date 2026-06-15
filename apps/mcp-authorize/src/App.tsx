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

  // The login flow must return to THIS authorize page (not a leftover localhost
  // redirect) so it can finish discovery, establish a session, then render the
  // consent screen. This URL must also be allow-listed in the Stytch dashboard
  // (Redirect URLs → Login + Discovery).
  const authorizeUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/oauth/authorize` : '';

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
