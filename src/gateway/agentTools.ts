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
import { hashInput } from "../audit/hash";
import { newTraceId, type AuditLogger } from "../audit/logger";
import { runVerify } from "../audit/verify";

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
    out[oliverTool.name] = wrapAsAISDKTool(oliverTool, ctx, agent._audit);
  }

  return out;
}

function wrapAsAISDKTool<TContextExt>(
  oliverTool: Tool<any, any, TContextExt>,
  ctx: ToolContext<TContextExt>,
  audit: AuditLogger | undefined,
) {
  return aiTool({
    description: oliverTool.description,
    inputSchema: zodSchema(oliverTool.input),
    execute: async (rawInput: unknown) => {
      const traceId = newTraceId();
      const startedAt = Date.now();

      let parsed: unknown;
      try {
        parsed = oliverTool.input.parse(rawInput);
      } catch (err) {
        const wrapped = wrapError(oliverTool.name, err);
        return { status: "error", error: wrapped.toJSON() };
      }

      const inputHash = hashInput(parsed);

      // HITL path (Phase 4b replaces this stub with oliver.pending_tools
      // state machine + re-invocation guard). For now, just record
      // pending_approval in audit and return the awaiting message.
      if (oliverTool.requiresApproval) {
        void audit?.record({
          traceId,
          orgId: ctx.orgId,
          userId: ctx.userId,
          toolName: oliverTool.name,
          source: "agent",
          status: "pending_approval",
          inputHash,
          input: parsed,
        });
        return {
          status: "awaiting_approval",
          toolName: oliverTool.name,
          input: parsed,
          message: `⏸️ Awaiting human approval for "${oliverTool.name}". Do not proceed until the user confirms.`,
        };
      }

      // Audit: invoked
      void audit?.record({
        traceId,
        orgId: ctx.orgId,
        userId: ctx.userId,
        toolName: oliverTool.name,
        source: "agent",
        status: "invoked",
        inputHash,
        input: parsed,
      });

      try {
        const result = await oliverTool.execute({ input: parsed, ctx });
        const latencyMs = Date.now() - startedAt;

        void audit?.record({
          traceId,
          orgId: ctx.orgId,
          userId: ctx.userId,
          toolName: oliverTool.name,
          source: "agent",
          status: "succeeded",
          inputHash,
          input: parsed,
          output: result,
          latencyMs,
        });

        if (oliverTool.verify) {
          const verifyResult = await runVerify(() =>
            oliverTool.verify!({ input: parsed, result, ctx }),
          );
          void audit?.record({
            traceId,
            orgId: ctx.orgId,
            userId: ctx.userId,
            toolName: oliverTool.name,
            source: "agent",
            status: verifyResult.outcome,
            inputHash,
            errorMessage: verifyResult.error,
          });
        }

        return { status: "ok", data: result };
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        const wrapped = wrapError(oliverTool.name, err);

        void audit?.record({
          traceId,
          orgId: ctx.orgId,
          userId: ctx.userId,
          toolName: oliverTool.name,
          source: "agent",
          status: "failed",
          inputHash,
          input: parsed,
          latencyMs,
          errorMessage: wrapped.message,
          errorCode: wrapped.code,
        });

        return { status: "error", error: wrapped.toJSON() };
      }
    },
  });
}
