import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent } from "../../src/gateway/createAgent";
import { defineTool } from "../../src/core/defineTool";
import type { ToolContext } from "../../src/core/context";
import type { DrizzleDbLike } from "../../src/db/types";

type TestCtxExt = { db: { get: (id: string) => string } };
type TestContext = ToolContext<TestCtxExt>;

const makeCtx = (): TestContext => ({
  orgId: "org_test",
  userId: "usr_test",
  source: "agent",
  db: { get: (id: string) => `record-${id}` },
});

/**
 * Minimal DrizzleDbLike mock that captures inserts/selects/updates so tests
 * can assert on what Oliver tried to persist. `select().from().where()`
 * returns the array configured via `stubSelectResult` (default: []), so the
 * re-invocation guard reads "no existing pending" unless we set it.
 */
function makeFakeDb(opts: {
  selectRows?: unknown[];
} = {}): {
  db: DrizzleDbLike;
  inserts: Array<{ table: unknown; values: unknown }>;
  updates: Array<{ table: unknown; values: unknown; where: unknown }>;
  whereArgs: unknown[];
} {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const updates: Array<{ table: unknown; values: unknown; where: unknown }> =
    [];
  const whereArgs: unknown[] = [];
  const selectRows = opts.selectRows ?? [];

  const db: DrizzleDbLike = {
    insert: (table) => ({
      values: async (v) => {
        inserts.push({ table, values: v });
      },
    }),
    select: () => ({
      from: (_table) => {
        const result: any = Promise.resolve(selectRows);
        result.where = (cond: unknown) => {
          whereArgs.push(cond);
          const awaitable: any = Promise.resolve(selectRows);
          awaitable.orderBy = () => Promise.resolve(selectRows);
          return awaitable;
        };
        result.orderBy = () => Promise.resolve(selectRows);
        return result;
      },
    }),
    update: (table) => ({
      set: (v) => ({
        where: async (cond) => {
          updates.push({ table, values: v, where: cond });
        },
      }),
    }),
  };

  return { db, inserts, updates, whereArgs };
}

describe("agentTools channel", () => {
  it("builds a record keyed by tool name", () => {
    const a = defineTool<z.ZodObject<{}>, string, TestCtxExt>({
      name: "toolA",
      description: "A",
      input: z.object({}),
      execute: async () => "A-result",
    });
    const b = defineTool<z.ZodObject<{}>, string, TestCtxExt>({
      name: "toolB",
      description: "B",
      input: z.object({}),
      execute: async () => "B-result",
    });

    const agent = createAgent<TestCtxExt>({
      tools: [a, b],
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const tools = agent.agentTools({ ctx: makeCtx() });
    expect(Object.keys(tools).sort()).toEqual(["toolA", "toolB"]);
  });

  it("forces source=agent even if caller passed something else", async () => {
    const probe = defineTool<z.ZodObject<{}>, { source: string }, TestCtxExt>({
      name: "probe",
      description: "Probe source",
      input: z.object({}),
      execute: async ({ ctx }) => ({ source: ctx.source }),
    });

    const agent = createAgent<TestCtxExt>({
      tools: [probe],
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const tools = agent.agentTools({
      ctx: { ...makeCtx(), source: "ui" as any },
    });
    const result = await (tools.probe as any).execute({});

    expect(result.status).toBe("ok");
    expect(result.data.source).toBe("agent");
  });

  it("inserts pending row and returns awaiting_approval when requiresApproval=true", async () => {
    const { db, inserts } = makeFakeDb();
    let executedCount = 0;
    const sensitive = defineTool<
      z.ZodObject<{ amount: z.ZodNumber }>,
      { done: boolean },
      TestCtxExt
    >({
      name: "sensitive",
      description: "Needs approval",
      input: z.object({ amount: z.number() }),
      requiresApproval: true,
      execute: async () => {
        executedCount += 1;
        return { done: true };
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [sensitive],
      db,
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const tools = agent.agentTools({ ctx: makeCtx() });
    const result = await (tools.sensitive as any).execute({ amount: 30 });

    expect(result.status).toBe("awaiting_approval");
    expect(result.toolName).toBe("sensitive");
    expect(result.pendingToolId).toMatch(/^hpt_/);
    expect(result.input).toEqual({ amount: 30 });
    expect(result.message).toContain("Awaiting human approval");
    expect(executedCount).toBe(0);

    // One pending row + one audit row (pending_approval).
    expect(inserts.length).toBeGreaterThanOrEqual(1);
    const pendingInsert = inserts.find(
      (i) => (i.values as any).toolName === "sensitive",
    );
    expect(pendingInsert).toBeDefined();
    expect((pendingInsert!.values as any).status).toBe("pending_approval");
    expect((pendingInsert!.values as any).orgId).toBe("org_test");
    expect((pendingInsert!.values as any).inputHash).toBeDefined();
  });

  it("returns existing pending id on re-proposal (DB-level dedup guard)", async () => {
    const existing = {
      id: "hpt_existingAAAAAAAAAAAAAAAAA",
      orgId: "org_test",
      toolName: "sensitive",
      inputHash: "whatever",
      input: { amount: 30 },
      status: "pending_approval",
      expiresAt: new Date(Date.now() + 60_000),
    };
    const { db, inserts } = makeFakeDb({ selectRows: [existing] });

    const sensitive = defineTool<
      z.ZodObject<{ amount: z.ZodNumber }>,
      { done: boolean },
      TestCtxExt
    >({
      name: "sensitive",
      description: "Needs approval",
      input: z.object({ amount: z.number() }),
      requiresApproval: true,
      execute: async () => ({ done: true }),
    });

    const agent = createAgent<TestCtxExt>({
      tools: [sensitive],
      db,
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const tools = agent.agentTools({ ctx: makeCtx() });
    const result = await (tools.sensitive as any).execute({ amount: 30 });

    expect(result.status).toBe("awaiting_approval");
    expect(result.pendingToolId).toBe(existing.id);
    expect(result.message).toContain("Already awaiting approval");
    // No new pending row inserted — existing was reused.
    const newPendingInserts = inserts.filter(
      (i) => (i.values as any).toolName === "sensitive" && (i.values as any).id,
    );
    expect(newPendingInserts.length).toBe(0);
  });

  it("errors when requiresApproval=true but no db configured", async () => {
    const sensitive = defineTool<z.ZodObject<{}>, unknown, TestCtxExt>({
      name: "sensitive",
      description: "Needs approval",
      input: z.object({}),
      requiresApproval: true,
      execute: async () => ({}),
    });

    const agent = createAgent<TestCtxExt>({
      tools: [sensitive],
      // No db configured.
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const tools = agent.agentTools({ ctx: makeCtx() });
    const result = await (tools.sensitive as any).execute({});

    expect(result.status).toBe("error");
    expect(result.error.message).toContain("requiresApproval=true");
  });

  it("in-session dedup: repeat call with same input returns cached result without re-executing", async () => {
    let executeCount = 0;
    const lookup = defineTool<
      z.ZodObject<{ id: z.ZodString }>,
      { count: number },
      TestCtxExt
    >({
      name: "lookup",
      description: "Counts invocations",
      input: z.object({ id: z.string() }),
      execute: async () => {
        executeCount += 1;
        return { count: executeCount };
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [lookup],
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const tools = agent.agentTools({ ctx: makeCtx() });

    const first = await (tools.lookup as any).execute({ id: "42" });
    const second = await (tools.lookup as any).execute({ id: "42" });
    const differentInput = await (tools.lookup as any).execute({ id: "99" });

    expect(first).toEqual({ status: "ok", data: { count: 1 } });
    // Cached — same object, NOT re-executed.
    expect(second).toEqual({ status: "ok", data: { count: 1 } });
    expect(differentInput).toEqual({ status: "ok", data: { count: 2 } });
    expect(executeCount).toBe(2);
  });

  it("in-session dedup: fresh buildAgentTools() call starts a fresh cache", async () => {
    let executeCount = 0;
    const lookup = defineTool<
      z.ZodObject<{ id: z.ZodString }>,
      { count: number },
      TestCtxExt
    >({
      name: "lookup",
      description: "Counts",
      input: z.object({ id: z.string() }),
      execute: async () => {
        executeCount += 1;
        return { count: executeCount };
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [lookup],
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const session1 = agent.agentTools({ ctx: makeCtx() });
    await (session1.lookup as any).execute({ id: "42" });

    const session2 = agent.agentTools({ ctx: makeCtx() });
    const r2 = await (session2.lookup as any).execute({ id: "42" });

    // New session → execute ran again.
    expect(r2.data.count).toBe(2);
  });

  it("errors are NOT cached — second call re-runs and can succeed", async () => {
    let attempt = 0;
    const flaky = defineTool<z.ZodObject<{}>, { ok: boolean }, TestCtxExt>({
      name: "flaky",
      description: "Fails once, then succeeds",
      input: z.object({}),
      execute: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("first try fails");
        return { ok: true };
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [flaky],
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const tools = agent.agentTools({ ctx: makeCtx() });
    const first = await (tools.flaky as any).execute({});
    const second = await (tools.flaky as any).execute({});

    expect(first.status).toBe("error");
    expect(second.status).toBe("ok");
  });

  it("returns error output when tool throws", async () => {
    const broken = defineTool<z.ZodObject<{}>, unknown, TestCtxExt>({
      name: "broken",
      description: "Throws",
      input: z.object({}),
      execute: async () => {
        throw new Error("kaboom");
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [broken],
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const tools = agent.agentTools({ ctx: makeCtx() });
    const result = await (tools.broken as any).execute({});

    expect(result.status).toBe("error");
    expect(result.error.toolName).toBe("broken");
    expect(result.error.message).toBe("kaboom");
  });

  it("executes non-approval tools normally with ctx injection", async () => {
    const lookup = defineTool<z.ZodObject<{ id: z.ZodString }>, string, TestCtxExt>({
      name: "lookup",
      description: "Uses db",
      input: z.object({ id: z.string() }),
      execute: async ({ input, ctx }) => ctx.db.get(input.id),
    });

    const agent = createAgent<TestCtxExt>({
      tools: [lookup],
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const tools = agent.agentTools({ ctx: makeCtx() });
    const result = await (tools.lookup as any).execute({ id: "42" });

    expect(result).toEqual({ status: "ok", data: "record-42" });
  });

  it("computes preview when previewChange is defined", async () => {
    const { db, inserts } = makeFakeDb();
    const previewed = defineTool<
      z.ZodObject<{ quoteId: z.ZodString }>,
      { applied: boolean },
      TestCtxExt
    >({
      name: "applyDiscount",
      description: "Needs approval; computes preview",
      input: z.object({ quoteId: z.string() }),
      requiresApproval: true,
      previewChange: async ({ input }) => ({
        before: { total: 100, quoteId: input.quoteId },
        after: { total: 90, quoteId: input.quoteId },
      }),
      execute: async () => ({ applied: true }),
    });

    const agent = createAgent<TestCtxExt>({
      tools: [previewed],
      db,
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const tools = agent.agentTools({ ctx: makeCtx() });
    await (tools.applyDiscount as any).execute({ quoteId: "q1" });

    const pendingInsert = inserts.find(
      (i) => (i.values as any).toolName === "applyDiscount",
    );
    expect(pendingInsert).toBeDefined();
    expect((pendingInsert!.values as any).previewBefore).toEqual({
      total: 100,
      quoteId: "q1",
    });
    expect((pendingInsert!.values as any).previewAfter).toEqual({
      total: 90,
      quoteId: "q1",
    });
  });

  it("continues approval flow even if previewChange throws", async () => {
    const { db, inserts } = makeFakeDb();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const brokenPreview = defineTool<
      z.ZodObject<{}>,
      { done: boolean },
      TestCtxExt
    >({
      name: "brokenPreview",
      description: "preview throws",
      input: z.object({}),
      requiresApproval: true,
      previewChange: async () => {
        throw new Error("preview exploded");
      },
      execute: async () => ({ done: true }),
    });

    const agent = createAgent<TestCtxExt>({
      tools: [brokenPreview],
      db,
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const tools = agent.agentTools({ ctx: makeCtx() });
    const result = await (tools.brokenPreview as any).execute({});

    expect(result.status).toBe("awaiting_approval");
    expect(spy).toHaveBeenCalled();
    const pendingInsert = inserts.find(
      (i) => (i.values as any).toolName === "brokenPreview",
    );
    expect((pendingInsert!.values as any).previewBefore).toBe(null);
    expect((pendingInsert!.values as any).previewAfter).toBe(null);

    spy.mockRestore();
  });
});
