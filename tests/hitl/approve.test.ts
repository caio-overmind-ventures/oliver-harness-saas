import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent } from "../../src/gateway/createAgent";
import { defineTool } from "../../src/core/defineTool";
import type { ToolContext } from "../../src/core/context";
import type { DrizzleDbLike } from "../../src/db/types";

type TestCtxExt = { db: { log: (msg: string) => void } };
type TestContext = ToolContext<TestCtxExt>;

const makeCtx = (overrides: Partial<TestContext> = {}): TestContext => ({
  orgId: "org_test",
  userId: "usr_approver",
  source: "ui",
  db: { log: () => {} },
  ...overrides,
});

/**
 * Mock DB that returns a configurable pending row by id and records updates.
 * `getRow` lets us assert the current state of the pending row at each step.
 */
function makeFakeDb(opts: {
  pendingRow?: Record<string, unknown> | null;
} = {}): {
  db: DrizzleDbLike;
  inserts: Array<Record<string, unknown>>;
  updates: Array<{ values: Record<string, unknown> }>;
  pendingRow: Record<string, unknown> | null;
} {
  const state = {
    pendingRow: opts.pendingRow ?? null,
  };
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ values: Record<string, unknown> }> = [];

  const db: DrizzleDbLike = {
    insert: (_table) => ({
      values: async (v: Record<string, unknown>) => {
        inserts.push(v);
      },
    }),
    select: () => ({
      from: (_table) => {
        const rows = state.pendingRow ? [state.pendingRow] : [];
        const result: any = Promise.resolve(rows);
        result.where = () => {
          const awaitable: any = Promise.resolve(rows);
          awaitable.orderBy = () => Promise.resolve(rows);
          return awaitable;
        };
        result.orderBy = () => Promise.resolve(rows);
        return result;
      },
    }),
    update: (_table) => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ values: v });
          // Mutate the in-memory row so subsequent selects reflect the update.
          if (state.pendingRow) {
            state.pendingRow = { ...state.pendingRow, ...v };
          }
        },
      }),
    }),
  };

  return {
    db,
    inserts,
    updates,
    get pendingRow() {
      return state.pendingRow;
    },
  } as any;
}

describe("approvePendingTool", () => {
  it("runs the tool and flips the pending row to succeeded", async () => {
    const pending = {
      id: "hpt_abc123456789012345678",
      orgId: "org_test",
      userId: "usr_requester",
      toolName: "applyDiscount",
      input: { quoteId: "q1", percent: 10 },
      inputHash: "hash123",
      previewBefore: { total: 100 },
      previewAfter: { total: 90 },
      status: "pending_approval",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      approvedBy: null,
      rejectedBy: null,
      result: null,
      errorMessage: null,
      proposedBy: "agent",
    };
    const fake = makeFakeDb({ pendingRow: pending });

    let executeCalled = false;
    const applyDiscount = defineTool<
      z.ZodObject<{ quoteId: z.ZodString; percent: z.ZodNumber }>,
      { applied: true },
      TestCtxExt
    >({
      name: "applyDiscount",
      description: "Apply discount",
      input: z.object({ quoteId: z.string(), percent: z.number() }),
      requiresApproval: true,
      execute: async () => {
        executeCalled = true;
        return { applied: true };
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [applyDiscount],
      db: fake.db,
      resolveServerActionContext: async () => makeCtx(),
    });

    const result = await agent.approvePendingTool({
      pendingToolId: pending.id,
    });

    expect(result.ok).toBe(true);
    expect(executeCalled).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ applied: true });
    }

    // 2 updates: markExecuting, markSucceeded.
    expect(fake.updates.length).toBe(2);
    expect(fake.updates[0].values.status).toBe("executing");
    expect(fake.updates[0].values.approvedBy).toBe("usr_approver");
    expect(fake.updates[1].values.status).toBe("succeeded");
    expect(fake.updates[1].values.result).toEqual({ applied: true });
  });

  it("marks the row as failed if the tool throws", async () => {
    const pending = {
      id: "hpt_fail_xxxxxxxxxxxxxxxxx",
      orgId: "org_test",
      toolName: "brokenTool",
      input: {},
      inputHash: "h",
      status: "pending_approval",
      expiresAt: new Date(Date.now() + 60_000),
      previewBefore: null,
      previewAfter: null,
    };
    const fake = makeFakeDb({ pendingRow: pending });

    const brokenTool = defineTool<z.ZodObject<{}>, unknown, TestCtxExt>({
      name: "brokenTool",
      description: "always throws",
      input: z.object({}),
      requiresApproval: true,
      execute: async () => {
        throw new Error("kaboom");
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [brokenTool],
      db: fake.db,
      resolveServerActionContext: async () => makeCtx(),
    });

    const result = await agent.approvePendingTool({
      pendingToolId: pending.id,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("kaboom");
    }
    expect(fake.updates[fake.updates.length - 1].values.status).toBe("failed");
    expect(fake.updates[fake.updates.length - 1].values.errorMessage).toBe(
      "kaboom",
    );
  });

  it("refuses to approve a pending row from a different org", async () => {
    const pending = {
      id: "hpt_xorg_xxxxxxxxxxxxxxxx",
      orgId: "org_OTHER",
      toolName: "applyDiscount",
      input: {},
      inputHash: "h",
      status: "pending_approval",
      expiresAt: new Date(Date.now() + 60_000),
    };
    const fake = makeFakeDb({ pendingRow: pending });

    const applyDiscount = defineTool<z.ZodObject<{}>, unknown, TestCtxExt>({
      name: "applyDiscount",
      description: "",
      input: z.object({}),
      requiresApproval: true,
      execute: async () => ({}),
    });

    const agent = createAgent<TestCtxExt>({
      tools: [applyDiscount],
      db: fake.db,
      resolveServerActionContext: async () => makeCtx({ orgId: "org_test" }),
    });

    const result = await agent.approvePendingTool({
      pendingToolId: pending.id,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("authorization");
    }
    // No updates should have happened.
    expect(fake.updates.length).toBe(0);
  });

  it("refuses to approve an already-resolved row", async () => {
    const pending = {
      id: "hpt_resolved_xxxxxxxxxxxx",
      orgId: "org_test",
      toolName: "applyDiscount",
      input: {},
      inputHash: "h",
      status: "succeeded", // already run
      expiresAt: new Date(Date.now() + 60_000),
    };
    const fake = makeFakeDb({ pendingRow: pending });

    const applyDiscount = defineTool<z.ZodObject<{}>, unknown, TestCtxExt>({
      name: "applyDiscount",
      description: "",
      input: z.object({}),
      requiresApproval: true,
      execute: async () => ({}),
    });

    const agent = createAgent<TestCtxExt>({
      tools: [applyDiscount],
      db: fake.db,
      resolveServerActionContext: async () => makeCtx(),
    });

    const result = await agent.approvePendingTool({
      pendingToolId: pending.id,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("conflict");
    }
  });

  it("refuses to approve an expired row", async () => {
    const pending = {
      id: "hpt_expired_xxxxxxxxxxxxx",
      orgId: "org_test",
      toolName: "applyDiscount",
      input: {},
      inputHash: "h",
      status: "pending_approval",
      expiresAt: new Date(Date.now() - 1000), // 1s in the past
    };
    const fake = makeFakeDb({ pendingRow: pending });

    const applyDiscount = defineTool<z.ZodObject<{}>, unknown, TestCtxExt>({
      name: "applyDiscount",
      description: "",
      input: z.object({}),
      requiresApproval: true,
      execute: async () => ({}),
    });

    const agent = createAgent<TestCtxExt>({
      tools: [applyDiscount],
      db: fake.db,
      resolveServerActionContext: async () => makeCtx(),
    });

    const result = await agent.approvePendingTool({
      pendingToolId: pending.id,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("timeout");
    }
  });

  it("returns not_found when the pending id doesn't exist", async () => {
    const fake = makeFakeDb({ pendingRow: null });

    const agent = createAgent<TestCtxExt>({
      tools: [],
      db: fake.db,
      resolveServerActionContext: async () => makeCtx(),
    });

    const result = await agent.approvePendingTool({
      pendingToolId: "hpt_nonexistent",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
    }
  });

  it("returns error when Oliver has no db configured", async () => {
    const agent = createAgent<TestCtxExt>({
      tools: [],
      resolveServerActionContext: async () => makeCtx(),
    });

    const result = await agent.approvePendingTool({
      pendingToolId: "hpt_any",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("was not configured with `db`");
    }
  });
});

describe("rejectPendingTool", () => {
  it("flips status to rejected and never runs the tool", async () => {
    const pending = {
      id: "hpt_rejected_xxxxxxxxxxxx",
      orgId: "org_test",
      toolName: "applyDiscount",
      input: {},
      inputHash: "h",
      status: "pending_approval",
      expiresAt: new Date(Date.now() + 60_000),
    };
    const fake = makeFakeDb({ pendingRow: pending });

    let executeCalled = false;
    const applyDiscount = defineTool<z.ZodObject<{}>, unknown, TestCtxExt>({
      name: "applyDiscount",
      description: "",
      input: z.object({}),
      requiresApproval: true,
      execute: async () => {
        executeCalled = true;
        return {};
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [applyDiscount],
      db: fake.db,
      resolveServerActionContext: async () => makeCtx(),
    });

    const result = await agent.rejectPendingTool({
      pendingToolId: pending.id,
      reason: "Too risky",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ rejected: true });
    }
    expect(executeCalled).toBe(false);
    expect(fake.updates.length).toBe(1);
    expect(fake.updates[0].values.status).toBe("rejected");
    expect(fake.updates[0].values.rejectedBy).toBe("usr_approver");
  });

  it("refuses to reject a row from a different org", async () => {
    const pending = {
      id: "hpt_xorg_rxxxxxxxxxxxxxxx",
      orgId: "org_OTHER",
      toolName: "applyDiscount",
      input: {},
      inputHash: "h",
      status: "pending_approval",
      expiresAt: new Date(Date.now() + 60_000),
    };
    const fake = makeFakeDb({ pendingRow: pending });

    const agent = createAgent<TestCtxExt>({
      tools: [],
      db: fake.db,
      resolveServerActionContext: async () => makeCtx({ orgId: "org_test" }),
    });

    const result = await agent.rejectPendingTool({
      pendingToolId: pending.id,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("authorization");
    }
  });
});

describe("listPendingTools", () => {
  it("returns active rows for the org", async () => {
    const rows = [
      { id: "hpt_a", orgId: "org_test", status: "pending_approval" },
      { id: "hpt_b", orgId: "org_test", status: "pending_approval" },
    ];
    const fake = makeFakeDb({ pendingRow: rows[0] });
    // Override select to return multiple rows for listActive.
    fake.db.select = () => ({
      from: () => {
        const result: any = Promise.resolve(rows);
        result.where = () => {
          const awaitable: any = Promise.resolve(rows);
          awaitable.orderBy = () => Promise.resolve(rows);
          return awaitable;
        };
        result.orderBy = () => Promise.resolve(rows);
        return result;
      },
    });

    const agent = createAgent({
      tools: [],
      db: fake.db,
      resolveServerActionContext: async () => ({
        orgId: "org_test",
        userId: "u",
        source: "ui",
      }),
    });

    const result = await agent.listPendingTools("org_test");
    expect(result.length).toBe(2);
  });

  it("returns empty array when no db configured", async () => {
    const agent = createAgent({
      tools: [],
      resolveServerActionContext: async () => ({
        orgId: "org_test",
        userId: "u",
        source: "ui",
      }),
    });

    const result = await agent.listPendingTools("org_test");
    expect(result).toEqual([]);
  });
});
