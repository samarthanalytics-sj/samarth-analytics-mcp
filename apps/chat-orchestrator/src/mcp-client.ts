/**
 * MCP client wrapper.
 *
 * The browser can never reach the MCP server directly: its HTTP transport sets no CORS headers and
 * its sessions live in process memory. This module is the only thing that talks to it.
 *
 * Two transports are supported. `stdio` spawns the built MCP server as a child process and is the
 * right default for a single-identity proof of concept. `http` connects to an already-running MCP
 * instance, which is what a multi-instance deployment uses later.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OrchestratorConfig } from './config.js';
import type { ToolDef } from './types.js';

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/**
 * Irreversible or publishing operations, matched on the MCP's own naming convention. Kept as one
 * pattern rather than a name list so a newly added delete tool is destructive by default instead of
 * silently becoming approvable.
 */
const DESTRUCTIVE = /(^|_)(delete|archive|remove)(_|$)|publish|reauthorize/i;

export class McpConnection {
  private client: Client | null = null;
  private tools: ToolDef[] = [];
  private prompts: McpPrompt[] = [];
  private instructions = '';

  /**
   * @param googleAccessToken when provided, this child acts as exactly that Google identity and
   *        every ambient credential is withheld from it. When omitted, the child resolves whatever
   *        credentials the environment gives it, which is single-identity development mode.
   */
  constructor(
    private readonly cfg: OrchestratorConfig,
    private readonly googleAccessToken?: string,
  ) {}

  async connect(): Promise<void> {
    const client = new Client(
      { name: 'samarth-chat-orchestrator', version: '0.1.0' },
      { capabilities: {} },
    );

    if (this.cfg.mcp.transport === 'http') {
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );
      if (!this.cfg.mcp.url) throw new Error('MCP_TRANSPORT=http requires MCP_URL');
      const headers: Record<string, string> = {};
      if (this.cfg.mcp.authToken) headers.Authorization = `Bearer ${this.cfg.mcp.authToken}`;
      await client.connect(
        new StreamableHTTPClientTransport(new URL(this.cfg.mcp.url), {
          requestInit: { headers },
        }),
      );
    } else {
      const { StdioClientTransport, getDefaultEnvironment } = await import(
        '@modelcontextprotocol/sdk/client/stdio.js'
      );
      await client.connect(
        new StdioClientTransport({
          command: this.cfg.mcp.command,
          args: this.cfg.mcp.args,
          env: this.buildChildEnv(getDefaultEnvironment()),
          // The MCP server logs to stderr by contract; surfacing it makes auth problems visible.
          stderr: 'inherit',
        }),
      );
    }

    this.client = client;
    this.instructions = client.getInstructions() ?? '';
    await this.refreshCatalog();
  }

  /**
   * Builds the child process environment.
   *
   * In per-user mode this is the security boundary. The child receives that one user's access token
   * and nothing else that could authenticate as anyone: no OAuth client secret, no stored token
   * file, no service-account key, no Application Default Credentials path. If the token is rejected,
   * the MCP fails with an auth error, which is the correct outcome. The alternative, leaving an
   * ambient credential reachable, would let a failed lookup silently succeed as the server's own
   * Google account and read another tenant's data.
   */
  private buildChildEnv(base: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = { ...base, ...this.cfg.mcp.env };

    if (!this.googleAccessToken) return env;

    for (const key of [
      'GOOGLE_REFRESH_TOKEN',
      'GOOGLE_SERVICE_ACCOUNT_KEY_FILE',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'GOOGLE_CLIENT_SECRET',
      'GTM_MCP_TOKEN_FILE',
    ]) {
      delete env[key];
    }

    env.GOOGLE_ACCESS_TOKEN = this.googleAccessToken;
    // The MCP picks its token source as a whole, never field by field, so an access token with no
    // refresh token is a coherent short-lived identity rather than a half-populated one.
    return env;
  }

  private async refreshCatalog(): Promise<void> {
    const client = this.requireClient();

    const toolPages: ToolDef[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        const schema = (t.inputSchema ?? { type: 'object', properties: {} }) as Record<
          string,
          unknown
        >;
        const properties = (schema.properties ?? {}) as Record<string, unknown>;
        toolPages.push({
          name: t.name,
          description: t.description ?? '',
          inputSchema: schema,
          // Every guarded mutation in this MCP takes `confirm`; read tools never do. That makes the
          // schema itself the read/write discriminator, with no name list to keep in sync.
          isWrite: Object.prototype.hasOwnProperty.call(properties, 'confirm'),
          isDestructive: DESTRUCTIVE.test(t.name),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = toolPages;

    try {
      const promptPage = await client.listPrompts();
      this.prompts = promptPage.prompts.map((p) => ({
        name: p.name,
        title: p.title,
        description: p.description,
        arguments: p.arguments as McpPrompt['arguments'],
      }));
    } catch {
      // Prompts are optional in the MCP spec; a server without them is still usable.
      this.prompts = [];
    }
  }

  private requireClient(): Client {
    if (!this.client) throw new Error('MCP client is not connected');
    return this.client;
  }

  listTools(): ToolDef[] {
    return this.tools;
  }

  listPrompts(): McpPrompt[] {
    return this.prompts;
  }

  getInstructions(): string {
    return this.instructions;
  }

  /** Fetches a registered MCP prompt and returns its rendered text. */
  async getPromptText(name: string, args: Record<string, string>): Promise<string> {
    const result = await this.requireClient().getPrompt({ name, arguments: args });
    return result.messages
      .map((m) => (m.content.type === 'text' ? m.content.text : ''))
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Calls a tool and flattens the MCP content blocks to text.
   *
   * A tool-level error is returned rather than thrown: the model needs to see the failure so it can
   * correct its arguments, and a thrown error would abort the whole turn.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    try {
      const result = await this.requireClient().callTool({ name, arguments: args });
      const blocks = Array.isArray(result.content) ? result.content : [];
      const text = blocks
        .map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
        .filter(Boolean)
        .join('\n');
      return { ok: result.isError !== true, text: text || '(empty result)' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, text: `Tool call failed: ${message}` };
    }
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}
