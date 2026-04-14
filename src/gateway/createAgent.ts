/**
 * createAgent() — the main factory the builder uses to set up Oliver.
 *
 * Takes a list of tools and (later) gateway channel config. Returns an Agent
 * object that the builder exposes through specific channels:
 * - serverAction(tool) → Next.js server action
 * - agentTools(ctx) → Vercel AI SDK tool record, bound to a session context
 *
 * v0 has two channels (ui + agent). v0.1 adds mcp.
 *
 * All tools on a single agent must share the same TContextExt type so the
 * builder's context shape is consistent across every tool.
 */

import type { z } from "zod";
import type { Tool } from "../core/defineTool";
import type { ToolContext } from "../core/context";
import type { AssembledInstructions } from "../instructions/loader";
import {
  makeServerAction,
  type ServerActionFn,
  type ServerActionResult,
} from "./serverAction";
import { buildAgentTools, type AgentToolsConfig } from "./agentTools";
import {
  assembleSession,
  type AssembleSessionInput,
  type SessionBundle,
} from "../context/assembly";
import { AuditLogger } from "../audit/logger";
import type { DrizzleDbLike } from "../db/types";
import type { OnAuditFailure } from "../audit/types";
import {
  PendingToolStore,
  type PendingToolRow,
} from "../hitl/pending";
import {
  approvePendingToolImpl,
  rejectPendingToolImpl,
  type ApprovePendingToolInput,
  type RejectPendingToolInput,
} from "../hitl/approve";

export interface AgentConfig<TContextExt> {
  /**
   * Tools available to this agent. Tool names must be unique.
   * All tools share the same TContextExt so the builder's context
   * (e.g., `db`, `logger`, etc.) is the same shape everywhere.
   */
  readonly tools: ReadonlyArray<Tool<any, any, TContextExt>>;

  /**
   * Instructions snapshot to assemble into the system prompt on every
   * agent-channel session. Load once with `loadInstructions(dir)` at
   * startup — reading files per turn would invalidate the KV-cache.
   *
   * Optional only so server-action-only usage doesn't require this.
   * `agent.assembleSession(...)` throws if called without instructions.
   */
  readonly instructions?: AssembledInstructions;

  /**
   * Drizzle database handle. Oliver uses it to write audit log entries and
   * (Phase 4b) to persist the HITL state machine into oliver.pending_tools.
   *
   * Typed structurally (`DrizzleDbLike`) so Oliver doesn't depend on a
   * specific `@repo/database` export — pass whichever drizzle instance
   * your app already has.
   *
   * Required whenever you use tools that are marked requiresApproval, or
   * whenever you want audit log entries to be persisted. Oliver creates
   * no tables at runtime — run the provided schema migrations yourself.
   */
  readonly db?: DrizzleDbLike;

  /**
   * Hook invoked when a write to oliver.audit_log fails. Default logs to
   * console.error. Override to forward to Sentry / Datadog / etc.
   *
   * The handler is intentionally NOT allowed to roll back the tool call
   * itself — losing business state to "save" audit state would be worse.
   */
  readonly onAuditFailure?: OnAuditFailure;

  /**
   * Resolves the full tool context for a **server action** invocation.
   *
   * Called once per server action call. This is where the builder uses
   * Next.js `headers()` / `auth.api.getSession()` / session cookies to figure
   * out who the user is.
   *
   * Receives the optional `ctxOverride` the caller passed (URL params like
   * `slug`, `workspaceId`, etc.) so the resolver can use them — for
   * example, to look up `orgId` from a slug.
   *
   * Must return `source: "ui"` — the harness enforces this as a safety net
   * even if the resolver forgets to set it.
   */
  resolveServerActionContext: (
    ctxOverride?: Partial<TContextExt>,
  ) => Promise<ToolContext<TContextExt>>;
}

export interface Agent<TContextExt> {
  /** All registered tools, in registration order. */
  readonly tools: ReadonlyArray<Tool<any, any, TContextExt>>;

  /** Look up a tool by name. Returns undefined if not found. */
  getTool(name: string): Tool<any, any, TContextExt> | undefined;

  /**
   * Wrap a tool as a Next.js server action. Builder places the result
   * inside a file with `"use server"` at the top (Next.js constraint).
   *
   * The resulting function accepts an optional `ctxOverride` arg for
   * caller-known context (e.g., URL params):
   *   await createCustomerAction({ name }, { slug: params.slug });
   */
  serverAction<TInput extends z.ZodTypeAny, TOutput>(
    tool: Tool<TInput, TOutput, TContextExt>,
  ): ServerActionFn<TInput, TOutput, TContextExt>;

  /**
   * Build the Vercel AI SDK tool record for a session. Called once per
   * chat session from the chat route, then passed to `streamText` etc.
   *
   * Prefer `assembleSession()` when you also need the system prompt.
   */
  // biome-ignore lint/suspicious/noExplicitAny: AI SDK tool return type is not meant to be preserved
  agentTools(config: AgentToolsConfig<TContextExt>): Record<string, any>;

  /**
   * Assemble a full agent session: tools + system prompt, ready to hand
   * to the LLM. Throws if `instructions` was not provided to createAgent.
   *
   * This is the recommended entry point for the agent channel.
   */
  assembleSession(input: AssembleSessionInput<TContextExt>): SessionBundle;

  /**
   * Approve a pending tool and run it.
   *
   * Builder exposes this as a server action:
   * ```ts
   * "use server";
   * export const approvePendingToolAction = oliver.approvePendingTool;
   * ```
   *
   * Available only when `db` was passed to createAgent.
   */
  approvePendingTool(
    input: ApprovePendingToolInput,
    ctxOverride?: Partial<TContextExt>,
  ): Promise<ServerActionResult<unknown>>;

  /**
   * Reject a pending tool. The tool never runs; status flips to 'rejected'.
   *
   * Available only when `db` was passed to createAgent.
   */
  rejectPendingTool(
    input: RejectPendingToolInput,
    ctxOverride?: Partial<TContextExt>,
  ): Promise<ServerActionResult<{ rejected: true }>>;

  /**
   * List active (unexpired, still-pending) approval cards for an org.
   * Empty array when Oliver wasn't configured with `db`.
   *
   * UI calls this to render the approval queue.
   */
  listPendingTools(orgId: string): Promise<PendingToolRow[]>;

  /**
   * Internal: resolve context for a server action call. Exposed so
   * channel adapters can invoke the builder-provided resolver.
   * Not intended for direct use by builders.
   */
  _resolveServerActionContext: (
    ctxOverride?: Partial<TContextExt>,
  ) => Promise<ToolContext<TContextExt>>;

  /** Internal: instructions snapshot, used by assembleSession. */
  _instructions?: AssembledInstructions;

  /** Internal: audit logger. No-op if no db configured. */
  _audit?: AuditLogger;

  /** Internal: HITL pending-tool store. Undefined when no db configured. */
  _pending?: PendingToolStore;
}

/**
 * Create an Oliver agent.
 *
 * @throws Error if tools have duplicate names.
 */
export function createAgent<TContextExt = Record<string, unknown>>(
  config: AgentConfig<TContextExt>,
): Agent<TContextExt> {
  const toolsByName = new Map<string, Tool<any, any, TContextExt>>();
  for (const tool of config.tools) {
    if (toolsByName.has(tool.name)) {
      throw new Error(
        `[oliver-agent] Duplicate tool name: "${tool.name}". Tool names must be unique within an agent.`,
      );
    }
    toolsByName.set(tool.name, tool);
  }

  const audit = config.db
    ? new AuditLogger(config.db, config.onAuditFailure)
    : undefined;
  const pending = config.db ? new PendingToolStore(config.db) : undefined;

  const agent: Agent<TContextExt> = {
    tools: config.tools,
    getTool(name) {
      return toolsByName.get(name);
    },
    serverAction(tool) {
      return makeServerAction(agent, tool);
    },
    agentTools(toolsConfig) {
      return buildAgentTools(agent, toolsConfig);
    },
    assembleSession(input) {
      return assembleSession(agent, input);
    },
    approvePendingTool(input, ctxOverride) {
      return approvePendingToolImpl(agent, input, ctxOverride);
    },
    rejectPendingTool(input, ctxOverride) {
      return rejectPendingToolImpl(agent, input, ctxOverride);
    },
    async listPendingTools(orgId) {
      if (!pending) return [];
      return pending.listActive(orgId);
    },
    _resolveServerActionContext: config.resolveServerActionContext,
    _instructions: config.instructions,
    _audit: audit,
    _pending: pending,
  };

  return agent;
}
