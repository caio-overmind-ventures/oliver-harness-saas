import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgent } from "../../src/gateway/createAgent";
import { defineTool } from "../../src/core/defineTool";
import type { ToolContext } from "../../src/core/context";

type TestCtxExt = { db: { get: (id: string) => string } };
type TestContext = ToolContext<TestCtxExt>;

const makeCtx = (): TestContext => ({
  orgId: "org_test",
  userId: "usr_test",
  source: "agent",
  db: { get: (id: string) => `record-${id}` },
});

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

  it("returns 'awaiting_approval' for tools with requiresApproval=true (no execute)", async () => {
    let executedCount = 0;
    const sensitive = defineTool<z.ZodObject<{ amount: z.ZodNumber }>, { done: boolean }, TestCtxExt>({
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
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const tools = agent.agentTools({ ctx: makeCtx() });
    const result = await (tools.sensitive as any).execute({ amount: 30 });

    expect(result.status).toBe("awaiting_approval");
    expect(result.toolName).toBe("sensitive");
    expect(result.input).toEqual({ amount: 30 });
    expect(result.message).toContain("Awaiting human approval");
    expect(executedCount).toBe(0);
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
});
