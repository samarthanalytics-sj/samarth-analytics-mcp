/**
 * GTM API v2 type definitions
 * Reference: https://developers.google.com/tag-manager/api/v2/reference
 */

export interface GtmAccount {
  accountId: string;
  name: string;
  shareData?: boolean;
  fingerprint?: string;
  tagManagerUrl?: string;
  features?: Record<string, unknown>;
}

export interface GtmContainer {
  accountId: string;
  containerId: string;
  name: string;
  domainName?: string[];
  publicId?: string;
  usageContext?: string[];
  fingerprint?: string;
  tagManagerUrl?: string;
  features?: Record<string, unknown>;
  notes?: string;
}

export interface GtmWorkspace {
  path: string;
  accountId: string;
  containerId: string;
  workspaceId: string;
  name: string;
  description?: string;
  fingerprint?: string;
  tagManagerUrl?: string;
}

export interface GtmTag {
  path?: string;
  accountId: string;
  containerId: string;
  workspaceId: string;
  tagId?: string;
  name: string;
  type: string;
  parameter?: GtmParameter[];
  priority?: GtmParameter;
  firingTriggerId?: string[];
  blockingTriggerId?: string[];
  firingRuleId?: string[];
  blockingRuleId?: string[];
  liveOnly?: boolean;
  fingerprint?: string;
  tagManagerUrl?: string;
  scheduleStartMs?: string;
  scheduleEndMs?: string;
  notes?: string;
  parentFolderId?: string;
  paused?: boolean;
  monitoringMetadata?: GtmParameter;
  monitoringMetadataTagNameKey?: string;
  consentSettings?: {
    consentStatus?: string;
  };
}

export interface GtmTrigger {
  path?: string;
  accountId: string;
  containerId: string;
  workspaceId: string;
  triggerId?: string;
  name: string;
  type: string;
  customEventFilter?: GtmCondition[];
  filter?: GtmCondition[];
  autoEventFilter?: GtmCondition[];
  waitForTags?: GtmParameter;
  checkValidation?: GtmParameter;
  waitForTagsTimeout?: GtmParameter;
  uniqueTriggerId?: GtmParameter;
  eventName?: GtmParameter;
  interval?: GtmParameter;
  limit?: GtmParameter;
  fingerprint?: string;
  tagManagerUrl?: string;
  notes?: string;
  parentFolderId?: string;
  parameter?: GtmParameter[];
  visiblePercentageMin?: GtmParameter;
  visiblePercentageMax?: GtmParameter;
  continuousTimeMinMilliseconds?: GtmParameter;
  totalTimeMinMilliseconds?: GtmParameter;
  selector?: GtmParameter;
  horizontalScrollPercentageList?: GtmParameter;
  verticalScrollPercentageList?: GtmParameter;
  visibilitySelector?: GtmParameter;
}

export interface GtmVariable {
  path?: string;
  accountId: string;
  containerId: string;
  workspaceId: string;
  variableId?: string;
  name: string;
  type: string;
  parameter?: GtmParameter[];
  enablingTriggerId?: string[];
  disablingTriggerId?: string[];
  fingerprint?: string;
  tagManagerUrl?: string;
  notes?: string;
  parentFolderId?: string;
  formatValue?: {
    caseConversionType?: string;
    convertNullToValue?: GtmParameter;
    convertUndefinedToValue?: GtmParameter;
    convertTrueToValue?: GtmParameter;
    convertFalseToValue?: GtmParameter;
  };
  scheduleStartMs?: string;
  scheduleEndMs?: string;
}

export interface GtmFolder {
  path?: string;
  accountId: string;
  containerId: string;
  workspaceId: string;
  folderId?: string;
  name: string;
  fingerprint?: string;
  tagManagerUrl?: string;
  notes?: string;
}

export interface GtmBuiltInVariable {
  path?: string;
  accountId: string;
  containerId: string;
  workspaceId: string;
  type: string;
  name?: string;
}

export interface GtmContainerVersion {
  path?: string;
  accountId: string;
  containerId: string;
  containerVersionId?: string;
  name?: string;
  description?: string;
  container?: GtmContainer;
  tag?: GtmTag[];
  trigger?: GtmTrigger[];
  variable?: GtmVariable[];
  folder?: GtmFolder[];
  builtInVariable?: GtmBuiltInVariable[];
  fingerprint?: string;
  tagManagerUrl?: string;
  deleted?: boolean;
}

export interface GtmContainerVersionHeader {
  path?: string;
  accountId: string;
  containerId: string;
  containerVersionId: string;
  name?: string;
  numTags?: string;
  numTriggers?: string;
  numVariables?: string;
  deleted?: boolean;
}

export interface GtmParameter {
  type: string;
  key?: string;
  value?: string;
  list?: GtmParameter[];
  map?: GtmParameter[];
  isWeakReference?: boolean;
}

export interface GtmCondition {
  type: string;
  parameter: GtmParameter[];
}

export interface GtmWorkspaceProposal {
  fingerprint?: string;
  tagManagerUrl?: string;
  status?: string;
  reviewers?: unknown[];
  authors?: unknown[];
  histories?: unknown[];
}

export interface GtmSyncStatus {
  syncError?: boolean;
  mergeConflict?: GtmMergeConflict[];
}

export interface GtmMergeConflict {
  entityInWorkspace?: GtmEntity;
  entityInBaseVersion?: GtmEntity;
}

export interface GtmEntity {
  tag?: GtmTag;
  trigger?: GtmTrigger;
  variable?: GtmVariable;
  folder?: GtmFolder;
  changeStatus?: string;
}

export interface GtmQuickPreviewResponse {
  compilerError?: boolean;
  syncStatus?: GtmSyncStatus;
  containerVersion?: GtmContainerVersion;
}

export interface GtmPublishResponse {
  compilerError?: boolean;
  containerVersion?: GtmContainerVersion;
}

/** Guardrail configuration derived from environment variables */
export interface GuardrailConfig {
  writesEnabled: boolean;
  publishEnabled: boolean;
  deletesEnabled: boolean;
  dryRun: boolean;
}
