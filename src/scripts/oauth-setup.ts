#!/usr/bin/env node
/**
 * OAuth Setup Helper
 *
 * Guides you through the one-time OAuth authorization flow:
 *   1. Generates authorization URL
 *   2. You visit the URL in a browser and authorize
 *   3. Paste the authorization code back here
 *   4. Tokens are printed — add them to your .env
 *
 * Usage:
 *   npx tsx src/scripts/oauth-setup.ts
 *   -- or after build --
 *   node dist/scripts/oauth-setup.js
 */

import 'dotenv/config';
import readline from 'readline';
import { getOAuthAuthorizationUrl, exchangeCodeForTokens } from '../auth/googleAuth.js';

async function main(): Promise<void> {
  console.log('=== Samarth GTM MCP — OAuth Setup ===');
  console.log('');

  try {
    const authUrl = getOAuthAuthorizationUrl();
    console.log('Step 1: Visit this URL in your browser to authorize access to Google Tag Manager:');
    console.log('');
    console.log(authUrl);
    console.log('');
    console.log('Step 2: After authorizing, Google will redirect to your redirect URI.');
    console.log(
      '        Copy the "code" parameter from the URL (e.g., ?code=4/XXXXXXXX&scope=...).'
    );
    console.log('');
  } catch (err) {
    console.error('Failed to generate authorization URL:', String(err));
    console.error(
      'Make sure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET are set in your .env file.'
    );
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const code = await new Promise<string>((resolve) => {
    rl.question('Paste the authorization code here: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  if (!code) {
    console.error('No code provided. Exiting.');
    process.exit(1);
  }

  try {
    await exchangeCodeForTokens(code);
    console.log('');
    console.log('Step 3: Copy the GOOGLE_ACCESS_TOKEN and GOOGLE_REFRESH_TOKEN values above');
    console.log('        into your .env file. The refresh token is used to auto-renew access.');
  } catch (err) {
    console.error('Token exchange failed:', String(err));
    process.exit(1);
  }
}

main();
