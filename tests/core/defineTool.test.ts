import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../../src/core/defineTool";
import type { ToolContext } from "../../src/core/context";

describe("defineTool", () => {
  it("returns the tool definition with type inference preserved", () => {
    const tool = defineTool({
      name: "testTool",
      description: "A test tool",
      input: z.object({ name: z.string() }),
      execute: async ({ input }) => ({ greeting: `hello, ${input.name}` }),
    });

    expect(tool.name).toBe("testTool");
    expect(tool.description).toBe("A test tool");
    expect(tool.input).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("defaults requiresApproval to undefined (not required)", () => {
    const tool = defineTool({
      name: "safeTool",
      description: "No approval needed",
      input: z.object({}),
      execute: async () => ({ ok: true }),
    });

    expect(tool.requiresApproval).toBeUndefined();
  });

  it("accepts a tool with requiresApproval + previewChange + verify", () => {
    const tool = defineTool({
      name: "sensitiveTool",
      description: "Needs approval and verification",
      input: z.object({ amount: z.number() }),
      requiresApproval: true,
      previewChange: async ({ input }) => ({
        before: { total: 100 },
        after: { total: 100 - input.amount },
      }),
      execute: async ({ input }) => ({ subtracted: input.amount }),
      verify: async ({ result }) => result.subtracted > 0,
    });

    expect(tool.requiresApproval).toBe(true);
    expect(typeof tool.previewChange).toBe("function");
    expect(typeof tool.verify).toBe("function");
  });

  it("supports context extension via TypeScript generics", async () => {
    type MyContext = ToolContext<{ db: { query: (s: string) => Promise<number> } }>;

    const tool = defineTool<z.ZodObject<{ query: z.ZodString }>, number, { db: { query: (s: string) => Promise<number> } }>({
      name: "queryTool",
      description: "Uses typed db context",
      input: z.object({ query: z.string() }),
      execute: async ({ input, ctx }) => {
        // ctx.db should be typed as { query: ... }
        return await ctx.db.query(input.query);
      },
    });

    // Execute the tool with a mocked context
    const result = await tool.execute({
      input: { query: "SELECT 1" },
      ctx: {
        orgId: "org_test",
        userId: "usr_test",
        source: "agent",
        db: { query: async () => 42 },
      } as MyContext,
    });

    expect(result).toBe(42);
  });
});
