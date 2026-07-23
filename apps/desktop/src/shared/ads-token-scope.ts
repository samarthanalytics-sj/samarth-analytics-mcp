// Which Google Ads developer token a given app account uses, and why.
//
// A developer token identifies the APPLICATION to Google, not the user, so one token normally covers
// every Google account signed into this app. That is why the app has shipped a single shared token,
// and why it stays the default: making every account carry its own would be busywork for the common
// case.
//
// The case it does not cover is real, though. An agency operating under a CLIENT's own MCC API
// access uses that client's token, not its own, and those accounts must not be reached with the
// wrong one. Google rejects a token that has no relationship to the account, so a single shared
// token turns into "this account is broken" with no hint that the token is the reason.
//
// So: an OPTIONAL per-account override, with the shared token as the fallback.
//
// PURE + framework-free. The store persists refs; this decides precedence and explains it.

export type AdsTokenSource = 'account' | 'shared' | 'none';

export interface AdsTokenChoice {
  /** Which token to send. null when there is none to send. */
  ref: string | null;
  source: AdsTokenSource;
}

/**
 * Precedence: an account's own token wins, then the shared one, then nothing.
 *
 * An account override is honoured even when it is the ONLY token configured - someone who sets a
 * token for one client and never sets a shared one is expressing intent, not a half-finished setup.
 */
export function resolveAdsToken(input: {
  accountId?: string;
  /** Per-account overrides, keyed by app account id. */
  perAccount?: Readonly<Record<string, string>>;
  /** The app-level token every account falls back to. */
  shared?: string;
}): AdsTokenChoice {
  const own = input.accountId ? input.perAccount?.[input.accountId] : undefined;
  if (own) return { ref: own, source: 'account' };
  if (input.shared) return { ref: input.shared, source: 'shared' };
  return { ref: null, source: 'none' };
}

/**
 * One line for the settings UI saying which token this account is actually using.
 *
 * It names the SOURCE rather than any part of the token: a developer token is a secret, and showing
 * even a prefix of it in a UI that gets screenshotted for support is how it leaks.
 */
export function describeAdsToken(choice: AdsTokenChoice, accountEmail?: string): string {
  const who = accountEmail ? ` for ${accountEmail}` : '';
  switch (choice.source) {
    case 'account':
      return `Using this account's own developer token${who}. The shared token is not used here.`;
    case 'shared':
      return `Using the shared developer token${who}. Set one on this account only if it reaches Google Ads through a different manager account's API access.`;
    default:
      return 'No developer token is set, so Google Ads cannot be reached. Add a shared token in Settings, or one for this account.';
  }
}

/** Whether the whole integration is usable for this account. */
export const hasAdsToken = (choice: AdsTokenChoice): boolean => choice.ref !== null;
