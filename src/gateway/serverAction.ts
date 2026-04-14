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
 * - Returns a discriminated union: { ok: true, data } or { ok: false, error }
 * - Resolves context via the builder's `resolveServerActionContext`
 * - Catches errors and wraps as ToolError
 *
 * Notes on HITL:
 * - Server actions BYPASS HITL. The user clicked a button — that IS the
 *   human approval. requiresApproval only gates agent-initiated calls.
 */

import type { z } from "zod";
import type { Tool } from "../core/defineTool";
import type { Agent } from "./createAgent";
import { ToolError, wrapError } from "../core/errors";

export type ServerActionResult<TOutput> =
  | { ok: true; data: TOutput }
  | { ok: false; error: ReturnType<ToolError["toJSON"]> };

export type ServerActionFn<TInput extends z.ZodTypeAny, TOutput> = (
  input: z.infer<TInput>,
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
): ServerActionFn<TInput, TOutput> {
  return async (rawInput) => {
    try {
      // Validate input through the Zod schema. Throws ZodError on bad input.
      const parsed = tool.input.parse(rawInput) as z.infer<TInput>;

      // Resolve context (builder-provided — uses Next.js headers() etc).
      const ctx = await agent._resolveServerActionContext();

      // Safety net: enforce the source tag even if the builder's resolver
      // forgot to set it. Server action callers are always "ui".
      const ctxWithSource = { ...ctx, source: "ui" as const };

      const output = await tool.execute({ input: parsed, ctx: ctxWithSource });

      return { ok: true, data: output };
    } catch (err) {
      const wrapped =
        err instanceof ToolError ? err : wrapError(tool.name, err);
      return { ok: false, error: wrapped.toJSON() };
    }
  };
}
