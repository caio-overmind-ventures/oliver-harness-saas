/**
 * Server action channel — wraps a Tool so the builder can expose it as a
 * Next.js server action.
 *
 * The builder still needs to place the result in a file with `"use server"`
 * at the top (Next.js constraint — the directive is static, can't be
 * injected at runtime). But the body of that file is a one-liner:
 *
 * ```ts
 * // app/actions/customers.ts
 * "use server";
 * import { oliver } from "@/lib/oliver";
 * import { createCustomer } from "@/tools/createCustomer";
 * export const createCustomerAction = oliver.serverAction(createCustomer);
 * ```
 *
 * The resulting function:
 * - Accepts the tool's validated input (as inferred from the Zod schema)
 * - Optionally accepts a context override (for caller-known context like
 *   URL params — the caller React component passes `{ slug: params.slug }`)
 * - Returns a discriminated union: { ok: true, data } or { ok: false, error }
 * - Resolves context via the builder's `resolveServerActionContext`, then
 *   shallow-merges the override on top (override wins)
 * - Catches errors and wraps as ToolError
 *
 * Two-layer context resolution (generic across multi-tenancy patterns):
 *   Layer 1: resolveServerActionContext() — what the server knows (session,
 *            cookies, subdomain, middleware-injected headers)
 *   Layer 2: ctxOverride arg — what the caller knows (URL params, component
 *            state). Optional; shallow-merged into the resolved ctx.
 *
 * Notes on HITL:
 * - Server actions BYPASS HITL. The user clicked a button — that IS the
 *   human approval. requiresApproval only gates agent-initiated calls.
 */

import type { z } from "zod";
import type { Tool } from "../core/defineTool";
import type { Agent } from "./createAgent";
import { ToolError, wrapError } from "../core/errors";
import { hashInput } from "../audit/hash";
import { newTraceId } from "../audit/logger";
import { runVerify } from "../audit/verify";

export type ServerActionResult<TOutput> =
  | { ok: true; data: TOutput }
  | { ok: false; error: ReturnType<ToolError["toJSON"]> };

/**
 * A server action function. Accepts the tool input plus an optional
 * `ctxOverride` — a partial of the builder's TContextExt that gets
 * shallow-merged into the resolved context. Use it to pass caller-known
 * context like URL params.
 */
export type ServerActionFn<
  TInput extends z.ZodTypeAny,
  TOutput,
  TContextExt,
> = (
  input: z.infer<TInput>,
  ctxOverride?: Partial<TContextExt>,
) => Promise<ServerActionResult<TOutput>>;

/**
 * Factory a builder calls inside a "use server" file. Returns an async
 * function ready to be called from UI (buttons, form actions).
 */
export function makeServerAction<
  TInput extends z.ZodTypeAny,
  TOutput,
  TContextExt,
>(
  agent: Agent<TContextExt>,
  tool: Tool<TInput, TOutput, TContextExt>,
): ServerActionFn<TInput, TOutput, TContextExt> {
  return async (rawInput, ctxOverride) => {
    const traceId = newTraceId();
    const startedAt = Date.now();

    // Input validation happens BEFORE context resolution so we don't pay
    // the session/DB lookup cost for obviously-bad requests. But this
    // means audit doesn't have orgId/userId yet — we skip audit on pure
    // validation failures (they never touched business state).
    let parsed: z.infer<TInput>;
    try {
      parsed = tool.input.parse(rawInput) as z.infer<TInput>;
    } catch (err) {
      const wrapped = wrapError(tool.name, err);
      return { ok: false, error: wrapped.toJSON() };
    }

    const inputHash = hashInput(parsed);

    let ctx;
    try {
      const resolved = await agent._resolveServerActionContext(ctxOverride);
      ctx = {
        ...resolved,
        ...(ctxOverride ?? {}),
        source: "ui" as const,
      };
    } catch (err) {
      // Auth/resolution failures: no business state touched, no audit row.
      const wrapped =
        err instanceof ToolError ? err : wrapError(tool.name, err);
      return { ok: false, error: wrapped.toJSON() };
    }

    // Precondition — same domain-invariant check we run in the agent and
    // approve paths. Server actions are UI-triggered, but stale tabs or
    // concurrent writers can still violate invariants, so we re-enforce.
    if (tool.precondition) {
      try {
        await tool.precondition({ input: parsed, ctx });
      } catch (err) {
        const wrapped =
          err instanceof ToolError ? err : wrapError(tool.name, err);
        void agent._audit?.record({
          traceId,
          orgId: ctx.orgId,
          userId: ctx.userId,
          toolName: tool.name,
          source: "ui",
          status: "failed",
          inputHash,
          input: parsed,
          errorMessage: wrapped.message,
          errorCode: wrapped.code,
        });
        return { ok: false, error: wrapped.toJSON() };
      }
    }

    // Audit: invoked (fire-and-forget; logger never throws).
    void agent._audit?.record({
      traceId,
      orgId: ctx.orgId,
      userId: ctx.userId,
      toolName: tool.name,
      source: "ui",
      status: "invoked",
      inputHash,
      input: parsed,
    });

    try {
      const output = await tool.execute({ input: parsed, ctx });
      const latencyMs = Date.now() - startedAt;

      void agent._audit?.record({
        traceId,
        orgId: ctx.orgId,
        userId: ctx.userId,
        toolName: tool.name,
        source: "ui",
        status: "succeeded",
        inputHash,
        input: parsed,
        output,
        latencyMs,
      });

      // Verify hook with 5s timeout (critical guard #3).
      if (tool.verify) {
        const verifyResult = await runVerify(() =>
          tool.verify!({ input: parsed, result: output, ctx }),
        );
        void agent._audit?.record({
          traceId,
          orgId: ctx.orgId,
          userId: ctx.userId,
          toolName: tool.name,
          source: "ui",
          status: verifyResult.outcome,
          inputHash,
          errorMessage: verifyResult.error,
        });
      }

      return { ok: true, data: output };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const wrapped =
        err instanceof ToolError ? err : wrapError(tool.name, err);

      void agent._audit?.record({
        traceId,
        orgId: ctx.orgId,
        userId: ctx.userId,
        toolName: tool.name,
        source: "ui",
        status: "failed",
        inputHash,
        input: parsed,
        latencyMs,
        errorMessage: wrapped.message,
        errorCode: wrapped.code,
      });

      return { ok: false, error: wrapped.toJSON() };
    }
  };
}
