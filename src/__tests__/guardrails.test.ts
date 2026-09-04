/**
 * Tests for guardrail utilities
 */

import { describe, it, expect } from '@jest/globals';
import { checkGuardrails, formatGoogleError, buildPath } from '../utils/guardrails.js';
import type { GuardrailConfig } from '../types/index.js';

const readOnlyConfig: GuardrailConfig = {
  writesEnabled: false,
  publishEnabled: false,
  deletesEnabled: false,
  dryRun: false,
};

const fullConfig: GuardrailConfig = {
  writesEnabled: true,
  publishEnabled: true,
  deletesEnabled: true,
  dryRun: false,
};

const dryRunConfig: GuardrailConfig = {
  writesEnabled: true,
  publishEnabled: true,
  deletesEnabled: true,
  dryRun: true,
};

describe('checkGuardrails', () => {
  it('throws when confirm is not true', () => {
    expect(() => checkGuardrails('write', false, fullConfig)).toThrow('confirm=true');
    expect(() => checkGuardrails('write', undefined, fullConfig)).toThrow('confirm=true');
  });

  it('throws when writes disabled and operation is write', () => {
    expect(() => checkGuardrails('write', true, readOnlyConfig)).toThrow(
      'GTM_MCP_ENABLE_WRITES'
    );
  });

  it('throws when publishes disabled and operation is publish', () => {
    expect(() => checkGuardrails('publish', true, readOnlyConfig)).toThrow(
      'GTM_MCP_ENABLE_PUBLISH'
    );
  });

  it('throws when deletes disabled and operation is delete', () => {
    expect(() => checkGuardrails('delete', true, readOnlyConfig)).toThrow(
      'GTM_MCP_ENABLE_DELETES'
    );
  });

  it('allows write when writes enabled and confirm=true', () => {
    const result = checkGuardrails('write', true, fullConfig);
    expect(result.dryRun).toBe(false);
  });

  it('returns dryRun=true when dry run config', () => {
    const result = checkGuardrails('write', true, dryRunConfig);
    expect(result.dryRun).toBe(true);
  });

  it('allows delete when deletes enabled and confirm=true', () => {
    const result = checkGuardrails('delete', true, fullConfig);
    expect(result.dryRun).toBe(false);
  });

  it('allows publish when publish enabled and confirm=true', () => {
    const result = checkGuardrails('publish', true, fullConfig);
    expect(result.dryRun).toBe(false);
  });
});

describe('formatGoogleError', () => {
  it('returns string for plain Error', () => {
    const result = formatGoogleError(new Error('plain error'));
    expect(result).toBe('plain error');
  });

  it('returns string for non-Error', () => {
    const result = formatGoogleError('something broke');
    expect(result).toBe('something broke');
  });

  it('formats Google API error body', () => {
    const err = Object.assign(new Error('API Error'), {
      response: {
        data: {
          error: {
            code: 403,
            message: 'The caller does not have permission',
            errors: [{ reason: 'forbidden', message: 'Access denied' }],
          },
        },
      },
    });
    const result = formatGoogleError(err);
    expect(result).toContain('403');
    expect(result).toContain('The caller does not have permission');
    expect(result).toContain('forbidden');
  });

  it('formats the OAuth string error shape and keeps error_description', () => {
    // A revoked/expired refresh token fails during token refresh with the STRING
    // error shape. This used to render as "Google API Error : invalid_grant",
    // dropping the sentence that tells the user to re-run the auth flow.
    const err = Object.assign(new Error('invalid_grant'), {
      response: {
        data: {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        },
      },
    });
    const result = formatGoogleError(err);
    expect(result).toBe('Google API Error invalid_grant: Token has been expired or revoked.');
  });

  it('formats the OAuth string error shape with no description', () => {
    const err = Object.assign(new Error('unauthorized_client'), {
      response: { data: { error: 'unauthorized_client' } },
    });
    expect(formatGoogleError(err)).toBe('Google API Error unauthorized_client');
  });
});

describe('buildPath', () => {
  it('builds account path', () => {
    expect(buildPath('123')).toBe('accounts/123');
  });

  it('builds container path', () => {
    expect(buildPath('123', '456')).toBe('accounts/123/containers/456');
  });

  it('builds workspace path', () => {
    expect(buildPath('123', '456', '789')).toBe(
      'accounts/123/containers/456/workspaces/789'
    );
  });

  it('builds resource path', () => {
    expect(buildPath('123', '456', '789', 'tags', '99')).toBe(
      'accounts/123/containers/456/workspaces/789/tags/99'
    );
  });
});
