/**
 * Approve / Reject pending tools.
 *
 * These are generic dispatchers exposed as server actions on the Agent.
 * Kotte (and any other builder) wires the approval card UI to them without
 * writing tool-specific code — any requiresApproval=true tool flows through
 * the same approve/reject path.
 *
 * Lifecycle on approve:
 *   pending_approval → executing → succeeded | failed | failed_verification
 *
 *   1. Resolve UI context (auth) via agent._resolveServerActionContext
 *   2. Look up the pending row, authorize (orgId match), validate status
 *   3. Mark executing + audit (status=approved)
 *   4. Run tool.execute({ input: pending.input, ctx })
 *   5. Mark succeeded/failed + audit
 *   6. Run verify() if defined (5s timeout, see audit/verify)
 *
 * Lifecycle on reject:
 *   pending_approval → rejected (tool never runs)
 *
 * Errors during execute are caught and reported; the pending row is flipped
 * to 'failed' so the UI can show the outcome. We never throw from these
 * server actions — they always return ServerActionResult discriminated union.
 *
 * Traces are tied via pendingToolId, not traceId: the original proposal
 * recorded `pending_approval` under one traceId; approval creates a new
 * traceId but the same pendingToolId, so a query `WHERE pending_tool_id = X`
 * reconstructs the full story.
 */

import { newTraceId } from "../audit/logger";
import { runVerify } from "../audit/verify";
import { withLock } from "../concurrency/mutex";
import type { ToolContext } from "../core/context";
import { ToolError, wrapError } from "../core/errors";
import type { Agent } from "../gateway/createAgent";
import type { ServerActionResult } from "../gateway/serverAction";

export interface ApprovePendingToolInput {
  pendingToolId: string;
}

export interface RejectPendingToolInput {
  pendingToolId: string;
  /** Optional short reason stored on the audit row. Not shown to the LLM in v0. */
  reason?: string;
}

export async function approvePendingToolImpl<TContextExt>(
  agent: Agent<TContextExt>,
  input: ApprovePendingToolInput,
  ctxOverride?: Partial<TContextExt>
): Promise<ServerActionResult<unknown>> {
  if (!agent._pending) {
    return {
      ok: false,
      error: new ToolError({
        code: "unexpected",
        toolName: "approvePendingTool",
        message:
          "Oliver was not configured with `db` — approval requires oliver.pending_tools persistence.",
      }).toJSON(),
    };
  }

  // Resolve auth context first — the UI is trusted but we still need userId
  // for audit and to stamp `approvedBy` on the pending row.
  let ctx: ToolContext<TContextExt>;
  try {
    const resolved = await agent._resolveServerActionContext(ctxOverride);
    ctx = {
      ...resolved,
      ...(ctxOverride ?? {}),
      source: "ui" as const,
    };
  } catch (err) {
    const wrapped =
      err instanceof ToolError ? err : wrapError("approvePendingTool", err);
    return { ok: false, error: wrapped.toJSON() };
  }

  const pending = await agent._pending.getById(input.pendingToolId);
  if (!pending) {
    return {
      ok: false,
      error: new ToolError({
        code: "not_found",
        toolName: "approvePendingTool",
        message: `Pending tool not found: ${input.pendingToolId}`,
      }).toJSON(),
    };
  }

  // Authorization: the approver must belong to the same org as the proposal.
  if (pending.orgId !== ctx.orgId) {
    return {
      ok: false,
      error: new ToolError({
        code: "authorization",
        toolName: "approvePendingTool",
        message: "Cannot approve a pending tool from another organization.",
      }).toJSON(),
    };
  }

  if (pending.status !== "pending_approval") {
    return {
      ok: false,
      error: new ToolError({
        code: "conflict",
        toolName: "approvePendingTool",
        message: `Cannot approve: pending tool is in status "${pending.status}".`,
      }).toJSON(),
    };
  }

  if (pending.expiresAt.getTime() < Date.now()) {
    return {
      ok: false,
      error: new ToolError({
        code: "timeout",
        toolName: "approvePendingTool",
        message: "Pending tool expired before approval.",
      }).toJSON(),
    };
  }

  const tool = agent.getTool(pending.toolName);
  if (!tool) {
    return {
      ok: false,
      error: new ToolError({
        code: "not_found",
        toolName: "approvePendingTool",
        message: `Tool "${pending.toolName}" is not registered on this agent.`,
      }).toJSON(),
    };
  }

  const traceId = newTraceId();
  const startedAt = Date.now();

  // Re-run precondition at approve time. The HITL race we're catching:
  // agent proposes at 10:00, precondition passes, user sees card. Someone
  // (or the user themselves in another tab) changes domain state at 10:05
  // that now makes the operation invalid. User clicks Approve at 10:10 —
  // without this re-check, we'd proceed to execute() against stale state.
  if (tool.precondition) {
    try {
      await tool.precondition({ input: pending.input as never, ctx });
    } catch (err) {
      const wrapped =
        err instanceof ToolError ? err : wrapError(pending.toolName, err);
      await agent._pending.markFailed(pending.id, wrapped.message);
      void agent._audit?.record({
        traceId,
        orgId: ctx.orgId,
        userId: ctx.userId,
        toolName: pending.toolName,
        source: "ui",
        status: "failed",
        inputHash: pending.inputHash,
        input: pending.input,
        errorMessage: wrapped.message,
        errorCode: wrapped.code,
        pendingToolId: pending.id,
      });
      return { ok: false, error: wrapped.toJSON() };
    }
  }

  await agent._pending.markExecuting(pending.id, ctx.userId);

  // Audit: approved → invoked (pair emitted before execute so the lifecycle
  // is visible even if execute hangs).
  void agent._audit?.record({
    traceId,
    orgId: ctx.orgId,
    userId: ctx.userId,
    toolName: pending.toolName,
    source: "ui",
    status: "approved",
    inputHash: pending.inputHash,
    pendingToolId: pending.id,
  });
  void agent._audit?.record({
    traceId,
    orgId: ctx.orgId,
    userId: ctx.userId,
    toolName: pending.toolName,
    source: "ui",
    status: "invoked",
    inputHash: pending.inputHash,
    input: pending.input,
    pendingToolId: pending.id,
  });

  // Concurrency key (optional). Two approvals in different tabs hitting
  // the same resource must not race — wrap execute() in the same mutex
  // the agent-channel uses.
  let lockKey: string | undefined;
  if (tool.concurrencyKey) {
    try {
      lockKey = tool.concurrencyKey({ input: pending.input as never, ctx });
    } catch (err) {
      const wrapped =
        err instanceof ToolError ? err : wrapError(pending.toolName, err);
      await agent._pending.markFailed(pending.id, wrapped.message);
      void agent._audit?.record({
        traceId,
        orgId: ctx.orgId,
        userId: ctx.userId,
        toolName: pending.toolName,
        source: "ui",
        status: "failed",
        inputHash: pending.inputHash,
        input: pending.input,
        errorMessage: wrapped.message,
        errorCode: wrapped.code,
        pendingToolId: pending.id,
      });
      return { ok: false, error: wrapped.toJSON() };
    }
  }

  try {
    const runExecute = () =>
      tool.execute({ input: pending.input as never, ctx });
    const result = lockKey
      ? await withLock(lockKey, runExecute)
      : await runExecute();
    const latencyMs = Date.now() - startedAt;

    await agent._pending.markSucceeded(pending.id, result);

    void agent._audit?.record({
      traceId,
      orgId: ctx.orgId,
      userId: ctx.userId,
      toolName: pending.toolName,
      source: "ui",
      status: "succeeded",
      inputHash: pending.inputHash,
      input: pending.input,
      output: result,
      latencyMs,
      pendingToolId: pending.id,
    });

    if (tool.verify) {
      const verifyFn = tool.verify;
      const verifyResult = await runVerify(() =>
        verifyFn({
          input: pending.input as never,
          result: result as never,
          ctx,
        })
      );
      void agent._audit?.record({
        traceId,
        orgId: ctx.orgId,
        userId: ctx.userId,
        toolName: pending.toolName,
        source: "ui",
        status: verifyResult.outcome,
        inputHash: pending.inputHash,
        errorMessage: verifyResult.error,
        pendingToolId: pending.id,
      });
    }

    return { ok: true, data: result };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const wrapped =
      err instanceof ToolError ? err : wrapError(pending.toolName, err);

    await agent._pending.markFailed(pending.id, wrapped.message);

    void agent._audit?.record({
      traceId,
      orgId: ctx.orgId,
      userId: ctx.userId,
      toolName: pending.toolName,
      source: "ui",
      status: "failed",
      inputHash: pending.inputHash,
      input: pending.input,
      latencyMs,
      errorMessage: wrapped.message,
      errorCode: wrapped.code,
      pendingToolId: pending.id,
    });

    return { ok: false, error: wrapped.toJSON() };
  }
}

export async function rejectPendingToolImpl<TContextExt>(
  agent: Agent<TContextExt>,
  input: RejectPendingToolInput,
  ctxOverride?: Partial<TContextExt>
): Promise<ServerActionResult<{ rejected: true }>> {
  if (!agent._pending) {
    return {
      ok: false,
      error: new ToolError({
        code: "unexpected",
        toolName: "rejectPendingTool",
        message:
          "Oliver was not configured with `db` — rejection requires oliver.pending_tools persistence.",
      }).toJSON(),
    };
  }

  let ctx: ToolContext<TContextExt>;
  try {
    const resolved = await agent._resolveServerActionContext(ctxOverride);
    ctx = {
      ...resolved,
      ...(ctxOverride ?? {}),
      source: "ui" as const,
    };
  } catch (err) {
    const wrapped =
      err instanceof ToolError ? err : wrapError("rejectPendingTool", err);
    return { ok: false, error: wrapped.toJSON() };
  }

  const pending = await agent._pending.getById(input.pendingToolId);
  if (!pending) {
    return {
      ok: false,
      error: new ToolError({
        code: "not_found",
        toolName: "rejectPendingTool",
        message: `Pending tool not found: ${input.pendingToolId}`,
      }).toJSON(),
    };
  }

  if (pending.orgId !== ctx.orgId) {
    return {
      ok: false,
      error: new ToolError({
        code: "authorization",
        toolName: "rejectPendingTool",
        message: "Cannot reject a pending tool from another organization.",
      }).toJSON(),
    };
  }

  if (pending.status !== "pending_approval") {
    return {
      ok: false,
      error: new ToolError({
        code: "conflict",
        toolName: "rejectPendingTool",
        message: `Cannot reject: pending tool is in status "${pending.status}".`,
      }).toJSON(),
    };
  }

  await agent._pending.markRejected(pending.id, ctx.userId);

  void agent._audit?.record({
    traceId: newTraceId(),
    orgId: ctx.orgId,
    userId: ctx.userId,
    toolName: pending.toolName,
    source: "ui",
    status: "rejected",
    inputHash: pending.inputHash,
    pendingToolId: pending.id,
    errorMessage: input.reason,
  });

  return { ok: true, data: { rejected: true } };
}
