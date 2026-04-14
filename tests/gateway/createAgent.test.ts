import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgent } from "../../src/gateway/createAgent";
import { defineTool } from "../../src/core/defineTool";
import type { ToolContext } from "../../src/core/context";

type TestContext = ToolContext<{ db: { get: (id: string) => string } }>;

const makeCtx = (): TestContext => ({
  orgId: "org_test",
  userId: "usr_test",
  source: "ui",
  db: { get: (id: string) => `record-${id}` },
});

describe("createAgent", () => {
  it("registers tools and exposes them by name", () => {
    const tool1 = defineTool({
      name: "toolA",
      description: "First",
      input: z.object({}),
      execute: async () => ({ ok: true }),
    });
    const tool2 = defineTool({
      name: "toolB",
      description: "Second",
      input: z.object({}),
      execute: async () => ({ ok: true }),
    });

    const agent = createAgent<TestContext extends ToolContext<infer E> ? E : never>({
      tools: [tool1, tool2],
      resolveServerActionContext: async () => makeCtx(),
    });

    expect(agent.tools).toHaveLength(2);
    expect(agent.getTool("toolA")).toBe(tool1);
    expect(agent.getTool("toolB")).toBe(tool2);
    expect(agent.getTool("nonexistent")).toBeUndefined();
  });

  it("throws on duplicate tool names", () => {
    const tool1 = defineTool({
      name: "duplicate",
      description: "A",
      input: z.object({}),
      execute: async () => ({}),
    });
    const tool2 = defineTool({
      name: "duplicate",
      description: "B (same name)",
      input: z.object({}),
      execute: async () => ({}),
    });

    expect(() =>
      createAgent({
        tools: [tool1, tool2],
        resolveServerActionContext: async () => makeCtx(),
      }),
    ).toThrowError(/Duplicate tool name: "duplicate"/);
  });

  it("exposes serverAction and agentTools methods", () => {
    const agent = createAgent({
      tools: [],
      resolveServerActionContext: async () => makeCtx(),
    });

    expect(typeof agent.serverAction).toBe("function");
    expect(typeof agent.agentTools).toBe("function");
  });
});
