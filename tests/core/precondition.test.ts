import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolError } from "../../src/core/errors";
import { createAgent } from "../../src/gateway/createAgent";
import { defineTool } from "../../src/core/defineTool";
import type { ToolContext } from "../../src/core/context";
import type { DrizzleDbLike } from "../../src/db/types";

type TestCtxExt = { note?: string };
type TestContext = ToolContext<TestCtxExt>;

const makeCtx = (overrides: Partial<TestContext> = {}): TestContext => ({
  orgId: "org_test",
  userId: "usr_test",
  source: "agent",
  ...overrides,
});

/**
 * Minimal DB mock — same shape as used in other tests, returns configurable
 * rows from select() and records inserts/updates so we can assert which
 * lifecycle events Oliver emitted.
 */
function makeFakeDb(opts: { selectRows?: unknown[] } = {}): {
  db: DrizzleDbLike;
  inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
  updates: Array<{ values: Record<string, unknown> }>;
} {
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> =
    [];
  const updates: Array<{ values: Record<string, unknown> }> = [];
  const selectRows = opts.selectRows ?? [];
  const db: DrizzleDbLike = {
    insert: (table) => ({
      values: async (v: Record<string, unknown>) => {
        inserts.push({ table, values: v });
      },
    }),
    select: () => ({
      from: () => {
        const result: any = Promise.resolve(selectRows);
        result.where = () => {
          const awaitable: any = Promise.resolve(selectRows);
          awaitable.orderBy = () => Promise.resolve(selectRows);
          return awaitable;
        };
        result.orderBy = () => Promise.resolve(selectRows);
        return result;
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ values: v });
        },
      }),
    }),
  };
  return { db, inserts, updates };
}

describe("precondition — non-HITL (agent channel)", () => {
  it("blocks execute and records a failed audit row", async () => {
    const { db, inserts } = makeFakeDb();
    let executeCount = 0;

    const guarded = defineTool<
      z.ZodObject<{ id: z.ZodString }>,
      { done: boolean },
      TestCtxExt
    >({
      name: "guarded",
      description: "",
      input: z.object({ id: z.string() }),
      precondition: async ({ input }) => {
        if (input.id === "blocked") {
          throw new ToolError({
            code: "conflict",
            toolName: "guarded",
            message: "Resource is locked",
          });
        }
      },
      execute: async () => {
        executeCount += 1;
        return { done: true };
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [guarded],
      db,
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });
    const tools = agent.agentTools({ ctx: makeCtx() });

    const result = await (tools.guarded as any).execute({ id: "blocked" });

    expect(result.status).toBe("error");
    expect(result.error.code).toBe("conflict");
    expect(result.error.message).toBe("Resource is locked");
    expect(executeCount).toBe(0);

    // Audit must record the block — we care that a "failed" row was emitted
    // with the precondition's error code.
    const auditInserts = inserts.filter(
      (i) => (i.values as any).toolName === "guarded",
    );
    expect(auditInserts.length).toBe(1);
    expect(auditInserts[0].values.status).toBe("failed");
    expect(auditInserts[0].values.errorCode).toBe("conflict");
  });

  it("passes through to execute when precondition resolves", async () => {
    const { db } = makeFakeDb();
    let executeCount = 0;
    const tool = defineTool<
      z.ZodObject<{ id: z.ZodString }>,
      { done: boolean },
      TestCtxExt
    >({
      name: "tool",
      description: "",
      input: z.object({ id: z.string() }),
      precondition: async () => {
        /* all good */
      },
      execute: async () => {
        executeCount += 1;
        return { done: true };
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [tool],
      db,
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });
    const tools = agent.agentTools({ ctx: makeCtx() });

    const result = await (tools.tool as any).execute({ id: "ok" });

    expect(result.status).toBe("ok");
    expect(executeCount).toBe(1);
  });
});

describe("precondition — HITL propose path (agent channel)", () => {
  it("blocks BEFORE previewChange and BEFORE creating pending row", async () => {
    const { db, inserts } = makeFakeDb();
    let previewCount = 0;
    let executeCount = 0;

    const sensitive = defineTool<
      z.ZodObject<{ id: z.ZodString }>,
      { done: boolean },
      TestCtxExt
    >({
      name: "sensitive",
      description: "",
      input: z.object({ id: z.string() }),
      requiresApproval: true,
      precondition: async () => {
        throw new ToolError({
          code: "conflict",
          toolName: "sensitive",
          message: "Quote is published",
        });
      },
      previewChange: async () => {
        previewCount += 1;
        return { before: {}, after: {} };
      },
      execute: async () => {
        executeCount += 1;
        return { done: true };
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [sensitive],
      db,
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });
    const tools = agent.agentTools({ ctx: makeCtx() });

    const result = await (tools.sensitive as any).execute({ id: "q1" });

    expect(result.status).toBe("error");
    expect(result.error.code).toBe("conflict");
    expect(result.error.message).toBe("Quote is published");
    expect(previewCount).toBe(0);
    expect(executeCount).toBe(0);

    // No pending_tools row inserted. Only the "failed" audit row.
    const pendingInserts = inserts.filter(
      (i) => (i.values as any).toolName === "sensitive",
    );
    expect(pendingInserts.length).toBe(1);
    expect(pendingInserts[0].values.status).toBe("failed");
  });
});

describe("precondition — HITL approve path", () => {
  it("re-checks precondition at approve time and blocks if state changed", async () => {
    // Pending row exists (propose succeeded), but now at approve time the
    // quote has since been published.
    const pendingRow = {
      id: "hpt_race_xxxxxxxxxxxxxxxx",
      orgId: "org_test",
      userId: "usr_requester",
      toolName: "applyDiscount",
      input: { quoteId: "qot_1", percent: 10 },
      inputHash: "h",
      status: "pending_approval",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      previewBefore: null,
      previewAfter: null,
      approvedBy: null,
      rejectedBy: null,
      result: null,
      errorMessage: null,
      proposedBy: "agent",
    };
    const { db, updates } = makeFakeDb({ selectRows: [pendingRow] });

    let executeCount = 0;
    const applyDiscount = defineTool<
      z.ZodObject<{ quoteId: z.ZodString; percent: z.ZodNumber }>,
      { applied: boolean },
      TestCtxExt
    >({
      name: "applyDiscount",
      description: "",
      input: z.object({ quoteId: z.string(), percent: z.number() }),
      requiresApproval: true,
      precondition: async () => {
        // Simulates: between propose and approve, the quote got published.
        throw new ToolError({
          code: "conflict",
          toolName: "applyDiscount",
          message: "Quote is now published",
        });
      },
      execute: async () => {
        executeCount += 1;
        return { applied: true };
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [applyDiscount],
      db,
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const result = await agent.approvePendingTool({
      pendingToolId: pendingRow.id,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("conflict");
      expect(result.error.message).toBe("Quote is now published");
    }
    expect(executeCount).toBe(0);

    // Pending row should be marked failed (NOT succeeded).
    expect(updates.length).toBe(1);
    expect(updates[0].values.status).toBe("failed");
    expect(updates[0].values.errorMessage).toBe("Quote is now published");
  });

  it("runs execute normally when precondition still passes at approve time", async () => {
    const pendingRow = {
      id: "hpt_ok_xxxxxxxxxxxxxxxxxx",
      orgId: "org_test",
      userId: "usr_requester",
      toolName: "applyDiscount",
      input: { quoteId: "qot_1", percent: 10 },
      inputHash: "h",
      status: "pending_approval",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      previewBefore: null,
      previewAfter: null,
      approvedBy: null,
      rejectedBy: null,
      result: null,
      errorMessage: null,
      proposedBy: "agent",
    };
    const { db } = makeFakeDb({ selectRows: [pendingRow] });

    let executeCount = 0;
    const applyDiscount = defineTool<
      z.ZodObject<{ quoteId: z.ZodString; percent: z.ZodNumber }>,
      { applied: boolean },
      TestCtxExt
    >({
      name: "applyDiscount",
      description: "",
      input: z.object({ quoteId: z.string(), percent: z.number() }),
      requiresApproval: true,
      precondition: async () => {
        /* still ok */
      },
      execute: async () => {
        executeCount += 1;
        return { applied: true };
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [applyDiscount],
      db,
      resolveServerActionContext: async () => makeCtx({ source: "ui" }),
    });

    const result = await agent.approvePendingTool({
      pendingToolId: pendingRow.id,
    });

    expect(result.ok).toBe(true);
    expect(executeCount).toBe(1);
  });
});

describe("precondition — server action channel", () => {
  it("blocks the UI path too", async () => {
    const { db, inserts } = makeFakeDb();
    let executeCount = 0;

    const tool = defineTool<
      z.ZodObject<{ id: z.ZodString }>,
      { done: boolean },
      TestCtxExt
    >({
      name: "guarded",
      description: "",
      input: z.object({ id: z.string() }),
      precondition: async () => {
        throw new ToolError({
          code: "conflict",
          toolName: "guarded",
          message: "Locked",
        });
      },
      execute: async () => {
        executeCount += 1;
        return { done: true };
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [tool],
      db,
      resolveServerActionContext: async () => makeCtx({ source: "ui" }),
    });

    const action = agent.serverAction(tool);
    const result = await action({ id: "x" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("conflict");
    }
    expect(executeCount).toBe(0);

    const auditInserts = inserts.filter(
      (i) => (i.values as any).toolName === "guarded",
    );
    expect(auditInserts.length).toBe(1);
    expect(auditInserts[0].values.status).toBe("failed");
    expect(auditInserts[0].values.source).toBe("ui");
  });
});
