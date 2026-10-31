// Pins a block of Google calls to ONE desktop account. GA4 data and Ads calls authenticate as
// whichever account is ACTIVE at the moment of each call, so a long background monitor sweep that
// outlives an account switch used to query account A's properties with account B's token, then record
// B's "no access" failures as A's issues and post them to A's client Slack channels. A sweep runs its
// work inside runAsAccount(A, ...): every call in that async call tree then authenticates as A, whatever
// the sidebar shows. Outside a pinned block nothing changes - calls follow the active account.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AccountView } from '../../shared/ipc';

const pinned = new AsyncLocalStorage<string>();

/** Run `fn` with every Google call in its async call tree authenticating as `accountId`. */
export function runAsAccount<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  return pinned.run(accountId, fn);
}

export interface AccountViewSource {
  getActiveView(): AccountView | null;
  listViews(): AccountView[];
}

/** The account a Google call made right now must authenticate as: the pinned one inside runAsAccount
 *  (null once that account has been removed), otherwise the active one. */
export function callerAccountView(registry: AccountViewSource): AccountView | null {
  const id = pinned.getStore();
  if (id === undefined) return registry.getActiveView();
  return registry.listViews().find((v) => v.id === id) ?? null;
}
