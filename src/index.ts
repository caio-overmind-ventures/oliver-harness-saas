/**
 * @repo/oliver — the AI agent harness for Next.js SaaS.
 *
 * Define your operations once. Get a chat agent with approval gates,
 * audit log, and multi-tenancy built in.
 */

// Core types
export { defineTool } from "./core/defineTool";
export type { Tool, ToolInput, ToolOutput } from "./core/defineTool";

export type { ToolContext, ToolContextBase } from "./core/context";

export { ToolError, wrapError } from "./core/errors";
export type { ToolErrorCode } from "./core/errors";

// Gateway
export { createAgent } from "./gateway/createAgent";
export type { Agent, AgentConfig } from "./gateway/createAgent";
export type {
  ServerActionFn,
  ServerActionResult,
} from "./gateway/serverAction";
export type { AgentToolsConfig } from "./gateway/agentTools";

// Context assembly, approval, audit — exported as they're built
// (Phase 3+ of implementation brief)

// Database schema (builder includes in their Drizzle config)
export {
  harnessPendingTools,
  harnessAuditLog,
} from "./db/schema";

export { generateId } from "./db/ids";
