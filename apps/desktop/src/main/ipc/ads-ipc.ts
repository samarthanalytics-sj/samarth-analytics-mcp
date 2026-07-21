import { ipcMain } from 'electron';
import type { ProviderKeyStore } from '../storage/provider-keys';
import type { GoogleAdsService } from '../google/ads-service';
import { AdsError } from '../google/ads-service';
import { CONVERSION_CATEGORIES } from '../google/ads-rest';
import { checkPairing } from '../google/ads-pairing';
import type { GoogleDataService } from '../google/data-service';
import type {
  AdsAccountView,
  AdsCategoryOption,
  AdsConversionActionsResult,
  AdsConversionActionView,
  AdsReadiness,
  AdsPairingView,
} from '../../shared/ipc';

// Google Ads: read the account tree and its conversion actions, and (behind an explicit confirm in the
// renderer) create a new conversion action. The point of the whole surface is to obtain a real
// Conversion ID + Label pair so a GTM Google Ads tag can be built without copy-paste.
//
// SECURITY: the developer token never crosses this boundary. `ads:status` returns booleans and prose
// only, matching the invariant documented at the top of shared/ipc.ts. Errors are shaped by
// ads-errors before they leave the main process, so a gaxios error's request config (which carries the
// developer-token header) can never reach the renderer or a log line.

/** Shape an AdsError for the renderer: the readable message plus its remedy, never the raw error. */
function toMessage(e: unknown): string {
  if (e instanceof AdsError) return e.info.remedy ? `${e.info.message} ${e.info.remedy}` : e.info.message;
  return e instanceof Error ? e.message : String(e);
}

export function registerAdsIpc(service: GoogleAdsService, keys: ProviderKeyStore, data: GoogleDataService): void {
  /** Can the Ads surface be used at all? Checked BEFORE any call so a missing token or a missing scope
   *  produces a specific prompt rather than a 403 the auth-expired handler cannot classify. */
  ipcMain.handle('ads:status', async (): Promise<AdsReadiness> => {
    try {
      const r = await service.readiness();
      if (r.ready) return { ready: true };
      const reason = r.reason?.code === 'DEVELOPER_TOKEN_MISSING' ? 'token' : r.reason?.code === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' ? 'scope' : 'other';
      return { ready: false, reason, message: r.reason?.message, remedy: r.reason?.remedy };
    } catch (e) {
      return { ready: false, reason: 'other', message: toMessage(e) };
    }
  });

  ipcMain.handle('ads:hasDeveloperToken', (): boolean => keys.hasAdsDeveloperToken());

  ipcMain.handle('ads:setDeveloperToken', (_e, token: string): boolean => {
    if (typeof token !== 'string' || token.trim().length === 0) throw new Error('Developer token required.');
    keys.setAdsDeveloperToken(token);
    return true;
  });

  ipcMain.handle('ads:clearDeveloperToken', (): boolean => {
    keys.clearAdsDeveloperToken();
    return false;
  });

  ipcMain.handle('ads:listAccounts', async (): Promise<AdsAccountView[]> => {
    try {
      return (await service.listAccounts()) as AdsAccountView[];
    } catch (e) {
      throw new Error(toMessage(e));
    }
  });

  ipcMain.handle('ads:listConversionActions', async (_e, customerId: string, loginCustomerId?: string): Promise<AdsConversionActionsResult> => {
    try {
      const { actions, conversionCustomer } = await service.listConversionActions(customerId, loginCustomerId);
      return {
        actions: actions as AdsConversionActionView[],
        ...(conversionCustomer.isCrossAccount && conversionCustomer.conversionCustomerId
          ? { crossAccountFrom: conversionCustomer.conversionCustomerId }
          : {}),
      };
    } catch (e) {
      throw new Error(toMessage(e));
    }
  });

  /** Dry run: validates a create WITHOUT writing anything, so a duplicate name or a bad category is
   *  caught before the advertiser's live account is touched. Returns null when the create would work. */
  ipcMain.handle('ads:validateConversionAction', async (_e, customerId: string, input: { name: string; category: string; countingType?: string }, loginCustomerId?: string): Promise<string | null> => {
    const info = await service.validateConversionAction(customerId, input, loginCustomerId);
    return info ? (info.remedy ? `${info.message} ${info.remedy}` : info.message) : null;
  });

  /** Creates a conversion action. This is a REAL, immediately live write to the user's Google Ads
   *  account, unlike the GTM half which only ever touches a draft workspace, so the renderer must have
   *  taken an explicit confirmation before invoking this. */
  ipcMain.handle('ads:createConversionAction', async (_e, customerId: string, input: { name: string; category: string; countingType?: string }, loginCustomerId?: string): Promise<AdsConversionActionView> => {
    try {
      return (await service.createConversionAction(customerId, input, loginCustomerId)) as AdsConversionActionView;
    } catch (e) {
      throw new Error(toMessage(e));
    }
  });

  ipcMain.handle('ads:categories', (): AdsCategoryOption[] => CONVERSION_CATEGORIES);

  /** Is this GTM container the right home for the selected Ads account? Read-only, advisory, and it
   *  never blocks: the answer is shown to the user, who decides. Any failure degrades to 'unknown'
   *  rather than surfacing an error, because a pairing HINT must never break the tag flow. */
  ipcMain.handle('ads:checkPairing', async (_e, accountId: string, containerId: string, workspaceId: string, conversionId: string | null, accountName?: string): Promise<AdsPairingView> => {
    try {
      const snap = await data.getGtmContainerSnapshot(accountId, containerId, workspaceId);
      return checkPairing(snap, conversionId, accountName);
    } catch {
      return { verdict: 'unknown', message: '', containerIds: [] };
    }
  });
}
