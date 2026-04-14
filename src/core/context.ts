/**
 * ToolContext — the runtime context passed to every tool execution.
 *
 * Generic over `TExtension` so builders can extend the context with their own
 * typed fields (e.g., db, logger, feature flags) while the base context
 * (orgId, userId, source) is always present.
 *
 * The harness resolves the base context before invoking any tool:
 * - orgId: multi-tenant scope (always required)
 * - userId: who initiated the call (always required)
 * - source: which consumer invoked — "ui" (server action) or "agent" (chat tool)
 *
 * The builder provides the extension via createAgent() config.
 */
export interface ToolContextBase {
  /** Multi-tenant organization scope. Always required. */
  orgId: string;
  /** User who initiated the invocation. Always required. */
  userId: string;
  /** Which consumer invoked this tool. */
  source: "ui" | "agent";
}

/**
 * ToolContext — base context plus builder-defined extension.
 *
 * Example:
 *   type MyContext = ToolContext<{ db: Database; logger: Logger }>;
 *   // Resulting type has: orgId, userId, source, db, logger
 */
export type ToolContext<TExtension = Record<string, unknown>> = ToolContextBase &
  TExtension;
