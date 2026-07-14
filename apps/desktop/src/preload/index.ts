import { contextBridge, ipcRenderer } from 'electron';
import type {
  AccountView,
  AddAccountInput,
  AuditReportView,
  ServerCoverageView,
  WorkspaceCompareResultView,
  ServerContainerResultView,
  ChatReply,
  ChatStreamEvent,
  ChatTurn,
  CreateTagOutcome,
  Ga4AccountView,
  Ga4AuditWindow,
  Ga4ExecSummaryView,
  Ga4PropertyAuditResult,
  Ga4PropertyListItem,
  Ga4SectionsView,
  Ga4VisualsView,
  GoogleClientStatus,
  GoogleProduct,
  GtmAccountView,
  GtmContainerView,
  Ga4Context,
  GtmContext,
  GtmWorkspaceView,
  LlmProvider,
  MonitorAlert,
  MonitorConfig,
  MonitorStatus,
  NetworkLocationView,
  Ga4MonitorConfig,
  Ga4MonitorStatus,
  Ga4MonitorRun,
  DiscoverResult,
  ParsedSuggestionsResult,
  ProviderStatus,
  ScanProgressView,
  SecretSelfTest,
  SuggestedTagView,
  TagScanOptions,
  TagScanResult,
  VerifyTagInput,
  VerifyTagsOptions,
  VerifyTagsResult,
  VerifyExportPayload,
  VerifyProgressView,
  FormsForFillOptions,
  FormsForFillResult,
  FormTagVerifyPlanOptions,
  FormTagVerifyPlanResult,
  SubmitFormInputView,
  SubmitFormVerifyOptions,
  SubmitFormVerifyResult,
  DetectedElementView,
  SuggestionScreenshotResult,
} from '../shared/ipc';

// Tracks the in-flight streaming chat so llm.stop() can abort the right one.
let activeChatRequestId: string | null = null;

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
    // Rename the account's sidebar label; an empty name restores the Google profile name/email.
    rename: (id: string, name: string): Promise<AccountView> => ipcRenderer.invoke('accounts:rename', id, name),
    setLlmConfig: (id: string, provider: LlmProvider, model: string): Promise<AccountView> =>
      ipcRenderer.invoke('accounts:setLlmConfig', id, provider, model),
    setGtmContext: (id: string, ctx: GtmContext): Promise<AccountView> =>
      ipcRenderer.invoke('accounts:setGtmContext', id, ctx),
    setGa4Context: (id: string, ctx: Ga4Context): Promise<AccountView> =>
      ipcRenderer.invoke('accounts:setGa4Context', id, ctx),
    // Fired when the chat switches the active GTM context — re-fetch to update the bar.
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on('accounts:changed', listener);
      return () => ipcRenderer.removeListener('accounts:changed', listener);
    },
    // Fired when an account's Google refresh token is rejected (expired/revoked) — the
    // token has been cleared; the renderer raises a "Re-connect Google" prompt for it.
    onAuthExpired: (cb: (p: { id: string }) => void): (() => void) => {
      const listener = (_e: unknown, p: { id: string }): void => cb(p);
      ipcRenderer.on('account:auth-expired', listener);
      return () => ipcRenderer.removeListener('account:auth-expired', listener);
    },
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
    cancelConnect: (): Promise<void> => ipcRenderer.invoke('google:cancelConnect'),
    disconnect: (id: string): Promise<void> => ipcRenderer.invoke('google:disconnect', id),
  },

  data: {
    listGtmAccounts: (): Promise<GtmAccountView[]> => ipcRenderer.invoke('data:listGtmAccounts'),
    listGtmContainers: (accountId: string): Promise<GtmContainerView[]> =>
      ipcRenderer.invoke('data:listGtmContainers', accountId),
    listGtmWorkspaces: (accountId: string, containerId: string): Promise<GtmWorkspaceView[]> =>
      ipcRenderer.invoke('data:listGtmWorkspaces', accountId, containerId),
    listGa4Accounts: (): Promise<Ga4AccountView[]> => ipcRenderer.invoke('data:listGa4Accounts'),
    // Revert the last chat query's GTM writes.
    peekLastChange: (): Promise<{ count: number; labels: string[] }> =>
      ipcRenderer.invoke('gtm:peekLastChange'),
    revertLastChange: (): Promise<{ reverted: string[]; failed: Array<{ label: string; error: string }> }> =>
      ipcRenderer.invoke('gtm:revertLastChange'),
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
      activeChatRequestId = requestId;
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
        .finally(() => {
          ipcRenderer.removeListener('llm:chat:event', listener);
          if (activeChatRequestId === requestId) activeChatRequestId = null;
        });
    },

    // Stop the in-flight streaming chat (abort the provider request + decline any
    // pending approval). No-op if nothing is running.
    stop: (): Promise<void> =>
      activeChatRequestId ? ipcRenderer.invoke('llm:chat:stop', activeChatRequestId) : Promise.resolve(),

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
    // Locate-only proof screenshots for the creatable suggestions (each tag's CTA/form ringed on its
    // page). Reuses the verify driver; never clicks/submits. Returns a JPEG data-URI per tag.
    screenshotTags: (url: string, tags: SuggestedTagView[]): Promise<SuggestionScreenshotResult> =>
      ipcRenderer.invoke('suggestions:screenshotTags', url, tags),
    /** Live per-tag progress while proof screenshots are being captured; returns an unsubscribe. */
    onShotProgress: (cb: (p: { done: number; total: number; label: string; page: string }) => void): (() => void) => {
      const listener = (_e: unknown, p: { done: number; total: number; label: string; page: string }): void => cb(p);
      ipcRenderer.on('suggestions:shotProgress', listener);
      return () => ipcRenderer.removeListener('suggestions:shotProgress', listener);
    },
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
    // Save the (renderer-built) template CSV to a user-chosen file → saved path or null.
    exportCsv: (defaultName: string, csv: string): Promise<string | null> =>
      ipcRenderer.invoke('suggestions:exportCsv', defaultName, csv),
    // Save the (renderer-built) install runbook to a user-chosen file (Markdown or PDF) → saved path or null.
    exportRunbook: (defaultName: string, markdown: string, format?: 'md' | 'pdf'): Promise<string | null> =>
      ipcRenderer.invoke('suggestions:exportRunbook', defaultName, markdown, format),
    // The container's existing tag names + whether a GA4 base tag is present, to mark
    // suggestions that already exist (so they aren't re-created).
    existing: (accountId: string, containerId: string, workspaceId: string): Promise<{ names: string[]; hasGa4Base: boolean }> =>
      ipcRenderer.invoke('suggestions:existing', accountId, containerId, workspaceId),
    // Verify FIRING: inject the pasted (preview) container, drive each tag's trigger,
    // and report fired/not-fired + a corrected trigger. Never delivers a real hit.
    verify: (
      url: string,
      tags: VerifyTagInput[],
      elements: DetectedElementView[],
      opts?: VerifyTagsOptions,
      onProgress?: (p: VerifyProgressView) => void,
    ): Promise<VerifyTagsResult> => {
      // Correlate the live progress stream (suggestions:verify:event) to THIS call, mirroring scanStream.
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const listener = (_e: unknown, payload: { requestId: string } & VerifyProgressView): void => {
        if (payload?.requestId !== requestId) return;
        const { requestId: _drop, ...p } = payload;
        onProgress?.(p);
      };
      if (onProgress) ipcRenderer.on('suggestions:verify:event', listener);
      return ipcRenderer
        .invoke('suggestions:verifyTags', requestId, url, tags, elements, opts)
        .finally(() => { if (onProgress) ipcRenderer.removeListener('suggestions:verify:event', listener); });
    },
    // Stop the in-flight verify scan/drive (the Stop button). The crawl + Tag-Assistant drive finish the
    // current page and resolve with a partial result; the renderer also stops the orchestration.
    cancelVerify: (): Promise<void> => ipcRenderer.invoke('suggestions:cancelVerify'),
    // Save the tag-verification RESULTS table to a user-chosen file — 'xlsx' (spreadsheet with embedded
    // proof images), 'pdf' or 'doc' (a styled report with each tag's proof screenshot). Returns path or null.
    exportVerifyResults: (format: 'xlsx' | 'pdf' | 'doc', defaultName: string, payload: VerifyExportPayload): Promise<string | null> =>
      ipcRenderer.invoke('verify:exportResults', format, defaultName, payload),
    // Real-submit form review: read a page's forms + their OWN fields, return a locale fill plan the
    // operator edits before Phase 2 submits. Read-only (fills/submits nothing).
    formsForFill: (url: string, opts?: FormsForFillOptions): Promise<FormsForFillResult> =>
      ipcRenderer.invoke('suggestions:formsForFill', url, opts),
    // Container-tag-driven plan: crawl a site, keep only forms that HAVE a container tag, de-dup their
    // fields into one data-entry set. Read-only. onProgress streams the crawl (this now scans the whole site).
    formTagVerifyPlan: (
      url: string,
      opts: FormTagVerifyPlanOptions,
      onProgress?: (p: VerifyProgressView) => void,
    ): Promise<FormTagVerifyPlanResult> => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const listener = (_e: unknown, payload: { requestId: string } & VerifyProgressView): void => {
        if (payload?.requestId !== requestId) return;
        const { requestId: _drop, ...p } = payload;
        onProgress?.(p);
      };
      if (onProgress) ipcRenderer.on('suggestions:formPlan:event', listener);
      return ipcRenderer
        .invoke('suggestions:formTagVerifyPlan', requestId, url, opts)
        .finally(() => { if (onProgress) ipcRenderer.removeListener('suggestions:formPlan:event', listener); });
    },
    // Phase 2 — REAL submit: fill the reviewed values + submit one form for real; reports the analytics
    // events it fired. The form POST is delivered (a real lead); analytics hits are captured, not sent.
    submitFormAndVerify: (
      url: string,
      input: SubmitFormInputView,
      opts?: SubmitFormVerifyOptions,
    ): Promise<SubmitFormVerifyResult> => ipcRenderer.invoke('suggestions:submitFormAndVerify', url, input, opts),
    // Auto-mint a workspace-preview snippet (create version + preview environment) so
    // Verify firing can load DRAFT tags without a manual paste. Draft-level writes only.
    mintPreview: (
      accountId: string,
      containerId: string,
      workspaceId: string,
    ): Promise<{ snippet: string; versionId: string; environmentName: string; newWorkspaceId: string }> =>
      ipcRenderer.invoke('suggestions:mintPreview', accountId, containerId, workspaceId),
    createTags: (
      accountId: string,
      containerId: string,
      workspaceId: string,
      suggestions: SuggestedTagView[],
      onProgress?: (p: { done: number; total: number }) => void,
    ): Promise<CreateTagOutcome[]> => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const listener = (_e: unknown, payload: { requestId: string; done: number; total: number }): void => {
        if (payload?.requestId !== requestId) return;
        onProgress?.({ done: payload.done, total: payload.total });
      };
      if (onProgress) ipcRenderer.on('suggestions:createTags:event', listener);
      return ipcRenderer
        .invoke('suggestions:createTags', requestId, accountId, containerId, workspaceId, suggestions)
        .finally(() => ipcRenderer.removeListener('suggestions:createTags:event', listener));
    },
    // Create ONE Custom HTML listener tag from a suggestion's install plan as a
    // DRAFT (the "How to install" panel's Create-listener-tag button). Same draft-
    // only/no-publish path as createTags; on explicit user click only.
    createListenerTag: (
      accountId: string,
      containerId: string,
      workspaceId: string,
      listener: { name: string; html: string },
    ): Promise<CreateTagOutcome> =>
      ipcRenderer.invoke('suggestions:createListenerTag', accountId, containerId, workspaceId, listener),
  },

  // Container audit: surface the existing audit engine + its fixes as a panel.
  gtm: {
    auditServer: (accountId: string, containerId: string, workspaceId: string): Promise<AuditReportView> =>
      ipcRenderer.invoke('gtm:auditServer', accountId, containerId, workspaceId),
    serverCoverage: (accountId: string, webContainerId: string, webWorkspaceId: string, serverContainerId: string, serverWorkspaceId: string): Promise<ServerCoverageView> =>
      ipcRenderer.invoke('gtm:serverCoverage', accountId, webContainerId, webWorkspaceId, serverContainerId, serverWorkspaceId),
    audit: (accountId: string, containerId: string, workspaceId: string): Promise<AuditReportView> =>
      ipcRenderer.invoke('gtm:audit', accountId, containerId, workspaceId),
    // The container's EXISTING GA4/base tags translated into verify-engine inputs, so
    // "Verify firing" can prove the already-created tags fire (+ which were skipped).
    verifiableTags: (
      accountId: string,
      containerId: string,
      workspaceId: string,
    ): Promise<{ tags: VerifyTagInput[]; skipped: Array<{ tagId: string; name: string; reason: string }> }> =>
      ipcRenderer.invoke('gtm:verifiableTags', accountId, containerId, workspaceId),
    applyFix: (fix: { tool: string; args: Record<string, unknown> }): Promise<unknown> =>
      ipcRenderer.invoke('gtm:applyFix', fix),
    // Repair a created tag's firing trigger to a corrected shape (Verify firing auto-heal). Draft-only.
    retargetTrigger: (ctx: {
      accountId: string;
      containerId: string;
      workspaceId: string;
      tagName: string;
      trigger: SuggestedTagView['trigger'];
    }): Promise<{ tagName: string; triggerId: string; mode: 'rewrite' | 'rebind'; triggerName: string }> =>
      ipcRenderer.invoke('gtm:retargetTrigger', ctx),
    // Align a GA4 Event tag's Event Name to an observed value (verify "align event name" fix). Draft-only.
    setTagEventName: (ctx: {
      accountId: string;
      containerId: string;
      workspaceId: string;
      tagName: string;
      eventName: string;
    }): Promise<{ tagName: string; eventName: string }> =>
      ipcRenderer.invoke('gtm:setTagEventName', ctx),
    exportAudit: (defaultName: string, content: string): Promise<string | null> =>
      ipcRenderer.invoke('gtm:exportAudit', defaultName, content),
    // Save the audit as a styled PDF that mirrors the panel (severity cards, icons, type labels).
    exportAuditPdf: (defaultName: string, report: AuditReportView, meta: { account?: string; container?: string; workspace?: string; generatedAt?: string }): Promise<string | null> =>
      ipcRenderer.invoke('gtm:exportAuditPdf', defaultName, report, meta),
    // Workspace Comparison: diff 2+ workspaces in the same container (read-only) + export the comparison.
    compareWorkspaces: (accountId: string, containerId: string, workspaceIds: string[]): Promise<WorkspaceCompareResultView> =>
      ipcRenderer.invoke('gtm:compareWorkspaces', accountId, containerId, workspaceIds),
    exportWorkspaceDiff: (defaultName: string, content: string): Promise<string | null> =>
      ipcRenderer.invoke('gtm:exportWorkspaceDiff', defaultName, content),
    exportWorkspaceDiffPdf: (defaultName: string, result: WorkspaceCompareResultView): Promise<string | null> =>
      ipcRenderer.invoke('gtm:exportWorkspaceDiffPdf', defaultName, result),
    // Native Excel (.xlsx) — Summary + Common + Uncommon + Detailed-diff sheets with full config values.
    exportWorkspaceDiffXlsx: (defaultName: string, result: WorkspaceCompareResultView): Promise<string | null> =>
      ipcRenderer.invoke('gtm:exportWorkspaceDiffXlsx', defaultName, result),
    ensureGa4Config: (ctx: {
      accountId: string;
      containerId: string;
      workspaceId: string;
      measurementId?: string;
      variableName?: string;
      tagName?: string;
    }): Promise<{ created: boolean; present: boolean; existingTag?: string; variableCreated?: boolean; variableName: string; measurementId: string; tagName: string }> =>
      ipcRenderer.invoke('gtm:ensureGa4Config', ctx),
    // Create a complete SERVER container FROM a web container (+ optionally wire a server URL).
    createServerContainer: (ctx: {
      accountId: string;
      webContainerId: string;
      name: string;
      serverUrl?: string;
    }): Promise<ServerContainerResultView> => ipcRenderer.invoke('gtm:createServerContainer', ctx),
  },

  // GA4 Audit panel: list GA4 properties (picker) + run a read-only config +
  // data-quality audit on a chosen property/window.
  ga4: {
    listProperties: (): Promise<Ga4PropertyListItem[]> => ipcRenderer.invoke('ga4:listProperties'),
    // window: trailing-day count (number) OR an explicit { startDate, endDate } custom range.
    audit: (property: string, window: Ga4AuditWindow): Promise<Ga4PropertyAuditResult> =>
      ipcRenderer.invoke('ga4:audit', property, window),
    // Save the audit report to a user-chosen file as Markdown / PDF / Word (.doc) → saved path, or
    // null if cancelled. `content` is the report Markdown; PDF/DOC lead with the designed Executive
    // Summary rendered from `exec`, then the markdown body.
    exportReport: (format: 'md' | 'pdf' | 'doc', defaultName: string, content: string, exec: Ga4ExecSummaryView | null, visuals: Ga4VisualsView | null, sections: Ga4SectionsView | null): Promise<string | null> =>
      ipcRenderer.invoke('ga4:exportReport', format, defaultName, content, exec, visuals, sections),
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

  // GA4 Monitoring: schedule background health checks of a LIST of GA4 properties (data flow, key
  // events, spikes/drops, revenue integrity) and receive a run per property whenever a sweep
  // completes; new issues can be posted to a per-account Slack webhook.
  ga4monitoring: {
    status: (): Promise<Ga4MonitorStatus> => ipcRenderer.invoke('ga4monitoring:status'),
    configure: (patch: Partial<Ga4MonitorConfig>): Promise<Ga4MonitorStatus> =>
      ipcRenderer.invoke('ga4monitoring:configure', patch),
    /** Run one property on demand, or (no arg) sweep all enabled properties. */
    runNow: (propertyId?: string): Promise<Ga4MonitorRun[]> => ipcRenderer.invoke('ga4monitoring:runNow', propertyId),
    /** Connect a webhook: the account DEFAULT channel (no propertyId) or a property's OWN channel. */
    setWebhook: (url: string, propertyId?: string): Promise<Ga4MonitorStatus> => ipcRenderer.invoke('ga4monitoring:setWebhook', url, propertyId),
    clearWebhook: (propertyId?: string): Promise<Ga4MonitorStatus> => ipcRenderer.invoke('ga4monitoring:clearWebhook', propertyId),
    /** Test the default channel, or (with propertyId) that property's effective channel. */
    sendTest: (propertyId?: string): Promise<{ ok: boolean; error: string | null }> => ipcRenderer.invoke('ga4monitoring:sendTest', propertyId),
    // Save the property's latest run to disk; resolves with the path, or null when cancelled.
    exportRun: (propertyId: string, format: 'pdf' | 'csv'): Promise<string | null> =>
      ipcRenderer.invoke('ga4monitoring:exportRun', propertyId, format),
    // Subscribe to pushed runs (background + on-demand); returns an unsubscribe function.
    onRun: (cb: (run: Ga4MonitorRun) => void): (() => void) => {
      const listener = (_e: unknown, run: Ga4MonitorRun): void => cb(run);
      ipcRenderer.on('ga4monitoring:run', listener);
      return () => ipcRenderer.removeListener('ga4monitoring:run', listener);
    },
  },

  // Network & Location: the public egress location (IP, country/region/city, VPN/proxy verdict + provider)
  // the app's website audits, form submissions and click events run from. getLocation is cached (60s);
  // refreshLocation forces a fresh check (the Refresh button, or after switching VPN server).
  network: {
    getLocation: (): Promise<NetworkLocationView> => ipcRenderer.invoke('network:getLocation'),
    refreshLocation: (): Promise<NetworkLocationView> => ipcRenderer.invoke('network:refreshLocation'),
    // Auto-detect: when on, the main process watches for network changes (VPN connect/disconnect or
    // server switch) and pushes the new location via onChange. Persisted; default off.
    getAutoDetect: (): Promise<boolean> => ipcRenderer.invoke('network:getAutoDetect'),
    setAutoDetect: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('network:setAutoDetect', enabled),
    // Subscribe to pushed location changes (only fire while auto-detect is on); returns an unsubscribe fn.
    onChange: (cb: (view: NetworkLocationView) => void): (() => void) => {
      const listener = (_e: unknown, view: NetworkLocationView): void => cb(view);
      ipcRenderer.on('network:changed', listener);
      return () => ipcRenderer.removeListener('network:changed', listener);
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
