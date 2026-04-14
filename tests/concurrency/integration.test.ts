import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { __resetRegistryForTests } from "../../src/concurrency/mutex";
import { defineTool } from "../../src/core/defineTool";
import { createAgent } from "../../src/gateway/createAgent";
import type { ToolContext } from "../../src/core/context";

type TestCtxExt = { note?: string };
type TestContext = ToolContext<TestCtxExt>;

const makeCtx = (): TestContext => ({
  orgId: "org_test",
  userId: "usr_test",
  source: "agent",
});

afterEach(() => {
  __resetRegistryForTests();
});

/**
 * End-to-end: two agent-channel tool calls with different inputs but the
 * SAME concurrencyKey (e.g. two applyDiscount calls on the same quote)
 * must serialize. We detect this by having the tool bump a counter at
 * entry and exit — if they were parallel, the entry counts would overlap.
 */
describe("concurrencyKey — serializes same-key execute() in agent channel", () => {
  it("two calls with the same key do not overlap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const tool = defineTool<
      z.ZodObject<{ quoteId: z.ZodString; delta: z.ZodNumber }>,
      { ok: true },
      TestCtxExt
    >({
      name: "adjust",
      description: "",
      input: z.object({ quoteId: z.string(), delta: z.number() }),
      concurrencyKey: ({ input }) => `quote:${input.quoteId}`,
      execute: async () => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return { ok: true as const };
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [tool],
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });
    const tools = agent.agentTools({ ctx: makeCtx() });

    // Two parallel calls on the same quote.
    await Promise.all([
      (tools.adjust as any).execute({ quoteId: "q1", delta: 10 }),
      (tools.adjust as any).execute({ quoteId: "q1", delta: 20 }),
    ]);

    expect(maxInFlight).toBe(1);
  });

  it("different keys run in parallel (no serialization)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const tool = defineTool<
      z.ZodObject<{ quoteId: z.ZodString }>,
      { ok: true },
      TestCtxExt
    >({
      name: "adjust",
      description: "",
      input: z.object({ quoteId: z.string() }),
      concurrencyKey: ({ input }) => `quote:${input.quoteId}`,
      execute: async () => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return { ok: true as const };
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [tool],
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });
    const tools = agent.agentTools({ ctx: makeCtx() });

    await Promise.all([
      (tools.adjust as any).execute({ quoteId: "q1" }),
      (tools.adjust as any).execute({ quoteId: "q2" }),
    ]);

    expect(maxInFlight).toBe(2);
  });

  it("no concurrencyKey → no serialization", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const tool = defineTool<z.ZodObject<{}>, { ok: true }, TestCtxExt>({
      name: "free",
      description: "",
      input: z.object({}),
      // No concurrencyKey at all.
      execute: async () => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return { ok: true as const };
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [tool],
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });
    const tools = agent.agentTools({ ctx: makeCtx() });

    await Promise.all([
      (tools.free as any).execute({}),
      (tools.free as any).execute({}),
    ]);

    expect(maxInFlight).toBe(2);
  });

  it("returning undefined from concurrencyKey → no serialization for that call", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const tool = defineTool<
      z.ZodObject<{ quoteId: z.ZodString }>,
      { ok: true },
      TestCtxExt
    >({
      name: "maybeLock",
      description: "",
      input: z.object({ quoteId: z.string() }),
      // Key only for "important" quotes; others are free-running.
      concurrencyKey: ({ input }) =>
        input.quoteId.startsWith("IMPORTANT") ? input.quoteId : undefined,
      execute: async () => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return { ok: true as const };
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [tool],
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });
    const tools = agent.agentTools({ ctx: makeCtx() });

    await Promise.all([
      (tools.maybeLock as any).execute({ quoteId: "normal" }),
      (tools.maybeLock as any).execute({ quoteId: "normal2" }),
    ]);

    expect(maxInFlight).toBe(2);
  });

  it("execute throwing releases the lock for the next same-key caller", async () => {
    let secondRan = false;
    const tool = defineTool<
      z.ZodObject<{ quoteId: z.ZodString; shouldFail: z.ZodBoolean }>,
      { ok: true },
      TestCtxExt
    >({
      name: "flaky",
      description: "",
      input: z.object({ quoteId: z.string(), shouldFail: z.boolean() }),
      concurrencyKey: ({ input }) => `quote:${input.quoteId}`,
      execute: async ({ input }) => {
        if (input.shouldFail) throw new Error("boom");
        secondRan = true;
        return { ok: true as const };
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [tool],
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });
    const tools = agent.agentTools({ ctx: makeCtx() });

    const r1 = await (tools.flaky as any).execute({
      quoteId: "q1",
      shouldFail: true,
    });
    expect(r1.status).toBe("error");

    const r2 = await (tools.flaky as any).execute({
      quoteId: "q1",
      shouldFail: false,
    });
    expect(r2.status).toBe("ok");
    expect(secondRan).toBe(true);
  });

  it("throwing concurrencyKey is surfaced as a ToolError without running execute", async () => {
    let executeRan = false;
    const tool = defineTool<z.ZodObject<{}>, unknown, TestCtxExt>({
      name: "keyBroken",
      description: "",
      input: z.object({}),
      concurrencyKey: () => {
        throw new Error("bad key derivation");
      },
      execute: async () => {
        executeRan = true;
        return {};
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [tool],
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });
    const tools = agent.agentTools({ ctx: makeCtx() });

    const result = await (tools.keyBroken as any).execute({});
    expect(result.status).toBe("error");
    expect(result.error.message).toBe("bad key derivation");
    expect(executeRan).toBe(false);
  });
});
