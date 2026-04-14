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

// Instructions (authored + learned files loaded into a snapshot)
export {
  loadInstructions,
  instructionsFromStrings,
} from "./instructions/loader";
export type { AssembledInstructions } from "./instructions/loader";

// Context (session assembly + prompt builder)
export { buildSystemPrompt } from "./context/promptBuilder";
export type { PageContext, BuildPromptInput } from "./context/promptBuilder";
export type {
  AssembleSessionInput,
  SessionBundle,
} from "./context/assembly";

// Approval, audit — exported as they're built (Phase 4+)

// Database schema (Oliver lives in its own `oliver` Postgres schema).
// Builder references these to include Oliver's tables in their Drizzle
// migration setup.
export {
  oliverSchema,
  pendingTools,
  auditLog,
} from "./db/schema";

export { generateId } from "./db/ids";
