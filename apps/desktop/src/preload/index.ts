import { contextBridge, ipcRenderer } from 'electron';
import type {
  AccountView,
  AddAccountInput,
  AuditReportView,
  ChatReply,
  ChatStreamEvent,
  ChatTurn,
  CreateTagOutcome,
  Ga4AccountView,
  GoogleClientStatus,
  GoogleProduct,
  GtmAccountView,
  GtmContainerView,
  GtmContext,
  GtmWorkspaceView,
  LlmProvider,
  MonitorAlert,
  MonitorConfig,
  MonitorStatus,
  DiscoverResult,
  ParsedSuggestionsResult,
  ProviderStatus,
  ScanProgressView,
  SecretSelfTest,
  SuggestedTagView,
  TagScanOptions,
  TagScanResult,
} from '../shared/ipc';

// The ONLY surface the renderer can reach in the main process. Every capability
// is an explicit, typed method — never raw ipcRenderer. Each phase adds a
// namespace here: Phase 1 → accounts + secrets; later → google (OAuth), mcp
// (tool calls), llm (chat).
const api = {
  getInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:getInfo'),
  ping: (message: string): Promise<string> => ipcRenderer.invoke('app:ping', message),

  accounts: {
    list: (): Promise<AccountView[]> => ipcRenderer.invoke('accounts:list'),
    getActive: (): Promise<AccountView | null> => ipcRenderer.invoke('accounts:getActive'),
    add: (input: AddAccountInput): Promise<AccountView> => ipcRenderer.invoke('accounts:add', input),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('accounts:remove', id),
    setActive: (id: string): Promise<void> => ipcRenderer.invoke('accounts:setActive', id),
    setLlmConfig: (id: string, provider: LlmProvider, model: string): Promise<AccountView> =>
      ipcRenderer.invoke('accounts:setLlmConfig', id, provider, model),
    setGtmContext: (id: string, ctx: GtmContext): Promise<AccountView> =>
      ipcRenderer.invoke('accounts:setGtmContext', id, ctx),
  },

  // App-level LLM API keys (one per provider, shared by all accounts).
  providers: {
    status: (): Promise<ProviderStatus> => ipcRenderer.invoke('providers:status'),
    setKey: (provider: LlmProvider, key: string): Promise<ProviderStatus> =>
      ipcRenderer.invoke('providers:setKey', provider, key),
    clearKey: (provider: LlmProvider): Promise<ProviderStatus> =>
      ipcRenderer.invoke('providers:clearKey', provider),
  },

  secrets: {
    available: (): Promise<boolean> => ipcRenderer.invoke('secrets:available'),
    selfTest: (): Promise<SecretSelfTest> => ipcRenderer.invoke('secrets:selfTest'),
  },

  google: {
    status: (): Promise<GoogleClientStatus> => ipcRenderer.invoke('google:status'),
    connect: (): Promise<AccountView> => ipcRenderer.invoke('google:connect'),
    disconnect: (id: string): Promise<void> => ipcRenderer.invoke('google:disconnect', id),
  },

  data: {
    listGtmAccounts: (): Promise<GtmAccountView[]> => ipcRenderer.invoke('data:listGtmAccounts'),
    listGtmContainers: (accountId: string): Promise<GtmContainerView[]> =>
      ipcRenderer.invoke('data:listGtmContainers', accountId),
    listGtmWorkspaces: (accountId: string, containerId: string): Promise<GtmWorkspaceView[]> =>
      ipcRenderer.invoke('data:listGtmWorkspaces', accountId, containerId),
    listGa4Accounts: (): Promise<Ga4AccountView[]> => ipcRenderer.invoke('data:listGa4Accounts'),
  },

  llm: {
    chat: (history: ChatTurn[], message: string, product: GoogleProduct): Promise<ChatReply> =>
      ipcRenderer.invoke('llm:chat', history, message, product),

    // Streaming chat. `onEvent` fires for text chunks + tool calls as they arrive;
    // the returned promise resolves with the final reply (or rejects on error).
    chatStream: (
      history: ChatTurn[],
      message: string,
      product: GoogleProduct,
      onEvent: (event: ChatStreamEvent) => void
    ): Promise<ChatReply> => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const listener = (
        _e: unknown,
        payload: { requestId: string } & ChatStreamEvent
      ): void => {
        if (payload?.requestId !== requestId) return;
        const { requestId: _drop, ...event } = payload;
        onEvent(event);
      };
      ipcRenderer.on('llm:chat:event', listener);
      return ipcRenderer
        .invoke('llm:chat:start', requestId, history, message, product)
        .finally(() => ipcRenderer.removeListener('llm:chat:event', listener));
    },

    // Answer a write-confirmation prompt raised during a streaming chat: the
    // (possibly edited) args to apply, or null to decline.
    confirm: (confirmId: string, result: Record<string, unknown> | null): Promise<void> =>
      ipcRenderer.invoke('llm:confirm:respond', confirmId, result),
  },

  // Tag suggestions ("measurement plan from a URL"): scan a site (or paste a
  // gtm_tag_suggestions report) for review, then create the approved ones as
  // GTM drafts via the existing create_gtm_tracking_tag path.
  tags: {
    discover: (url: string): Promise<DiscoverResult> => ipcRenderer.invoke('suggestions:discover', url),
    scanUrls: (urls: string[], opts?: TagScanOptions): Promise<TagScanResult> =>
      ipcRenderer.invoke('suggestions:scanUrls', urls, opts),
    scan: (url: string, opts?: TagScanOptions): Promise<TagScanResult> =>
      ipcRenderer.invoke('suggestions:scan', url, opts),
    // Streaming scan: `onProgress` fires with the running suggestion list after each
    // page; the promise resolves with the final result. Mirrors llm.chatStream.
    scanStream: (
      url: string,
      opts: TagScanOptions | undefined,
      onProgress: (p: ScanProgressView) => void,
    ): Promise<TagScanResult> => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const listener = (_e: unknown, payload: { requestId: string } & ScanProgressView): void => {
        if (payload?.requestId !== requestId) return;
        const { requestId: _drop, ...p } = payload;
        onProgress(p);
      };
      ipcRenderer.on('suggestions:scan:event', listener);
      return ipcRenderer
        .invoke('suggestions:scanStream', requestId, url, opts)
        .finally(() => ipcRenderer.removeListener('suggestions:scan:event', listener));
    },
    scanUrlsStream: (
      urls: string[],
      opts: TagScanOptions | undefined,
      onProgress: (p: ScanProgressView) => void,
    ): Promise<TagScanResult> => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const listener = (_e: unknown, payload: { requestId: string } & ScanProgressView): void => {
        if (payload?.requestId !== requestId) return;
        const { requestId: _drop, ...p } = payload;
        onProgress(p);
      };
      ipcRenderer.on('suggestions:scan:event', listener);
      return ipcRenderer
        .invoke('suggestions:scanUrlsStream', requestId, urls, opts)
        .finally(() => ipcRenderer.removeListener('suggestions:scan:event', listener));
    },
    fromJson: (json: string): Promise<ParsedSuggestionsResult> =>
      ipcRenderer.invoke('suggestions:fromJson', json),
    // EXPERIMENTAL: single-page AI scan — screenshot + OpenAI vision picks the tags.
    aiScan: (url: string, opts?: TagScanOptions): Promise<TagScanResult> =>
      ipcRenderer.invoke('suggestions:aiScan', url, opts),
    // Save the (renderer-built) template CSV to a user-chosen file → saved path or null.
    exportCsv: (defaultName: string, csv: string): Promise<string | null> =>
      ipcRenderer.invoke('suggestions:exportCsv', defaultName, csv),
    // The container's existing tag names + whether a GA4 base tag is present, to mark
    // suggestions that already exist (so they aren't re-created).
    existing: (accountId: string, containerId: string, workspaceId: string): Promise<{ names: string[]; hasGa4Base: boolean }> =>
      ipcRenderer.invoke('suggestions:existing', accountId, containerId, workspaceId),
    createTags: (
      accountId: string,
      containerId: string,
      workspaceId: string,
      suggestions: SuggestedTagView[]
    ): Promise<CreateTagOutcome[]> =>
      ipcRenderer.invoke('suggestions:createTags', accountId, containerId, workspaceId, suggestions),
  },

  // Container audit: surface the existing audit engine + its fixes as a panel.
  gtm: {
    audit: (accountId: string, containerId: string, workspaceId: string): Promise<AuditReportView> =>
      ipcRenderer.invoke('gtm:audit', accountId, containerId, workspaceId),
    applyFix: (fix: { tool: string; args: Record<string, unknown> }): Promise<unknown> =>
      ipcRenderer.invoke('gtm:applyFix', fix),
    ensureGa4Config: (ctx: {
      accountId: string;
      containerId: string;
      workspaceId: string;
      measurementId?: string;
      variableName?: string;
      tagName?: string;
    }): Promise<{ created: boolean; present: boolean; existingTag?: string; variableCreated?: boolean; variableName: string; measurementId: string; tagName: string }> =>
      ipcRenderer.invoke('gtm:ensureGa4Config', ctx),
  },

  // Continuous monitoring: schedule auto re-audits of the active container and
  // receive an alert when NEW issues appear.
  monitor: {
    status: (): Promise<MonitorStatus> => ipcRenderer.invoke('monitor:status'),
    configure: (patch: Partial<MonitorConfig>): Promise<MonitorStatus> =>
      ipcRenderer.invoke('monitor:configure', patch),
    runNow: (): Promise<MonitorAlert | null> => ipcRenderer.invoke('monitor:runNow'),
    // Subscribe to pushed alerts; returns an unsubscribe function.
    onAlert: (cb: (alert: MonitorAlert) => void): (() => void) => {
      const listener = (_e: unknown, alert: MonitorAlert): void => cb(alert);
      ipcRenderer.on('monitor:alert', listener);
      return () => ipcRenderer.removeListener('monitor:alert', listener);
    },
  },
};

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
}

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld('desktop', api);
