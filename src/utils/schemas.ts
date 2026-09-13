/**
 * Shared Zod input fragments for MCP tools.
 *
 * `workspaceScope` is the bare account/container/workspace selector used by the
 * variables, triggers, builtInVariables and folders tools. It is intentionally
 * NOT used by the tags and serverSide tools: those annotate each field with
 * `.describe(...)`, and the description text is exposed as part of the tool's
 * inputSchema — adopting the bare version there would change the published API
 * shape. Keep this fragment description-free so it stays byte-identical to the
 * inline `wsBase` it replaces.
 */

import { z } from 'zod';

export const workspaceScope = z.object({
  accountId: z.string(),
  containerId: z.string(),
  workspaceId: z.string(),
});
