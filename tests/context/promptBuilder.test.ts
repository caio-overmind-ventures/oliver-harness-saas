import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildSystemPrompt } from "../../src/context/promptBuilder";
import { defineTool } from "../../src/core/defineTool";
import { instructionsFromStrings } from "../../src/instructions/loader";
import type { ToolContextBase } from "../../src/core/context";

const makeCtx = (
  extra: Record<string, unknown> = {},
): ToolContextBase & Record<string, unknown> => ({
  orgId: "org_test",
  userId: "usr_test",
  source: "agent",
  ...extra,
});

const makeTool = (name: string, description: string, requiresApproval = false) =>
  defineTool({
    name,
    description,
    input: z.object({}),
    requiresApproval,
    execute: async () => ({}),
  });

describe("buildSystemPrompt", () => {
  it("emits all expected XML sections when all inputs provided", () => {
    const prompt = buildSystemPrompt({
      instructions: instructionsFromStrings({
        soul: "I am the agent.",
        domain: "Quotes have phases.",
        playbook: "DISCOVER → SUMMARIZE → EXECUTE.",
        lessons: "Never bypass approval.",
      }),
      tools: [makeTool("createCustomer", "Create a customer")],
      ctx: makeCtx({ slug: "acme" }),
      pageContext: { route: "/org/acme/customers" },
    });

    expect(prompt).toContain("<voice>\nI am the agent.\n</voice>");
    expect(prompt).toContain("<domain>\nQuotes have phases.\n</domain>");
    expect(prompt).toContain("<playbook>\nDISCOVER → SUMMARIZE → EXECUTE.\n</playbook>");
    expect(prompt).toContain("<lessons>\nNever bypass approval.\n</lessons>");
    expect(prompt).toContain("<available_tools>");
    expect(prompt).toContain("- createCustomer: Create a customer");
    expect(prompt).toContain("<anti_hallucination>");
    expect(prompt).toContain("<tenant>");
    expect(prompt).toContain("orgId: org_test");
    expect(prompt).toContain("slug: acme");
    expect(prompt).toContain("<page_context>");
    expect(prompt).toContain("route: /org/acme/customers");
  });

  it("omits empty sections (domain, playbook, lessons)", () => {
    const prompt = buildSystemPrompt({
      instructions: instructionsFromStrings({ soul: "voice only" }),
      tools: [],
      ctx: makeCtx(),
    });

    expect(prompt).toContain("<voice>");
    expect(prompt).not.toContain("<domain>");
    expect(prompt).not.toContain("<playbook>");
    expect(prompt).not.toContain("<lessons>");
    expect(prompt).not.toContain("<page_context>");
    expect(prompt).toContain("(no tools registered)");
  });

  it("marks tools that require approval", () => {
    const prompt = buildSystemPrompt({
      instructions: instructionsFromStrings({ soul: "x" }),
      tools: [
        makeTool("applyDiscount", "Apply discount", true),
        makeTool("listCustomers", "List customers", false),
      ],
      ctx: makeCtx(),
    });

    expect(prompt).toContain("- applyDiscount [requires human approval]: Apply discount");
    expect(prompt).toContain("- listCustomers: List customers");
  });

  it("is deterministic: same inputs produce byte-identical output", () => {
    const input = {
      instructions: instructionsFromStrings({
        soul: "voice",
        domain: "d",
        playbook: "p",
      }),
      tools: [makeTool("a", "A"), makeTool("b", "B")],
      ctx: makeCtx({ slug: "foo" }),
    };

    const p1 = buildSystemPrompt(input);
    const p2 = buildSystemPrompt(input);

    expect(p1).toBe(p2);
    expect(p1.length).toBeGreaterThan(100);
  });

  it("produces identical stable prefix across turns (no page context changes)", () => {
    const instructions = instructionsFromStrings({ soul: "voice" });
    const tools = [makeTool("x", "X")];
    const ctx = makeCtx({ slug: "foo" });

    const turn1 = buildSystemPrompt({ instructions, tools, ctx });
    const turn2 = buildSystemPrompt({ instructions, tools, ctx });

    // No mutable suffix (no pageContext) — prompts must match exactly.
    expect(turn1).toBe(turn2);
  });

  it("different page contexts produce different prompts (mutable suffix)", () => {
    const base = {
      instructions: instructionsFromStrings({ soul: "voice" }),
      tools: [makeTool("x", "X")],
      ctx: makeCtx(),
    };

    const p1 = buildSystemPrompt({ ...base, pageContext: { route: "/a" } });
    const p2 = buildSystemPrompt({ ...base, pageContext: { route: "/b" } });

    expect(p1).not.toBe(p2);
    expect(p1).toContain("route: /a");
    expect(p2).toContain("route: /b");
  });

  it("includes primitive ctx extensions in <tenant> (strings, numbers, booleans)", () => {
    const prompt = buildSystemPrompt({
      instructions: instructionsFromStrings({ soul: "x" }),
      tools: [],
      ctx: makeCtx({
        slug: "acme",
        locale: "pt-BR",
        priority: 5,
        admin: true,
        db: { query: () => null }, // object — should be skipped
      }),
    });

    expect(prompt).toContain("slug: acme");
    expect(prompt).toContain("locale: pt-BR");
    expect(prompt).toContain("priority: 5");
    expect(prompt).toContain("admin: true");
    expect(prompt).not.toContain("db:");
  });
});
