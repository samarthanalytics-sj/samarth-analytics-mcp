// How to obtain a Google Ads developer token and what each access level actually buys you.
//
// PURE + framework-free content, in ONE place because it is shown in two: the Ads chat (when the
// token is missing, which is the moment someone needs it) and Settings > Providers (where the token
// is entered). Two hand-written copies of a setup procedure drift, and the drifting half is always
// the one the user reads.
//
// House style: no em dashes anywhere in this file - every string here is user-visible.

/** Where Google documents this. Quotas and the application flow both change, so the app links out
 *  rather than pretending its own copy is authoritative. */
export const ADS_ACCESS_DOCS = 'https://developers.google.com/google-ads/api/docs/access-levels';
export const ADS_API_CENTER_PATH = 'Tools and Settings > Setup > API Center';

export interface AdsSetupStep {
  /** Short imperative title. */
  title: string;
  /** One or two sentences of detail. */
  detail: string;
  /** Set when a step is the one people skip, and skipping it produces a token that looks fine. */
  warning?: string;
}

/** Getting the token out of Google. */
export const ADS_TOKEN_STEPS: AdsSetupStep[] = [
  {
    title: 'Use a Manager (MCC) account',
    detail:
      'Developer tokens are issued only by a Google Ads manager account. A regular advertising account has no ' +
      'API Center at all, so there is nothing to apply from. If you do not have a manager account, create one ' +
      'first and link the accounts you want to reach underneath it.',
  },
  {
    title: `Open ${ADS_API_CENTER_PATH}`,
    detail:
      'Sign in to the manager account in Google Ads and open the API Center. It appears only for manager ' +
      'accounts, so if the menu item is missing you are in the wrong account.',
  },
  {
    title: 'Apply for a token',
    detail:
      'Fill in the API contact details and accept the terms. You are issued a developer token straight away, ' +
      'at TEST access level.',
  },
  {
    title: 'Apply for Basic access',
    detail:
      'From the same API Center page, apply to move from Test to Basic. Google reviews the application, which ' +
      'usually takes a business day or two. Basic is enough for everything this app does.',
    warning:
      'This is the step people skip. A Test-level token is NOT rejected here: listing your accounts still ' +
      'succeeds with one, and every call after that fails. So a connection test that passes is not proof the ' +
      'token is usable. If reads work but nothing else does, you are still on Test.',
  },
  {
    title: 'Copy the developer token',
    detail: 'It is on the API Center page, next to the access level. It is a secret: treat it like a password.',
  },
];

/** Putting it into this app. */
export const ADS_TOKEN_INSTALL_STEPS: AdsSetupStep[] = [
  {
    title: 'Settings > Providers > Google Ads',
    detail: 'Paste the token into the Dev token field and save. It is stored encrypted and never leaves this machine.',
  },
  {
    title: 'Connect Google Ads on this account',
    detail:
      'The token is app-level, but the permission to read an account is granted per Google sign-in. Use Connect ' +
      'Google Ads to add the Ads scope to the account you are signed in as. Your Tag Manager and Analytics access ' +
      'is not affected.',
  },
  {
    title: 'Test the connection',
    detail:
      'The test makes a real API call rather than checking a saved flag, so it reports what Google actually ' +
      'answers. It lists the accounts your sign-in can reach.',
  },
];

export interface AdsAccessLevel {
  level: 'Test' | 'Basic' | 'Standard';
  /** The headline limit, in the terms Google uses. */
  limit: string;
  /** What it means in practice for this app. */
  meaning: string;
  /** Whether this app can do real work with a token at this level. */
  worksHere: boolean;
}

/**
 * The three access levels. Numbers are a guide, not a contract: Google changes quotas, which is why
 * ADS_ACCESS_DOCS is linked next to the table everywhere it is shown.
 *
 * The distinction that actually matters is the first row. Test is not a smaller Basic, it is a
 * different thing: it cannot touch a real advertising account at all.
 */
export const ADS_ACCESS_LEVELS: AdsAccessLevel[] = [
  {
    level: 'Test',
    limit: 'Test accounts only',
    meaning:
      'What you get the moment you apply. It cannot read or change a real advertising account, whatever the ' +
      'daily allowance says. This app will list your accounts and then fail on everything else.',
    worksHere: false,
  },
  {
    level: 'Basic',
    limit: 'About 15,000 operations per day',
    meaning:
      'Real accounts, with a daily cap. A chat session here costs a handful of operations (one per list of ' +
      'accounts, campaigns or conversion actions), so the cap is not something you will meet by using this app.',
    worksHere: true,
  },
  {
    level: 'Standard',
    limit: 'No daily operation cap',
    meaning:
      'Applied for after Basic, and intended for tools running at volume. It changes nothing about what this ' +
      'app can do; Basic already covers it.',
    worksHere: true,
  },
];

/** The one-line answer to "which one do I need", so the table does not have to be read to act. */
export const ADS_ACCESS_SUMMARY =
  'You need at least BASIC access. Test access is issued immediately and looks like success, but it cannot ' +
  'read a real advertising account.';
