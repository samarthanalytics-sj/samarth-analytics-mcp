// Google Ads API client: the ONLY module in the Ads feature that touches the network. Everything it
// depends on (URLs, GAQL, header assembly, row mapping, snippet parsing, error shaping) lives in the
// pure siblings ads-rest / ads-map / ads-errors, so the whole decision surface is unit-tested and this
// file stays a thin, injectable orchestration layer.
//
// Why a `request` function is INJECTED rather than imported: production passes
// AccountClientManager.getClient(accountId).request, which is monkey-patched in account-clients.ts to
// turn a dead refresh token into GoogleAuthExpiredError exactly once, drop the cached client, and fire
// onAuthExpired (which clears the vaulted token and raises the renderer's Re-connect banner). A client
// with its own transport (a bare fetch, or the gRPC google-ads-api package) bypasses that chokepoint and
// silently loses all of it. It also keeps this module testable: apps/desktop has no mocking library, so
// every Google fake in this repo is a hand-written object passed as a parameter.

import {
  GAQL,
  adsHeaders,
  createConversionActionBody,
  listAccessibleCustomersUrl,
  mutateConversionActionsUrl,
  normalizeCustomerId,
  searchStreamUrl,
  perfDateClause,
  type PerfRange,
  type CreateConversionActionInput,
} from './ads-rest';
import {
  buildAccountTree,
  mapCampaign,
  mapCampaignPerformance,
  mapConversionAction,
  resolveConversionCustomer,
  sumCampaignPerformance,
  type AdsAccount,
  type AdsCampaign,
  type AdsCampaignPerformance,
  type AdsConversionAction,
  type ConversionCustomer,
} from './ads-map';
import { adsErrorInfo, isAdsScopeGap, type AdsErrorInfo } from './ads-errors';
import { hasAdsScope } from './oauth';

/** The subset of OAuth2Client.request this service needs. Deliberately structural, so the real client
 *  satisfies it without this module importing google-auth-library. */
export type AdsRequest = (opts: {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  data?: unknown;
  responseType?: 'json';
}) => Promise<{ data?: unknown }>;

export interface AdsServiceDeps {
  /** The active account's patched request fn plus the scope string its token actually carries. */
  auth: () => Promise<{ request: AdsRequest; scope: string | null }>;
  /** The operator's developer token, or null when it has not been entered in Settings yet. */
  developerToken: () => string | null;
  /** Injected so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Retries for a RETRYABLE failure (quota, transport, 5xx). Default 3. */
  maxRetries?: number;
}

/** A failure the UI can act on: the shaped message plus the machine-checkable reason. */
export class AdsError extends Error {
  constructor(
    readonly info: AdsErrorInfo,
    /** Set when the account's token simply lacks the adwords scope, which needs a re-connect, not a fix. */
    readonly scopeGap = false,
  ) {
    super(info.remedy ? `${info.message} ${info.remedy}` : info.message);
    this.name = 'AdsError';
  }
}

const NO_TOKEN: AdsErrorInfo = {
  code: 'DEVELOPER_TOKEN_MISSING',
  status: 0,
  retryable: false,
  message: 'No Google Ads developer token is set.',
  remedy: 'Add one in Settings. It comes from a Google Ads MANAGER account under Tools, API Center; a regular Ads account cannot issue one.',
};
const NO_SCOPE: AdsErrorInfo = {
  code: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  status: 0,
  retryable: false,
  message: 'This Google account has not granted Google Ads access.',
  remedy: 'Use "Connect Google Ads" to re-consent. Your Tag Manager and Analytics access is unaffected.',
};

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class GoogleAdsService {
  constructor(private readonly deps: AdsServiceDeps) {}

  /** Whether an Ads call can even be attempted, WITHOUT making one. Both preconditions fail as a 403 at
   *  call time, and a missing scope is NOT invalid_grant, so it would never reach the auth-expired
   *  chokepoint: checking up front is the difference between a clear prompt and a raw stack trace. */
  async readiness(): Promise<{ ready: boolean; reason?: AdsErrorInfo }> {
    if (!this.deps.developerToken()) return { ready: false, reason: NO_TOKEN };
    const { scope } = await this.deps.auth();
    if (!hasAdsScope(scope)) return { ready: false, reason: NO_SCOPE };
    return { ready: true };
  }

  private async call(opts: { url: string; method: 'GET' | 'POST'; body?: unknown; loginCustomerId?: string }): Promise<unknown> {
    const token = this.deps.developerToken();
    if (!token) throw new AdsError(NO_TOKEN);
    const { request, scope } = await this.deps.auth();
    if (!hasAdsScope(scope)) throw new AdsError(NO_SCOPE, true);

    const maxRetries = this.deps.maxRetries ?? 3;
    const sleep = this.deps.sleep ?? realSleep;
    let attempt = 0;
    for (;;) {
      try {
        const res = await request({
          url: opts.url,
          method: opts.method,
          headers: adsHeaders(token, opts.loginCustomerId),
          ...(opts.body === undefined ? {} : { data: opts.body }),
          responseType: 'json',
        });
        return res?.data;
      } catch (e) {
        // Shape FIRST, then decide. Branching on info.retryable rather than on the message is deliberate:
        // a non-retryable failure can still carry Google's own wire text saying "quota exceeded", and a
        // message-driven retry would then back off for ~14s on something that can never succeed.
        const info = adsErrorInfo(e);
        if (info.retryable && attempt < maxRetries) {
          attempt += 1;
          await sleep(Math.min(30_000, 2_000 * 2 ** (attempt - 1))); // 2s, 4s, 8s
          continue;
        }
        throw new AdsError(info, isAdsScopeGap(e));
      }
    }
  }

  /** searchStream answers with an ARRAY of chunks, each { results: [...] }, not a single page. Flatten,
   *  and tolerate a lone object in case a proxy unwraps the stream. */
  private async search(customerId: string, query: string, loginCustomerId?: string): Promise<unknown[]> {
    const data = await this.call({
      url: searchStreamUrl(customerId),
      method: 'POST',
      body: { query },
      loginCustomerId,
    });
    const chunks = Array.isArray(data) ? data : [data];
    const rows: unknown[] = [];
    for (const chunk of chunks) {
      const results = (chunk as { results?: unknown[] } | null)?.results;
      if (Array.isArray(results)) rows.push(...results);
    }
    return rows;
  }

  /** Every account the signed-in user can reach, managers included.
   *
   *  Two calls, not one, and the second is the real probe: listAccessibleCustomers returns only bare
   *  'customers/{id}' resource names for accounts with a DIRECT grant, with no name, no manager flag and
   *  no children. It also succeeds with a Test-level developer token, while every follow-up call against
   *  a production id fails, so a picker built on it alone renders 10-digit numbers and then errors on
   *  click. Resolving names through customer_client is what surfaces that as a real message. */
  async listAccounts(): Promise<AdsAccount[]> {
    const data = await this.call({ url: listAccessibleCustomersUrl(), method: 'GET' });
    const names = (data as { resourceNames?: string[] } | null)?.resourceNames ?? [];
    const seeds = names.map((n) => normalizeCustomerId(String(n).split('/').pop() ?? '')).filter(Boolean);

    const out: AdsAccount[] = [];
    for (const seed of seeds) {
      try {
        // login-customer-id is set to the account being queried THROUGH on each hop. Reusing one root
        // id across a tree yields USER_PERMISSION_DENIED on sub-manager branches.
        const rows = await this.search(seed, GAQL.customerClients, seed);
        out.push(...buildAccountTree(rows, seed));
      } catch (e) {
        // Per-seed isolation: one cancelled or permission-denied account must not empty the picker.
        // Re-throw only when NOTHING resolved, so a token-level failure still surfaces (below).
        if (!(e instanceof AdsError)) throw e;
      }
    }
    if (out.length === 0 && seeds.length > 0) {
      // Every branch failed, which is a token/permission problem rather than an empty account list.
      // Repeat the first call bare so the caller gets the real shaped reason instead of an empty array.
      const rows = await this.search(seeds[0], GAQL.customerClients, seeds[0]);
      return buildAccountTree(rows, seeds[0]);
    }
    return dedupeAccounts(out);
  }

  /** Which customer actually owns this account's conversion actions. Under cross-account conversion
   *  tracking that is a MANAGER, and reading the wrong one yields an empty list on a working account. */
  async conversionCustomer(customerId: string, loginCustomerId?: string): Promise<ConversionCustomer> {
    const rows = await this.search(customerId, GAQL.conversionTrackingSetting, loginCustomerId);
    return resolveConversionCustomer(rows[0] ?? {}, normalizeCustomerId(customerId));
  }

  /** The reuse picker's list, plus where it was read from.
   *
   *  Queried against the CLIENT account, not the conversion customer: a client-account query returns the
   *  manager's cross-account actions AND the client's own, while a conversion-customer-only read is
   *  lossy. The conversion customer is still resolved and returned so the UI can label ownership. */
  async listConversionActions(
    customerId: string,
    loginCustomerId?: string,
  ): Promise<{ actions: AdsConversionAction[]; conversionCustomer: ConversionCustomer }> {
    const cc = await this.conversionCustomer(customerId, loginCustomerId);
    const rows = await this.search(customerId, GAQL.conversionActions, loginCustomerId);
    const actions = rows.map(mapConversionAction).sort((a, b) => a.name.localeCompare(b.name));
    return { actions, conversionCustomer: cc };
  }

  /** Campaign CONFIG (no metrics, so no date range). A MANAGER account has no campaigns of its own,
   *  which is a different thing from an advertiser with none, so the caller is told which it is
   *  rather than being left to read an empty array. */
  async listCampaigns(customerId: string, loginCustomerId?: string): Promise<AdsCampaign[]> {
    const rows = await this.search(customerId, GAQL.campaigns, loginCustomerId);
    return rows.map(mapCampaign);
  }

  /** Per-campaign performance over a window - a trailing `days` count OR an explicit custom date
   *  range (perfDateClause decides, and its label is returned so the tool reports exactly what ran).
   *  The API returns one row per campaign-DAY, so the rows are summed to one per campaign before
   *  they leave this method - handing campaign-days to a caller that expects campaigns inflates
   *  every count by the length of the window. */
  async campaignPerformance(
    customerId: string,
    range: PerfRange = {},
    loginCustomerId?: string,
  ): Promise<{ windowLabel: string; custom: boolean; campaigns: AdsCampaignPerformance[] }> {
    const { label, custom } = perfDateClause(range);
    const rows = await this.search(customerId, GAQL.campaignPerformance(range), loginCustomerId);
    return { windowLabel: label, custom, campaigns: sumCampaignPerformance(rows.map(mapCampaignPerformance)) };
  }

  /** Validate a create WITHOUT executing it, so the review UI can surface a name collision or a bad
   *  category before anything is written to the advertiser's live account. Returns null when valid. */
  async validateConversionAction(customerId: string, input: CreateConversionActionInput, loginCustomerId?: string): Promise<AdsErrorInfo | null> {
    try {
      await this.call({
        url: mutateConversionActionsUrl(customerId),
        method: 'POST',
        body: createConversionActionBody(input, true),
        loginCustomerId,
      });
      return null;
    } catch (e) {
      if (e instanceof AdsError) return e.info;
      throw e;
    }
  }

  /**
   * Create a conversion action and return it WITH its Conversion ID and Label.
   *
   * This is a real, immediately live write to the user's advertising account, unlike the GTM half which
   * only ever touches a draft workspace. The caller is responsible for the confirmation gate.
   *
   * The re-read is not optional: MutateConversionActions returns the resource name only, tag_snippets is
   * an output-only field, and the label exists NOWHERE else in the API. One retry covers the case where
   * the snippet is not populated on the very first read back.
   */
  async createConversionAction(
    customerId: string,
    input: CreateConversionActionInput,
    loginCustomerId?: string,
  ): Promise<AdsConversionAction> {
    const data = await this.call({
      url: mutateConversionActionsUrl(customerId),
      method: 'POST',
      body: createConversionActionBody(input, false),
      loginCustomerId,
    });
    const resourceName = String(
      (data as { results?: Array<{ resourceName?: string }> } | null)?.results?.[0]?.resourceName ?? '',
    );
    if (!resourceName) {
      throw new AdsError({
        code: '',
        status: 0,
        retryable: false,
        message: 'Google Ads created the conversion action but did not return its resource name.',
        remedy: 'Open Google Ads and copy the Conversion ID and Label from the action\'s Tag setup panel.',
      });
    }
    const sleep = this.deps.sleep ?? realSleep;
    for (let attempt = 0; attempt < 2; attempt++) {
      // AND, not WHERE: GAQL.conversionActions already carries a status filter, and a second WHERE is a
      // syntax error rather than a narrower query.
      const rows = await this.search(customerId, `${GAQL.conversionActions} AND conversion_action.resource_name = '${resourceName}'`, loginCustomerId);
      const found = rows.map(mapConversionAction).find((a) => a.resourceName === resourceName);
      if (found && found.conversionId && found.conversionLabel) return found;
      if (found && attempt === 1) return found; // return it anyway; the UI reports the missing snippet
      await sleep(1_500);
    }
    throw new AdsError({
      code: '',
      status: 0,
      retryable: false,
      message: 'The conversion action was created, but Google Ads has not returned its tag snippet yet.',
      remedy: 'Reopen the picker in a moment and select it, or paste the Conversion ID and Label by hand.',
    });
  }
}

/** One row per account id. A client reachable through two managers is returned twice by the tree walk;
 *  prefer the entry that carries a real name so the picker never shows a bare 10-digit id. */
function dedupeAccounts(list: AdsAccount[]): AdsAccount[] {
  const byId = new Map<string, AdsAccount>();
  for (const a of list) {
    const prev = byId.get(a.id);
    if (!prev || (!/^Account \d+$/.test(a.name) && /^Account \d+$/.test(prev.name))) byId.set(a.id, a);
  }
  return [...byId.values()].sort((a, b) => Number(b.manager) - Number(a.manager) || a.name.localeCompare(b.name));
}
