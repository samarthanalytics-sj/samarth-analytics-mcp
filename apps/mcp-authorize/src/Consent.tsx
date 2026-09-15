import { useEffect, useMemo, useState } from 'react';
import { useStytchB2BClient } from '@stytch/react/b2b';

// Custom consent step for Stytch Connected Apps.
//
// Why not Stytch's prebuilt <B2BIdentityProvider />: after consent it navigates
// to a redirect URL that Stytch stamps with `iss=stytch.com/<project-id>`
// (RFC 9207). Spec-strict MCP clients (the MCP TypeScript SDK, mcp-remote
// 0.14+, and the clients built on them) require that value to equal the
// issuer in our authorization-server metadata, and RFC 8414 requires THAT to
// equal the URL the metadata was fetched from (https://<this host>). Stytch's
// issuer is not a URL, so no metadata value can satisfy both checks, and every
// such client fails with "Issuer mismatch in authorization response". The
// same clients accept a callback that carries no `iss` at all, so we run the
// identical start/submit calls through the headless client and drop `iss`
// from the redirect before navigating. Nothing else about the flow changes:
// the code, state and PKCE handling stay Stytch's.

type AuthorizeParams = {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  scopes: string[];
  state?: string;
  nonce?: string;
  code_challenge?: string;
  prompt?: string;
};

function parseParams(search: string): { error: string | null; params: AuthorizeParams } {
  const q = new URLSearchParams(search);
  const get = (k: string) => q.get(k) ?? undefined;
  const params: AuthorizeParams = {
    client_id: get('client_id') ?? '',
    redirect_uri: get('redirect_uri') ?? '',
    response_type: get('response_type') ?? 'code',
    scopes: (get('scope') ?? '').split(/\s+/).filter(Boolean),
    state: get('state'),
    nonce: get('nonce'),
    code_challenge: get('code_challenge'),
    prompt: get('prompt'),
  };
  const missing = (['client_id', 'redirect_uri'] as const).filter((k) => !params[k]);
  return { error: missing.length ? `Missing ${missing.join(', ')} in the authorization request.` : null, params };
}

/** Strip RFC 9207's `iss` from the redirect Stytch hands back, then go there. */
function redirectWithoutIss(target: string): void {
  try {
    const u = new URL(target);
    u.searchParams.delete('iss');
    window.location.href = u.toString();
  } catch {
    window.location.href = target;
  }
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; clientName: string; clientLogo?: string; scopes: { scope: string; description: string }[] }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string };

export function Consent() {
  const stytch = useStytchB2BClient();
  const parsed = useMemo(() => parseParams(window.location.search), []);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  const startFields = {
    client_id: parsed.params.client_id,
    redirect_uri: parsed.params.redirect_uri,
    response_type: parsed.params.response_type,
    scopes: parsed.params.scopes,
    prompt: parsed.params.prompt,
  };

  async function submit(consentGranted: boolean): Promise<void> {
    setPhase({ kind: 'submitting' });
    try {
      const res = await stytch.idp.oauthAuthorizeSubmit({
        ...startFields,
        state: parsed.params.state,
        nonce: parsed.params.nonce,
        code_challenge: parsed.params.code_challenge,
        consent_granted: consentGranted,
      });
      redirectWithoutIss(res.redirect_uri);
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  useEffect(() => {
    if (parsed.error) {
      setPhase({ kind: 'error', message: parsed.error });
      return;
    }
    let cancelled = false;
    stytch.idp
      .oauthAuthorizeStart(startFields)
      .then((res) => {
        if (cancelled) return;
        if (!res.consent_required) {
          void submit(true);
          return;
        }
        setPhase({
          kind: 'ready',
          clientName: res.client.client_name,
          clientLogo: res.client.client_logo_url,
          scopes: res.scope_results.map((s) => ({ scope: s.scope, description: s.description })),
        });
      })
      .catch((e: unknown) => {
        if (!cancelled) setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
    // The authorize request is fixed for the lifetime of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase.kind === 'loading' || phase.kind === 'submitting') {
    return <p className="consent-status">{phase.kind === 'loading' ? 'Checking the request…' : 'Redirecting…'}</p>;
  }
  if (phase.kind === 'error') {
    return (
      <div className="consent">
        <p className="consent-error">Could not complete authorization: {phase.message}</p>
        <p className="consent-status">Close this window and start the sign-in again from your MCP client.</p>
      </div>
    );
  }
  return (
    <div className="consent">
      {phase.clientLogo ? <img className="consent-logo" src={phase.clientLogo} alt="" /> : null}
      <p className="consent-title">
        <strong>{phase.clientName || 'An MCP client'}</strong> wants to access your account
      </p>
      {phase.scopes.length > 0 ? (
        <ul className="consent-scopes">
          {phase.scopes.map((s) => (
            <li key={s.scope}>{s.description || s.scope}</li>
          ))}
        </ul>
      ) : null}
      <div className="consent-actions">
        <button type="button" className="consent-deny" onClick={() => void submit(false)}>
          Deny
        </button>
        <button type="button" className="consent-allow" onClick={() => void submit(true)}>
          Allow
        </button>
      </div>
    </div>
  );
}
