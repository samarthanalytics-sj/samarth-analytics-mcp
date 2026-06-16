import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildAuthUrl,
  buildTokenExchangeBody,
  createPkcePair,
  createState,
  describeGoogleOAuthError,
  parseTokenResponse,
  parseUserinfo,
  DESKTOP_GOOGLE_SCOPES,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
  type GoogleUserinfo,
  type StoredGoogleToken,
} from './oauth';
import type { GoogleOAuthClient } from './oauth-config';

export interface LoopbackDeps {
  /** Open the system browser at the Google auth URL. */
  openBrowser: (url: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  scopes?: string[];
  timeoutMs?: number;
}

export interface LoopbackResult {
  token: StoredGoogleToken;
  userinfo: GoogleUserinfo;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function htmlPage(message: string): string {
  return (
    '<!doctype html><meta charset="utf-8"><title>Samarth Desktop</title>' +
    '<body style="font-family:system-ui;background:#0b0f17;color:#e5e7eb;display:flex;' +
    'height:100vh;align-items:center;justify-content:center;margin:0">' +
    `<div style="text-align:center"><h2>Samarth Desktop</h2><p>${escapeHtml(message)}</p></div></body>`
  );
}

/**
 * Run the full desktop loopback OAuth dance:
 *   1. start an ephemeral 127.0.0.1 server,
 *   2. open the browser to Google (PKCE S256, offline, account chooser),
 *   3. capture the redirect, verify state, exchange the code (+ verifier),
 *   4. fetch userinfo with the access token.
 * Resolves with the vault-ready token + the account's email/name.
 */
export async function runLoopbackOAuth(
  client: GoogleOAuthClient,
  deps: LoopbackDeps
): Promise<LoopbackResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const scopes = deps.scopes ?? DESKTOP_GOOGLE_SCOPES;
  const timeoutMs = deps.timeoutMs ?? 5 * 60_000;

  const { verifier, challenge } = createPkcePair();
  const state = createState();

  return await new Promise<LoopbackResult>((resolve, reject) => {
    const server = http.createServer();
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      action();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('Google sign-in timed out.'))),
      timeoutMs
    );

    server.on('request', (req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== '/callback') {
            res.statusCode = 404;
            res.end('not found');
            return;
          }
          const errParam = url.searchParams.get('error');
          if (errParam) {
            const desc =
              url.searchParams.get('error_description') ??
              url.searchParams.get('error_subtype') ??
              undefined;
            const message = describeGoogleOAuthError(errParam, desc ?? undefined);
            res.end(htmlPage(message));
            finish(() => reject(new Error(message)));
            return;
          }
          const code = url.searchParams.get('code');
          const returnedState = url.searchParams.get('state');
          if (!code || returnedState !== state) {
            res.statusCode = 400;
            res.end(htmlPage('Invalid sign-in response.'));
            finish(() => reject(new Error('OAuth state mismatch or missing authorization code.')));
            return;
          }

          const { port } = server.address() as AddressInfo;
          const redirectUri = `http://127.0.0.1:${port}/callback`;

          const tokenRes = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: buildTokenExchangeBody({
              clientId: client.clientId,
              clientSecret: client.clientSecret,
              code,
              redirectUri,
              codeVerifier: verifier,
            }),
          });
          // Google returns { error, error_description } with a 4xx on failure;
          // parse the JSON so parseTokenResponse can surface a real reason. Fall
          // back to the HTTP status only when the body isn't JSON.
          let tokenJson: unknown;
          try {
            tokenJson = await tokenRes.json();
          } catch {
            throw new Error(`Google token endpoint returned HTTP ${tokenRes.status}.`);
          }
          const token = parseTokenResponse(tokenJson, now());

          const userinfoRes = await fetchImpl(GOOGLE_USERINFO_ENDPOINT, {
            headers: { Authorization: `Bearer ${token.access_token}` },
          });
          if (!userinfoRes.ok) {
            throw new Error(
              `Could not read your Google profile (HTTP ${userinfoRes.status}). ` +
                'The email/profile scope may not have been granted.'
            );
          }
          const userinfo = parseUserinfo(await userinfoRes.json());

          res.end(htmlPage('Signed in. You can close this tab and return to Samarth Desktop.'));
          finish(() => resolve({ token, userinfo }));
        } catch (e) {
          res.statusCode = 500;
          res.end(htmlPage('Something went wrong completing sign-in.'));
          finish(() => reject(e instanceof Error ? e : new Error(String(e))));
        }
      })();
    });

    server.on('error', (e) => finish(() => reject(e)));

    // Bind to loopback only, ephemeral port.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const authUrl = buildAuthUrl({
        clientId: client.clientId,
        redirectUri,
        scopes,
        state,
        codeChallenge: challenge,
      });
      deps.openBrowser(authUrl).catch((e) => finish(() => reject(e)));
    });
  });
}
