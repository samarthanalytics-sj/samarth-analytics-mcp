/**
 * How the server DESCRIBES its own guardrail state.
 *
 * What broke: the instructions, /health and the stdio banner each derived their answer from the GTM
 * flags alone. getGuardrailConfig() populates ga4WritesEnabled / ga4DeletesEnabled and nothing outside
 * checkGa4Guardrails ever read them, so a server started with GA4_MCP_ENABLE_DELETES=true announced
 * "READ-ONLY (writes disabled), PUBLISH DISABLED, DELETES DISABLED" while the entire GA4 Admin write
 * surface, ga4_delete_account included, was registered and callable. The gates themselves were correct.
 * The self-description was not, so a model asked "can this server change anything?" answered no, and an
 * operator polling /health saw a locked-down server.
 *
 * GTM had the same shape of bug: READ-ONLY led the sentence whenever writes were off, even with deletes
 * or publish enabled.
 *
 * PURE, so the whole flag matrix is testable without building an McpServer or binding a socket.
 */

import type { GuardrailConfig } from '../types/index.js';

/** Flat serializable view of every gate. This is the shape of the /health `guardrails` object. */
export interface GuardrailStatus {
  writesEnabled: boolean;
  publishEnabled: boolean;
  deletesEnabled: boolean;
  ga4WritesEnabled: boolean;
  ga4DeletesEnabled: boolean;
  dryRun: boolean;
  /** True when no gate on either product permits a mutation. This, not writesEnabled alone, is what
   *  "read-only" means. */
  readOnly: boolean;
}

/**
 * Can this server change anything at all? Every gate across BOTH products has to be shut.
 *
 * dryRun is deliberately NOT part of this. A dry-run server still exposes the write tools and still
 * accepts the calls; it just does not forward them. Folding it in here would let DRY_RUN=true make a
 * fully write-enabled server describe itself as read-only, which is the same class of lie this module
 * exists to remove.
 */
export function isReadOnly(c: GuardrailConfig): boolean {
  return (
    !c.writesEnabled &&
    !c.publishEnabled &&
    !c.deletesEnabled &&
    !c.ga4WritesEnabled &&
    !c.ga4DeletesEnabled
  );
}

export function guardrailStatus(c: GuardrailConfig): GuardrailStatus {
  return {
    writesEnabled: c.writesEnabled,
    publishEnabled: c.publishEnabled,
    deletesEnabled: c.deletesEnabled,
    ga4WritesEnabled: c.ga4WritesEnabled,
    ga4DeletesEnabled: c.ga4DeletesEnabled,
    dryRun: c.dryRun,
    readOnly: isReadOnly(c),
  };
}

/** One-line mode summary for the model. The word READ-ONLY appears if and only if isReadOnly() is
 *  true; otherwise every gate is named individually, so an enabled one cannot hide behind a disabled
 *  one. */
export function describeMode(c: GuardrailConfig): string {
  const parts: string[] = [];
  if (isReadOnly(c)) {
    parts.push('READ-ONLY (GTM writes/publish/deletes and GA4 writes/deletes all disabled)');
  } else {
    parts.push(c.writesEnabled ? 'GTM WRITES ENABLED' : 'GTM writes disabled');
    parts.push(c.publishEnabled ? 'GTM PUBLISH ENABLED' : 'GTM publish disabled');
    parts.push(c.deletesEnabled ? 'GTM DELETES ENABLED' : 'GTM deletes disabled');
    parts.push(c.ga4WritesEnabled ? 'GA4 WRITES ENABLED' : 'GA4 writes disabled');
    parts.push(c.ga4DeletesEnabled ? 'GA4 DELETES ENABLED' : 'GA4 deletes disabled');
  }
  if (c.dryRun) parts.push('DRY RUN MODE');
  return parts.join(', ');
}

/**
 * The stderr startup line. Prints PARSED booleans: the old banner echoed process.env verbatim, so
 * GTM_MCP_ENABLE_WRITES=1 printed "writes=1" while the gate (=== 'true') read false and /health, which
 * parsed correctly, reported the opposite. Two operator surfaces in one process disagreeing.
 */
export function guardrailBanner(c: GuardrailConfig): string {
  const s = guardrailStatus(c);
  return (
    'Guardrails: writes=' + s.writesEnabled +
    ' publish=' + s.publishEnabled +
    ' deletes=' + s.deletesEnabled +
    ' ga4Writes=' + s.ga4WritesEnabled +
    ' ga4Deletes=' + s.ga4DeletesEnabled +
    ' dryRun=' + s.dryRun +
    ' readOnly=' + s.readOnly
  );
}
