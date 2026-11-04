// The OAuth authorize request this page received, and the bodies it sends to
// Stytch's headless idp.oauthAuthorizeStart / idp.oauthAuthorizeSubmit.
//
// This mirrors parseOAuthAuthorizeParams in @stytch/vanilla-js 5.x, the parser
// behind the prebuilt <B2BIdentityProvider /> that Consent.tsx replaced, so the
// calls carry the same request the prebuilt sent:
//   - no `scope` (or an empty one) falls back to openid/email/profile instead
//     of an empty scope list;
//   - every RFC 8707 `resource` value is forwarded as `resources` to both
//     calls, so the grant is bound to the MCP resource the client named.
// @stytch/core 2.x types B2BOAuthAuthorizeStartOptions / SubmitOptions without
// a `resources` field, but the headless client posts the body unchanged, the
// prebuilt sends `resources` to both endpoints, and Stytch's B2B authorize
// (submit) API documents `resources: string[]`. When the client sends no
// `resource`, the body has no `resources` key at all.
//
// Kept free of React, DOM and SDK imports so it can be unit tested in Node
// (src/__tests__/authorizeRequest.node.test.mjs).

/** The prebuilt's FALLBACK_SCOPES (openid, email, profile). */
export const FALLBACK_SCOPES: readonly string[] = ['openid', 'email', 'profile'];

export type AuthorizeParams = {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  scopes: string[];
  state?: string;
  nonce?: string;
  code_challenge?: string;
  prompt?: string;
  /** RFC 8707 resource indicators, every `resource` value in request order. */
  resources?: string[];
};

export type AuthorizeStartBody = {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  scopes: string[];
  prompt?: string;
  resources?: string[];
};

export type AuthorizeSubmitBody = AuthorizeStartBody & {
  state?: string;
  nonce?: string;
  code_challenge?: string;
  consent_granted: boolean;
};

export function parseAuthorizeParams(search: string): { error: string | null; params: AuthorizeParams } {
  const q = new URLSearchParams(search);
  const get = (k: string) => q.get(k) ?? undefined;
  const scope = get('scope');
  const params: AuthorizeParams = {
    client_id: get('client_id') ?? '',
    redirect_uri: get('redirect_uri') ?? '',
    response_type: get('response_type') ?? 'code',
    scopes: scope ? scope.split(/\s+/).filter(Boolean) : [...FALLBACK_SCOPES],
    state: get('state'),
    nonce: get('nonce'),
    code_challenge: get('code_challenge'),
    prompt: get('prompt'),
  };
  if (q.has('resource')) params.resources = q.getAll('resource');
  const missing = (['client_id', 'redirect_uri'] as const).filter((k) => !params[k]);
  return { error: missing.length ? `Missing ${missing.join(', ')} in the authorization request.` : null, params };
}

/** Body for idp.oauthAuthorizeStart (the consent preflight). */
export function authorizeStartBody(p: AuthorizeParams): AuthorizeStartBody {
  return {
    client_id: p.client_id,
    redirect_uri: p.redirect_uri,
    response_type: p.response_type,
    scopes: p.scopes,
    prompt: p.prompt,
    ...(p.resources ? { resources: p.resources } : {}),
  };
}

/** Body for idp.oauthAuthorizeSubmit: the start body plus state, nonce, PKCE and the decision. */
export function authorizeSubmitBody(p: AuthorizeParams, consentGranted: boolean): AuthorizeSubmitBody {
  return {
    ...authorizeStartBody(p),
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.code_challenge,
    consent_granted: consentGranted,
  };
}
