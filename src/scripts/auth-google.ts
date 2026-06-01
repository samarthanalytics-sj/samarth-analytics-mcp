#!/usr/bin/env node
/**
 * Browser-based Google OAuth onboarding for the Samarth GTM MCP server.
 *
 * Usage:
 *   npm run auth:google
 *
 * What it does:
 *   1. Starts a tiny localhost HTTP callback server on GOOGLE_OAUTH_CALLBACK_PORT
 *      (default 3001).
 *   2. Generates a Google OAuth authorization URL with the least-privilege GTM
 *      scopes the server actually uses.
 *   3. Opens the URL in your default browser (or prints it if no browser is
 *      available).
 *   4. Captures the `code` from the redirect, exchanges it for tokens, and
 *      writes them to a local gitignored token file (default
 *      `./.gtm-mcp-tokens.json`, override with GTM_MCP_TOKEN_FILE).
 *
 * Requires that GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (or the
 * legacy GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) are set in the environment
 * or in a .env file in the working directory.
 */

import 'dotenv/config';
import http from 'http';
import { URL } from 'url';
import { exec } from 'child_process';
import {
  DEFAULT_REDIRECT_URI,
  buildOAuth2ClientForFlow,
  exchangeCodeForTokens,
  getTokenFilePath,
  resolveOAuthClient,
  ALL_SCOPES,
} from '../auth/googleAuth.js';

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === 'darwin' ? `open "${url}"` :
    platform === 'win32' ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      // Non-fatal — user can copy the URL from stdout.
    }
  });
}

interface ParsedRedirect {
  port: number;
  pathname: string;
  origin: string;
}

function parseRedirect(redirectUri: string): ParsedRedirect {
  const u = new URL(redirectUri);
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    throw new Error(
      `Redirect URI must point to localhost for the browser flow (got ${u.hostname}). ` +
        `Set GOOGLE_OAUTH_REDIRECT_URI to e.g. ${DEFAULT_REDIRECT_URI}.`
    );
  }
  const port = u.port ? parseInt(u.port, 10) : 3001;
  return { port, pathname: u.pathname || '/oauth/callback', origin: u.origin };
}

async function waitForCode(parsed: ParsedRedirect): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.statusCode = 400;
        res.end('Missing URL.');
        return;
      }
      const reqUrl = new URL(req.url, parsed.origin);
      if (reqUrl.pathname !== parsed.pathname) {
        res.statusCode = 404;
        res.end('Not found.');
        return;
      }
      const code = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');
      if (error) {
        res.statusCode = 400;
        res.setHeader('content-type', 'text/html');
        res.end(`<html><body><h1>Authorization failed</h1><p>${escapeHtml(error)}</p></body></html>`);
        server.close();
        reject(new Error(`Authorization error: ${error}`));
        return;
      }
      if (!code) {
        res.statusCode = 400;
        res.end('Missing authorization code.');
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html');
      res.end(
        '<html><body style="font-family: sans-serif; max-width: 480px; margin: 64px auto;">' +
          '<h1>✅ Authorization complete</h1>' +
          '<p>You can close this tab and return to your terminal.</p>' +
          '</body></html>'
      );
      server.close();
      resolve(code);
    });

    server.on('error', reject);
    server.listen(parsed.port, '127.0.0.1', () => {
      // ready
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] as string);
}

async function main(): Promise<void> {
  console.log('=== Samarth GTM MCP — Google OAuth onboarding ===');
  console.log('');

  const creds = resolveOAuthClient();
  if (!creds) {
    console.error(
      'No OAuth client configured. Set one of the following in your .env or environment:\n' +
        '  GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET   (preferred)\n' +
        '  GOOGLE_CLIENT_ID       + GOOGLE_CLIENT_SECRET         (legacy, still supported)\n' +
        '\n' +
        'See README → Friendly Google Auth Options for how to create one in Google Cloud Console.'
    );
    process.exit(1);
  }

  console.log(`OAuth client source : ${creds.source}`);
  console.log(`Redirect URI        : ${creds.redirectUri}`);
  console.log(`Token file (output) : ${getTokenFilePath()}`);
  console.log(`Scopes              :`);
  for (const s of ALL_SCOPES) console.log(`  - ${s}`);
  console.log('');

  let parsed: ParsedRedirect;
  try {
    parsed = parseRedirect(creds.redirectUri);
  } catch (err) {
    console.error(String(err));
    process.exit(1);
    return;
  }

  const oauth2Client = buildOAuth2ClientForFlow();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ALL_SCOPES,
    prompt: 'consent',
  });

  console.log('Opening the Google authorization URL in your browser…');
  console.log('If the browser does not open, copy this URL manually:');
  console.log('');
  console.log(authUrl);
  console.log('');

  const codePromise = waitForCode(parsed);
  openInBrowser(authUrl);

  let code: string;
  try {
    code = await codePromise;
  } catch (err) {
    console.error('Authorization did not complete:', String(err));
    process.exit(1);
    return;
  }

  console.log('Exchanging authorization code for tokens…');
  try {
    const tokens = await exchangeCodeForTokens(code, { persist: true });
    console.log('');
    console.log('Done. Saved refresh_token + access_token to:');
    console.log(`  ${getTokenFilePath()}`);
    console.log('');
    console.log('You can now start the MCP server without setting GOOGLE_ACCESS_TOKEN or');
    console.log('GOOGLE_REFRESH_TOKEN in .env — the server will read them from the token file.');
    if (!tokens.refresh_token) {
      console.log('');
      console.log('⚠ Google did not return a refresh_token. Revoke prior access at');
      console.log('  https://myaccount.google.com/permissions and re-run `npm run auth:google`.');
    }
  } catch (err) {
    console.error('Token exchange failed:', String(err));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
