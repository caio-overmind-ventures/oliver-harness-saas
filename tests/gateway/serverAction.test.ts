import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent } from "../../src/gateway/createAgent";
import { defineTool } from "../../src/core/defineTool";
import { ToolError } from "../../src/core/errors";
import type { ToolContext } from "../../src/core/context";

type TestCtxExt = { db: { get: (id: string) => string } };
type TestContext = ToolContext<TestCtxExt>;

const makeCtx = (): TestContext => ({
  orgId: "org_test",
  userId: "usr_test",
  source: "ui",
  db: { get: (id: string) => `record-${id}` },
});

describe("serverAction channel", () => {
  it("happy path returns { ok: true, data }", async () => {
    const greet = defineTool<z.ZodObject<{ name: z.ZodString }>, string, TestCtxExt>({
      name: "greet",
      description: "Greet by name",
      input: z.object({ name: z.string() }),
      execute: async ({ input }) => `hello, ${input.name}`,
    });

    const agent = createAgent<TestCtxExt>({
      tools: [greet],
      resolveServerActionContext: async () => makeCtx(),
    });

    const action = agent.serverAction(greet);
    const result = await action({ name: "oliver" });

    expect(result).toEqual({ ok: true, data: "hello, oliver" });
  });

  it("resolves context and forces source=ui even if resolver returned something else", async () => {
    const probe = defineTool<z.ZodObject<{}>, { source: string; orgId: string }, TestCtxExt>({
      name: "probe",
      description: "Probe the ctx",
      input: z.object({}),
      execute: async ({ ctx }) => ({ source: ctx.source, orgId: ctx.orgId }),
    });

    const agent = createAgent<TestCtxExt>({
      tools: [probe],
      // Intentionally return source="agent" to verify the gateway overrides.
      resolveServerActionContext: async () => ({
        ...makeCtx(),
        source: "agent" as any,
      }),
    });

    const action = agent.serverAction(probe);
    const result = await action({});

    expect(result).toEqual({
      ok: true,
      data: { source: "ui", orgId: "org_test" },
    });
  });

  it("returns { ok: false, error } on invalid input", async () => {
    const strict = defineTool<z.ZodObject<{ age: z.ZodNumber }>, unknown, TestCtxExt>({
      name: "strict",
      description: "Needs age",
      input: z.object({ age: z.number() }),
      execute: async () => ({ ok: true }),
    });

    const agent = createAgent<TestCtxExt>({
      tools: [strict],
      resolveServerActionContext: async () => makeCtx(),
    });

    const action = agent.serverAction(strict);
    const result = await action({ age: "not-a-number" } as any);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toolName).toBe("strict");
      expect(result.error.code).toBe("unexpected");
    }
  });

  it("returns typed ToolError as-is when tool throws ToolError", async () => {
    const guarded = defineTool<z.ZodObject<{}>, unknown, TestCtxExt>({
      name: "guarded",
      description: "Always rejects",
      input: z.object({}),
      execute: async () => {
        throw new ToolError({
          code: "authorization",
          toolName: "guarded",
          message: "not allowed",
        });
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [guarded],
      resolveServerActionContext: async () => makeCtx(),
    });

    const result = await agent.serverAction(guarded)({});

    expect(result).toEqual({
      ok: false,
      error: {
        name: "ToolError",
        code: "authorization",
        toolName: "guarded",
        message: "not allowed",
      },
    });
  });

  it("wraps unexpected thrown errors", async () => {
    const broken = defineTool<z.ZodObject<{}>, unknown, TestCtxExt>({
      name: "broken",
      description: "Throws plain Error",
      input: z.object({}),
      execute: async () => {
        throw new Error("something exploded");
      },
    });

    const agent = createAgent<TestCtxExt>({
      tools: [broken],
      resolveServerActionContext: async () => makeCtx(),
    });

    const result = await agent.serverAction(broken)({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unexpected");
      expect(result.error.message).toBe("something exploded");
    }
  });

  it("accepts ctxOverride and shallow-merges into ctx (caller-known context wins)", async () => {
    type CtxExt = { db: { get: (id: string) => string }; slug: string };

    const probe = defineTool<z.ZodObject<{}>, { slug: string; orgId: string }, CtxExt>({
      name: "probe",
      description: "Echo slug + orgId from ctx",
      input: z.object({}),
      execute: async ({ ctx }) => ({ slug: ctx.slug, orgId: ctx.orgId }),
    });

    const agent = createAgent<CtxExt>({
      tools: [probe],
      // Server-resolved ctx doesn't know slug; caller provides it via override.
      resolveServerActionContext: async () => ({
        orgId: "org_test",
        userId: "usr_test",
        source: "ui",
        db: { get: (id: string) => `r-${id}` },
        slug: "unknown",
      }),
    });

    const action = agent.serverAction(probe);
    const result = await action({}, { slug: "acme" });

    expect(result).toEqual({
      ok: true,
      data: { slug: "acme", orgId: "org_test" },
    });
  });

  it("works without ctxOverride (optional arg)", async () => {
    type CtxExt = { db: { get: (id: string) => string }; slug: string };

    const probe = defineTool<z.ZodObject<{}>, { slug: string }, CtxExt>({
      name: "probe2",
      description: "Echo slug from ctx",
      input: z.object({}),
      execute: async ({ ctx }) => ({ slug: ctx.slug }),
    });

    const agent = createAgent<CtxExt>({
      tools: [probe],
      resolveServerActionContext: async () => ({
        orgId: "org_test",
        userId: "usr_test",
        source: "ui",
        db: { get: (id: string) => `r-${id}` },
        slug: "from-server",
      }),
    });

    // No 2nd arg — resolver's slug is used.
    const result = await agent.serverAction(probe)({});
    expect(result).toEqual({ ok: true, data: { slug: "from-server" } });
  });

  it("invokes resolveServerActionContext per call", async () => {
    const resolver = vi.fn(async () => makeCtx());
    const noop = defineTool<z.ZodObject<{}>, string, TestCtxExt>({
      name: "noop",
      description: "No-op",
      input: z.object({}),
      execute: async () => "done",
    });

    const agent = createAgent<TestCtxExt>({
      tools: [noop],
      resolveServerActionContext: resolver,
    });

    const action = agent.serverAction(noop);
    await action({});
    await action({});
    await action({});

    expect(resolver).toHaveBeenCalledTimes(3);
  });
});
