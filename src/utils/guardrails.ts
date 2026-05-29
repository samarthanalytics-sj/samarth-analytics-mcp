/**
 * Guardrail utilities for GTM MCP Server
 *
 * Controls:
 *  - GTM_MCP_ENABLE_WRITES  — gates all create/update operations
 *  - GTM_MCP_ENABLE_PUBLISH — gates publish/version publish
 *  - GTM_MCP_ENABLE_DELETES — gates destructive deletes
 *  - DRY_RUN                — simulate without API calls
 *  - confirm argument       — required on every write/delete/publish tool
 */

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { GuardrailConfig } from '../types/index.js';

export function getGuardrailConfig(): GuardrailConfig {
  return {
    writesEnabled: process.env.GTM_MCP_ENABLE_WRITES === 'true',
    publishEnabled: process.env.GTM_MCP_ENABLE_PUBLISH === 'true',
    deletesEnabled: process.env.GTM_MCP_ENABLE_DELETES === 'true',
    dryRun: process.env.DRY_RUN === 'true',
  };
}

export type OperationType = 'write' | 'delete' | 'publish';

/**
 * Enforce guardrails for a given operation.
 * Throws McpError if the operation is not permitted.
 * Returns true when in dry-run mode (caller should skip the actual API call).
 */
export function checkGuardrails(
  opType: OperationType,
  confirm: boolean | undefined,
  config: GuardrailConfig
): { dryRun: boolean } {
  // confirm=true always required for writes/deletes/publishes
  if (confirm !== true) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `This operation requires confirm=true to proceed. ` +
        `Pass confirm: true in your tool arguments to confirm you want to make this change.`
    );
  }

  if (opType === 'write' && !config.writesEnabled) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Write operations are disabled. Set GTM_MCP_ENABLE_WRITES=true in your .env to enable creates and updates.`
    );
  }

  if (opType === 'delete' && !config.deletesEnabled) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Delete operations are disabled. Set GTM_MCP_ENABLE_DELETES=true in your .env to enable destructive deletes.`
    );
  }

  if (opType === 'publish' && !config.publishEnabled) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Publish operations are disabled. Set GTM_MCP_ENABLE_PUBLISH=true in your .env to enable publishing.`
    );
  }

  return { dryRun: config.dryRun };
}

/**
 * Format a Google API error body into a human-readable string.
 */
export function formatGoogleError(err: unknown): string {
  if (err instanceof Error) {
    // googleapis errors often embed a JSON body in err.message or err.response
    const anyErr = err as unknown as Record<string, unknown>;
    const response = anyErr['response'] as Record<string, unknown> | undefined;
    if (response) {
      const data = response['data'] as Record<string, unknown> | undefined;
      if (data?.['error']) {
        const gErr = data['error'] as Record<string, unknown>;
        const code = gErr['code'] ?? '';
        const message = gErr['message'] ?? err.message;
        const errors = Array.isArray(gErr['errors'])
          ? gErr['errors']
              .map((e: Record<string, unknown>) => `  - ${e['reason']}: ${e['message']}`)
              .join('\n')
          : '';
        return `Google API Error ${code}: ${message}${errors ? '\n' + errors : ''}`;
      }
    }
    return err.message;
  }
  return String(err);
}

/**
 * Validate path-style parameters (accountId, containerId, workspaceId).
 * GTM API paths look like: accounts/123/containers/456/workspaces/789
 */
export function validateId(value: string | undefined, name: string): string {
  if (!value || value.trim() === '') {
    throw new McpError(ErrorCode.InvalidParams, `${name} is required and cannot be empty.`);
  }
  // IDs should be numeric strings; paths are slash-separated numeric segments
  if (!/^[\d/]+$/.test(value.trim())) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${name} "${value}" does not look like a valid GTM ID (expected numeric or path like "123" or "accounts/123/containers/456").`
    );
  }
  return value.trim();
}

/** Build a GTM resource path from components */
export function buildPath(
  accountId: string,
  containerId?: string,
  workspaceId?: string,
  resource?: string,
  resourceId?: string
): string {
  let path = `accounts/${accountId}`;
  if (containerId) path += `/containers/${containerId}`;
  if (workspaceId) path += `/workspaces/${workspaceId}`;
  if (resource) path += `/${resource}`;
  if (resourceId) path += `/${resourceId}`;
  return path;
}
