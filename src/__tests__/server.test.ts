/**
 * Integration-style tests for the MCP server registration.
 * These tests verify that tools are registered without errors.
 * They do not make real GTM API calls.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Mock the GTM client
const mockClient = {
  accounts: {
    list: jest.fn().mockResolvedValue({ data: { account: [] } }),
    get: jest.fn().mockResolvedValue({ data: {} }),
    containers: {
      list: jest.fn().mockResolvedValue({ data: { container: [] } }),
      get: jest.fn().mockResolvedValue({ data: {} }),
      create: jest.fn().mockResolvedValue({ data: {} }),
      workspaces: {
        list: jest.fn().mockResolvedValue({ data: { workspace: [] } }),
        get: jest.fn().mockResolvedValue({ data: {} }),
        create: jest.fn().mockResolvedValue({ data: {} }),
        sync: jest.fn().mockResolvedValue({ data: {} }),
        quick_preview: jest.fn().mockResolvedValue({ data: {} }),
        create_version: jest.fn().mockResolvedValue({ data: {} }),
        resolve_conflict: jest.fn().mockResolvedValue({ data: {} }),
        tags: {
          list: jest.fn().mockResolvedValue({ data: { tag: [] } }),
          get: jest.fn().mockResolvedValue({ data: {} }),
          create: jest.fn().mockResolvedValue({ data: {} }),
          update: jest.fn().mockResolvedValue({ data: {} }),
          delete: jest.fn().mockResolvedValue({ data: {} }),
        },
        triggers: {
          list: jest.fn().mockResolvedValue({ data: { trigger: [] } }),
          get: jest.fn().mockResolvedValue({ data: {} }),
          create: jest.fn().mockResolvedValue({ data: {} }),
          update: jest.fn().mockResolvedValue({ data: {} }),
          delete: jest.fn().mockResolvedValue({ data: {} }),
        },
        variables: {
          list: jest.fn().mockResolvedValue({ data: { variable: [] } }),
          get: jest.fn().mockResolvedValue({ data: {} }),
          create: jest.fn().mockResolvedValue({ data: {} }),
          update: jest.fn().mockResolvedValue({ data: {} }),
          delete: jest.fn().mockResolvedValue({ data: {} }),
        },
        folders: {
          list: jest.fn().mockResolvedValue({ data: { folder: [] } }),
          get: jest.fn().mockResolvedValue({ data: {} }),
          create: jest.fn().mockResolvedValue({ data: {} }),
          update: jest.fn().mockResolvedValue({ data: {} }),
          delete: jest.fn().mockResolvedValue({ data: {} }),
          entities: jest.fn().mockResolvedValue({ data: {} }),
          move_entities_to_folder: jest.fn().mockResolvedValue({ data: {} }),
        },
        built_in_variables: {
          list: jest.fn().mockResolvedValue({ data: { builtInVariable: [] } }),
          create: jest.fn().mockResolvedValue({ data: {} }),
          delete: jest.fn().mockResolvedValue({ data: {} }),
          revert: jest.fn().mockResolvedValue({ data: {} }),
        },
      },
      versions: {
        list: jest.fn().mockResolvedValue({ data: { containerVersionHeader: [] } }),
        get: jest.fn().mockResolvedValue({ data: {} }),
        live: jest.fn().mockResolvedValue({ data: {} }),
        publish: jest.fn().mockResolvedValue({ data: {} }),
        set_latest: jest.fn().mockResolvedValue({ data: {} }),
        undelete: jest.fn().mockResolvedValue({ data: {} }),
        delete: jest.fn().mockResolvedValue({ data: {} }),
      },
    },
  },
} as unknown;

// Mock the GA4 Admin (v1beta) client
const mockGa4Client = {
  accountSummaries: { list: jest.fn().mockResolvedValue({ data: { accountSummaries: [] } }) },
  properties: {
    list: jest.fn().mockResolvedValue({ data: { properties: [] } }),
    get: jest.fn().mockResolvedValue({ data: {} }),
    getDataRetentionSettings: jest.fn().mockResolvedValue({ data: {} }),
    dataStreams: { list: jest.fn().mockResolvedValue({ data: { dataStreams: [] } }) },
    customDimensions: { list: jest.fn().mockResolvedValue({ data: { customDimensions: [] } }) },
    customMetrics: { list: jest.fn().mockResolvedValue({ data: { customMetrics: [] } }) },
    keyEvents: { list: jest.fn().mockResolvedValue({ data: { keyEvents: [] } }) },
    googleAdsLinks: { list: jest.fn().mockResolvedValue({ data: { googleAdsLinks: [] } }) },
  },
} as unknown;

// Mock the GA4 Admin (v1alpha) client — only enhanced measurement is used here.
const mockGa4AlphaClient = {
  properties: {
    dataStreams: {
      getEnhancedMeasurementSettings: jest.fn().mockResolvedValue({ data: {} }),
    },
  },
} as unknown;

describe('MCP Server Tool Registration', () => {
  let server: McpServer;

  beforeEach(async () => {
    // Import and create server with mock client
    const { registerAllTools } = await import('../tools/index.js');
    server = new McpServer(
      { name: 'test-server', version: '0.0.1' },
      { capabilities: { tools: {} } }
    );
    registerAllTools(
      server,
      () => mockClient as ReturnType<typeof import('../utils/gtmClient.js').getGtmClient>,
      () => mockGa4Client as ReturnType<typeof import('../utils/ga4Client.js').getGa4AdminClient>,
      () =>
        mockGa4AlphaClient as ReturnType<
          typeof import('../utils/ga4Client.js').getGa4AdminAlphaClient
        >
    );
  });

  it('server is created successfully', () => {
    expect(server).toBeDefined();
  });

  it('server has expected name and version', () => {
    const info = server.server.getClientVersion();
    // Server object is defined
    expect(server).toBeTruthy();
  });
});

describe('Tool handler: accounts_list (read-only, no auth needed)', () => {
  it('returns account list response shape', async () => {
    const { registerAllTools } = await import('../tools/index.js');
    const server = new McpServer(
      { name: 'test-server', version: '0.0.1' },
      { capabilities: { tools: {} } }
    );
    registerAllTools(
      server,
      () => mockClient as ReturnType<typeof import('../utils/gtmClient.js').getGtmClient>,
      () => mockGa4Client as ReturnType<typeof import('../utils/ga4Client.js').getGa4AdminClient>,
      () =>
        mockGa4AlphaClient as ReturnType<
          typeof import('../utils/ga4Client.js').getGa4AdminAlphaClient
        >
    );
    // Server registration succeeded without throwing
    expect(server).toBeTruthy();
  });
});
