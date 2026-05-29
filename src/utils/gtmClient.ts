/**
 * GTM API v2 client factory.
 * Wraps the googleapis tagmanager v2 client with sensible defaults.
 */

import { google, tagmanager_v2 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

export type GtmClient = tagmanager_v2.Tagmanager;

let _client: GtmClient | null = null;

export function getGtmClient(auth: OAuth2Client): GtmClient {
  if (!_client) {
    _client = google.tagmanager({ version: 'v2', auth });
  }
  return _client;
}

/** Reset client (useful in tests) */
export function resetGtmClient(): void {
  _client = null;
}
