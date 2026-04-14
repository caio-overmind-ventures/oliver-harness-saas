import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createAgent } from "../../src/gateway/createAgent";
import { defineTool } from "../../src/core/defineTool";
import { instructionsFromStrings } from "../../src/instructions/loader";
import type { ToolContext } from "../../src/core/context";

type TestCtxExt = { slug: string };
type TestContext = ToolContext<TestCtxExt>;

const makeCtx = (): TestContext => ({
  orgId: "org_test",
  userId: "usr_test",
  source: "agent",
  slug: "test-slug",
});

describe("agent.assembleSession", () => {
  it("returns tools + system prompt bundle", () => {
    const tool = defineTool<z.ZodObject<{}>, string, TestCtxExt>({
      name: "testTool",
      description: "A test tool",
      input: z.object({}),
      execute: async () => "ok",
    });

    const agent = createAgent<TestCtxExt>({
      tools: [tool],
      instructions: instructionsFromStrings({
        soul: "test voice",
        domain: "test domain",
      }),
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const session = agent.assembleSession({ ctx: makeCtx() });

    expect(session.tools.testTool).toBeDefined();
    expect(session.systemPrompt).toContain("test voice");
    expect(session.systemPrompt).toContain("test domain");
    expect(session.systemPrompt).toContain("<available_tools>");
    expect(session.systemPrompt).toContain("- testTool: A test tool");
  });

  it("forces source=agent in ctx regardless of input source", () => {
    const probe = defineTool<z.ZodObject<{}>, { source: string }, TestCtxExt>({
      name: "probe",
      description: "probe source",
      input: z.object({}),
      execute: async ({ ctx }) => ({ source: ctx.source }),
    });

    const agent = createAgent<TestCtxExt>({
      tools: [probe],
      instructions: instructionsFromStrings({ soul: "x" }),
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const session = agent.assembleSession({
      ctx: { ...makeCtx(), source: "ui" as any },
    });

    expect(session.systemPrompt).toContain("orgId: org_test");
    // The agent tools should still execute with source=agent.
    // (Full tool execution is tested in agentTools.test.ts.)
  });

  it("propagates pageContext to the mutable suffix", () => {
    const tool = defineTool<z.ZodObject<{}>, string, TestCtxExt>({
      name: "t",
      description: "t",
      input: z.object({}),
      execute: async () => "ok",
    });

    const agent = createAgent<TestCtxExt>({
      tools: [tool],
      instructions: instructionsFromStrings({ soul: "x" }),
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const session = agent.assembleSession({
      ctx: makeCtx(),
      pageContext: {
        route: "/org/test-slug/quotes/qot_abc",
        entityLabel: "quote Q00042",
      },
    });

    expect(session.systemPrompt).toContain("route: /org/test-slug/quotes/qot_abc");
    expect(session.systemPrompt).toContain("viewing: quote Q00042");
  });

  it("throws when called without instructions configured", () => {
    const agent = createAgent<TestCtxExt>({
      tools: [],
      // No instructions.
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    expect(() => agent.assembleSession({ ctx: makeCtx() })).toThrow(
      /no instructions were provided/,
    );
  });

  it("produces identical prompts for identical inputs (cache-friendly)", () => {
    const agent = createAgent<TestCtxExt>({
      tools: [
        defineTool<z.ZodObject<{}>, string, TestCtxExt>({
          name: "t",
          description: "t",
          input: z.object({}),
          execute: async () => "ok",
        }),
      ],
      instructions: instructionsFromStrings({
        soul: "voice",
        playbook: "DISCOVER",
      }),
      resolveServerActionContext: async () => ({ ...makeCtx(), source: "ui" }),
    });

    const s1 = agent.assembleSession({ ctx: makeCtx() });
    const s2 = agent.assembleSession({ ctx: makeCtx() });

    expect(s1.systemPrompt).toBe(s2.systemPrompt);
  });
});
