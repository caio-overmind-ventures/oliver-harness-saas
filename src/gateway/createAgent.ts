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
} from "./serverAction";
import { buildAgentTools, type AgentToolsConfig } from "./agentTools";
import {
  assembleSession,
  type AssembleSessionInput,
  type SessionBundle,
} from "../context/assembly";

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
   * Internal: resolve context for a server action call. Exposed so
   * channel adapters can invoke the builder-provided resolver.
   * Not intended for direct use by builders.
   */
  _resolveServerActionContext: (
    ctxOverride?: Partial<TContextExt>,
  ) => Promise<ToolContext<TContextExt>>;

  /** Internal: instructions snapshot, used by assembleSession. */
  _instructions?: AssembledInstructions;
}

/**
 * Create an Oliver agent.
 *
 * @throws Error if tools have duplicate names.
 */
export function createAgent<TContextExt = Record<string, never>>(
  config: AgentConfig<TContextExt>,
): Agent<TContextExt> {
  const toolsByName = new Map<string, Tool<any, any, TContextExt>>();
  for (const tool of config.tools) {
    if (toolsByName.has(tool.name)) {
      throw new Error(
        `[@repo/oliver] Duplicate tool name: "${tool.name}". Tool names must be unique within an agent.`,
      );
    }
    toolsByName.set(tool.name, tool);
  }

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
    _resolveServerActionContext: config.resolveServerActionContext,
    _instructions: config.instructions,
  };

  return agent;
}
