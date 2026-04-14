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
 * - If `requiresApproval: true`: insert (or find) a pending row in
 *   oliver.pending_tools, return an "awaiting approval" message to the
 *   LLM. The user approves/rejects via the approval card, which calls
 *   `agent.approvePendingTool()` — that dispatcher runs the tool for real.
 * - Otherwise: validates input via Zod, injects ctx, runs `execute()`.
 *
 * Two re-invocation guards run in this channel:
 *
 *   Guard A — in-session dedup (this file): a Map<toolName+inputHash,result>
 *     scoped to the `buildAgentTools()` call lives for the duration of one
 *     agent turn. If the LLM calls the SAME tool with the SAME input a
 *     second time in the same turn, we return the cached result without
 *     touching the tool or the DB. Protects against "let me confirm by
 *     calling it again" failure mode from cheaper models.
 *
 *   Guard B — HITL dedup (PendingToolStore.findActive): for HITL tools
 *     ONLY, we look up an existing unexpired pending row before creating
 *     a new one. Covers the case where the LLM re-proposes the same action
 *     across multiple turns (session-level Map is gone by then).
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
import type { PendingToolStore } from "../hitl/pending";

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

  // Guard A: in-session dedup cache. Scoped to this buildAgentTools() call.
  // The chat route calls agentTools() once per request, so this Map lives
  // exactly one agent turn. Key: "toolName:inputHash".
  const sessionCache = new Map<string, unknown>();

  const out: Record<string, any> = {};

  for (const oliverTool of agent.tools) {
    out[oliverTool.name] = wrapAsAISDKTool(
      oliverTool,
      ctx,
      agent._audit,
      agent._pending,
      sessionCache,
    );
  }

  return out;
}

function wrapAsAISDKTool<TContextExt>(
  oliverTool: Tool<any, any, TContextExt>,
  ctx: ToolContext<TContextExt>,
  audit: AuditLogger | undefined,
  pendingStore: PendingToolStore | undefined,
  sessionCache: Map<string, unknown>,
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
      const cacheKey = `${oliverTool.name}:${inputHash}`;

      // Guard A: return cached result if this exact call already ran in
      // this turn. We re-emit the original response verbatim — from the
      // LLM's perspective the tool responded identically.
      const cached = sessionCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }

      // HITL path — DB-backed state machine + re-invocation guard.
      if (oliverTool.requiresApproval) {
        if (!pendingStore) {
          const wrapped = wrapError(
            oliverTool.name,
            new Error(
              "Tool has requiresApproval=true but Oliver was configured without `db`. Pass `db` to createAgent() to enable the HITL state machine.",
            ),
          );
          return { status: "error", error: wrapped.toJSON() };
        }

        // Guard B: check for an existing unexpired pending row.
        const existing = await pendingStore.findActive({
          orgId: ctx.orgId,
          toolName: oliverTool.name,
          inputHash,
        });
        if (existing) {
          const response = {
            status: "awaiting_approval" as const,
            pendingToolId: existing.id,
            toolName: oliverTool.name,
            input: parsed,
            message: `Already awaiting approval (id: ${existing.id}). Do not re-propose.`,
          };
          sessionCache.set(cacheKey, response);
          return response;
        }

        // Compute preview (best-effort; failure doesn't block the card).
        let previewBefore: unknown;
        let previewAfter: unknown;
        if (oliverTool.previewChange) {
          try {
            const preview = await oliverTool.previewChange({
              input: parsed as never,
              ctx,
            });
            previewBefore = preview.before;
            previewAfter = preview.after;
          } catch (err) {
            // Preview is cosmetic — log and continue so approval still works.
            // biome-ignore lint/suspicious/noConsole: intentional diagnostic
            console.error(
              `[@repo/oliver] previewChange failed for "${oliverTool.name}":`,
              err,
            );
          }
        }

        const pending = await pendingStore.create({
          orgId: ctx.orgId,
          userId: ctx.userId,
          toolName: oliverTool.name,
          input: parsed,
          inputHash,
          previewBefore,
          previewAfter,
        });

        void audit?.record({
          traceId,
          orgId: ctx.orgId,
          userId: ctx.userId,
          toolName: oliverTool.name,
          source: "agent",
          status: "pending_approval",
          inputHash,
          input: parsed,
          pendingToolId: pending.id,
        });

        const response = {
          status: "awaiting_approval" as const,
          pendingToolId: pending.id,
          toolName: oliverTool.name,
          input: parsed,
          message: `Awaiting human approval for "${oliverTool.name}" (id: ${pending.id}). Do not proceed until the user confirms.`,
        };
        sessionCache.set(cacheKey, response);
        return response;
      }

      // Non-HITL path — execute immediately.
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

        const response = { status: "ok" as const, data: result };
        sessionCache.set(cacheKey, response);
        return response;
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

        // Errors are NOT cached — the LLM might retry with a different call
        // that happens to hash identically only by accident. Better to let
        // the second attempt re-run and re-fail than silently mask.
        return { status: "error" as const, error: wrapped.toJSON() };
      }
    },
  });
}
