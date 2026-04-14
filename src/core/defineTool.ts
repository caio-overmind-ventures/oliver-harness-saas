import type { z } from "zod";
import type { ToolContext } from "./context";

/**
 * A Tool is Oliver's atomic unit of action. Defined once via `defineTool()`,
 * the harness routes it to multiple consumers via the Gateway:
 * - UI server action (Next.js) — when a button triggers it
 * - Agent tool (Vercel AI SDK) — when the chat agent calls it
 * - MCP endpoint (v0.1) — when an external agent consumes it
 *
 * The builder writes the logic ONCE. The harness handles:
 * - Context propagation (orgId, userId, source, builder extensions)
 * - HITL approval gates (if requiresApproval)
 * - Audit logging (invocation + verification)
 * - Verification (if verify() provided)
 * - Approval card diff (if previewChange() provided)
 */
export interface Tool<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput = unknown,
  TContextExt = Record<string, never>,
> {
  /**
   * Unique identifier. Used as the tool name exposed to the LLM and as the
   * server action export name. Must be a valid TypeScript identifier.
   */
  name: string;

  /**
   * Natural language description shown to the LLM. Should clearly state:
   * - What the tool does
   * - When to use it vs similar tools
   * - What side effects it has
   * Avoid overlap with other tools — ambiguous descriptions cause bad behavior.
   */
  description: string;

  /**
   * Zod schema describing the input. The harness uses this to:
   * - Validate incoming calls
   * - Generate the tool schema for the LLM (Vercel AI SDK compatible)
   * - Generate the MCP tool definition (v0.1)
   */
  input: TInput;

  /**
   * If true, the tool does NOT execute automatically when the agent calls it.
   * Instead, the harness:
   * 1. Creates a pending approval entry in harness_pending_tools
   * 2. Returns "awaiting approval" message to the LLM
   * 3. Emits an event for the UI to render an approval card
   * 4. When approved, re-invokes and executes for real
   *
   * Does NOT affect server action invocations — those bypass HITL (the UI is
   * already a human action).
   *
   * Default: false.
   */
  requiresApproval?: boolean;

  /**
   * Optional. When provided, the harness calls this BEFORE execution to
   * generate a before/after diff for the approval card.
   *
   * Only invoked when requiresApproval is true and source === "agent".
   *
   * Must be pure (no side effects). Must be fast (< 1s).
   */
  previewChange?: (params: {
    input: z.infer<TInput>;
    ctx: ToolContext<TContextExt>;
  }) => Promise<{ before: unknown; after: unknown }>;

  /**
   * Optional. Domain-invariant check that runs BEFORE anything else in the
   * tool lifecycle. Throw ToolError to block the call.
   *
   * Use this to encode rules like "published quote cannot be edited",
   * "closed ticket cannot be reopened", "user must be the owner", etc. —
   * things the UI normally enforces that tool authors otherwise have to
   * remember to re-check inside execute().
   *
   * The harness runs precondition at every point state could diverge:
   *   - Non-HITL: before audit(invoked) + before execute()
   *   - HITL propose: before previewChange + before pending_tools insert
   *   - HITL approve: before execute() runs (to catch races — the quote
   *     might have been published between propose and approve)
   *
   * A single `conflict`-coded ToolError is the canonical way to signal
   * "can't do this because of state" — the LLM sees the message and can
   * explain it to the user. No approval card is rendered for a blocked
   * HITL proposal.
   *
   * Must be read-only (no side effects). Should be fast (< 500ms).
   */
  precondition?: (params: {
    input: z.infer<TInput>;
    ctx: ToolContext<TContextExt>;
  }) => Promise<void>;

  /**
   * The actual tool logic. Receives validated input + the full context.
   * Must be idempotent or the builder must handle re-invocation safely
   * (Oliver v0 does NOT retry automatically).
   *
   * Throws to indicate failure. Throw ToolError for specific codes,
   * otherwise the harness wraps as ToolError(code: "unexpected").
   */
  execute: (params: {
    input: z.infer<TInput>;
    ctx: ToolContext<TContextExt>;
  }) => Promise<TOutput>;

  /**
   * Optional. Runs AFTER execute() to confirm the operation actually took
   * effect (e.g., DB state matches expectation).
   *
   * Returns true = verified, false = failed_verification. The harness logs
   * the result to audit. If it throws or exceeds 5s, the harness marks as
   * verification_skipped (not failed).
   *
   * This is the "only passing verification counts as done" principle from
   * walkinglabs' harness engineering course.
   */
  verify?: (params: {
    input: z.infer<TInput>;
    result: TOutput;
    ctx: ToolContext<TContextExt>;
  }) => Promise<boolean>;
}

/**
 * Define a Tool. Type inference carries the input schema, output, and
 * context extension through to the consumers.
 *
 * @example
 * ```ts
 * import { defineTool } from "@repo/oliver";
 * import { z } from "zod";
 *
 * export const applyDiscount = defineTool({
 *   name: "applyDiscount",
 *   description: "Apply a percentage discount to a quote",
 *   input: z.object({
 *     quoteId: z.string(),
 *     percent: z.number().min(0).max(100),
 *   }),
 *   requiresApproval: true,
 *   previewChange: async ({ input, ctx }) => {
 *     const [quote] = await ctx.db.select(...)...
 *     return {
 *       before: { total: quote.total },
 *       after: { total: quote.total * (1 - input.percent / 100) },
 *     };
 *   },
 *   execute: async ({ input, ctx }) => {
 *     await ctx.db.update(quotes).set({ discountPct: String(input.percent) })...
 *     return { applied: true };
 *   },
 *   verify: async ({ input, ctx }) => {
 *     const [quote] = await ctx.db.select(...)...
 *     return quote?.discountPct === String(input.percent);
 *   },
 * });
 * ```
 */
export function defineTool<
  TInput extends z.ZodTypeAny,
  TOutput,
  TContextExt = Record<string, never>,
>(
  tool: Tool<TInput, TOutput, TContextExt>,
): Tool<TInput, TOutput, TContextExt> {
  // v0: identity function with type inference. Future versions may add
  // registration side effects (e.g., auto-register in a module-level map)
  // but for v0 we use explicit registry (tools/index.ts exports).
  return tool;
}

/**
 * Extract the output type from a Tool. Useful when the builder wants to
 * reference the return type of a tool elsewhere in their code.
 */
export type ToolOutput<T> = T extends Tool<infer _I, infer O, infer _C>
  ? O
  : never;

/**
 * Extract the input type from a Tool. Useful when the builder wants to
 * reference the input type elsewhere.
 */
export type ToolInput<T> = T extends Tool<infer I, infer _O, infer _C>
  ? z.infer<I>
  : never;
