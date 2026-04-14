/**
 * Agent tool channel — converts Oliver tools into Vercel AI SDK tools
 * bound to a session context.
 *
 * Usage in the chat route:
 * ```ts
 * const tools = oliver.agentTools({
 *   ctx: { orgId, userId, source: "agent", db: database }
 * });
 * // Pass to streamText / generateText:
 * const result = streamText({ model, tools, messages });
 * ```
 *
 * For each tool on the agent:
 * - If `requiresApproval: true`: the wrapper returns an "awaiting approval"
 *   message to the LLM instead of executing. The actual HITL state machine
 *   (harness_pending_tools inserts, approval card events) ships in Phase 4.
 *   v0 Phase 2 just structures the path correctly.
 * - Otherwise: validates input via Zod, injects ctx, runs `execute()`.
 *
 * Errors are caught and returned as tool output strings the LLM can read
 * (so it can react). ToolError is serialized; unknown errors are wrapped.
 */

import { tool as aiTool, zodSchema } from "ai";
import type { Tool } from "../core/defineTool";
import type { ToolContext } from "../core/context";
import type { Agent } from "./createAgent";
import { wrapError } from "../core/errors";

export interface AgentToolsConfig<TContextExt> {
  /**
   * The session context for this agent run. Resolved ONCE per chat session
   * and reused across all tool invocations within the session.
   */
  ctx: ToolContext<TContextExt>;
}

/**
 * Builds the Vercel AI SDK tool record from an Oliver agent + session
 * context. Returns a record keyed by tool name, ready to be passed to
 * `streamText`, `generateText`, or `ToolLoopAgent`.
 */
/**
 * Return type is intentionally `Record<string, any>` — the AI SDK's `tool()`
 * return is a deeply generic type not meant to be preserved at a record
 * boundary. Callers pass this straight to `streamText`/`generateText` where
 * the SDK consumes it dynamically.
 */
// biome-ignore lint/suspicious/noExplicitAny: see docblock
export function buildAgentTools<TContextExt>(
  agent: Agent<TContextExt>,
  config: AgentToolsConfig<TContextExt>,
): Record<string, any> {
  const ctx = { ...config.ctx, source: "agent" as const };
  const out: Record<string, any> = {};

  for (const oliverTool of agent.tools) {
    out[oliverTool.name] = wrapAsAISDKTool(oliverTool, ctx);
  }

  return out;
}

function wrapAsAISDKTool<TContextExt>(
  oliverTool: Tool<any, any, TContextExt>,
  ctx: ToolContext<TContextExt>,
) {
  return aiTool({
    description: oliverTool.description,
    inputSchema: zodSchema(oliverTool.input),
    execute: async (rawInput: unknown) => {
      try {
        const parsed = oliverTool.input.parse(rawInput);

        // HITL path (Phase 4 will replace this with state machine + persistence).
        // For v0 Phase 2 we return a clear message the LLM understands so the
        // overall shape is right from day one.
        if (oliverTool.requiresApproval) {
          return {
            status: "awaiting_approval",
            toolName: oliverTool.name,
            input: parsed,
            message: `⏸️ Awaiting human approval for "${oliverTool.name}". Do not proceed until the user confirms.`,
          };
        }

        const result = await oliverTool.execute({ input: parsed, ctx });
        return { status: "ok", data: result };
      } catch (err) {
        const wrapped = wrapError(oliverTool.name, err);
        // Return the error as tool output so the LLM can read and react.
        return {
          status: "error",
          error: wrapped.toJSON(),
        };
      }
    },
  });
}
