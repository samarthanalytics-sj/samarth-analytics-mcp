// Connection status for the Google Ads integration: one place that turns what the service knows into
// what the UI shows, so the chip, the chat bar and any future surface cannot disagree.
//
// PURE + framework-free. The mapping is deliberately NOT re-derived from parts anywhere else: Google
// Ads has several distinct ways of being unusable and they need different remedies, so collapsing
// them to a boolean "connected" is what produces the "it says not connected but I am signed in"
// class of support question.

import type { AdsReadiness, AdsReadinessView } from './ipc';

/**
 * Map a readiness result to what the UI shows.
 *
 * `signedIn` is separate from readiness because a missing Google token is not an Ads problem at all,
 * and telling someone to fix their developer token when they simply have not signed in sends them to
 * the wrong screen entirely.
 */
export function adsStatus(readiness: AdsReadiness | null | undefined, signedIn: boolean): AdsReadinessView {
  if (!signedIn) {
    return {
      state: 'not_signed_in',
      message: 'This account is not signed in to Google.',
      remedy: 'Sign in to Google for this account, then connect Google Ads.',
    };
  }
  if (!readiness) {
    return {
      state: 'error',
      message: 'Could not check the Google Ads connection.',
      remedy: 'Retry; if it keeps failing, check your network and that the developer token is set in Settings.',
    };
  }
  if (readiness.ready) return { state: 'ready' };

  const state: AdsReadinessView['state'] =
    readiness.reason === 'token' ? 'no_developer_token' : readiness.reason === 'scope' ? 'no_scope' : 'error';
  return {
    state,
    // Carry the service's own words rather than restating them here: it knows why, and a second
    // wording of the same failure is how two surfaces start telling the user different things.
    message: readiness.message ?? 'Google Ads is not connected.',
    ...(readiness.remedy ? { remedy: readiness.remedy } : {}),
  };
}

/** Short label for the status chip. */
export function adsStatusLabel(s: AdsReadinessView): string {
  switch (s.state) {
    case 'ready':
      return 'Connected';
    case 'not_signed_in':
      return 'Not signed in';
    case 'no_developer_token':
      return 'Developer token missing';
    case 'no_scope':
      return 'Not connected';
    default:
      return 'Connection error';
  }
}

/** Whether the Ads chat can do anything at all. Used to decide between offering the chat and
 *  offering the fix - never to hide the reason. */
export const adsUsable = (s: AdsReadinessView): boolean => s.state === 'ready';

/** Whether re-consenting through the Google Ads OAuth flow is what would fix this. A missing
 *  developer token is NOT fixed by re-consenting, which is the most common wrong turn here. */
export const adsNeedsConsent = (s: AdsReadinessView): boolean => s.state === 'no_scope';
