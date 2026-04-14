import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgent } from "../../src/gateway/createAgent";
import { defineSlashCommand } from "../../src/commands/defineSlashCommand";
import { defineTool } from "../../src/core/defineTool";
import type { ToolContext } from "../../src/core/context";

type CtxExt = { note?: string };
type Ctx = ToolContext<CtxExt>;

const baseCtx: Ctx = {
  orgId: "org_test",
  userId: "usr_test",
  source: "agent",
};

const baseConfig = {
  resolveServerActionContext: async () => ({ ...baseCtx, source: "ui" as const }),
};

function userMessage(text: string) {
  return { role: "user", parts: [{ type: "text", text }] };
}

describe("handleSlashCommand — built-ins", () => {
  it("/help lists registered commands (built-ins + user)", async () => {
    const customCmd = defineSlashCommand<CtxExt>({
      name: "ping",
      description: "Reply with pong.",
      handler: () => "pong",
    });

    const agent = createAgent<CtxExt>({
      tools: [],
      commands: [customCmd],
      ...baseConfig,
    });

    const result = await agent.handleSlashCommand([userMessage("/help")], baseCtx);
    expect(result).toContain("/ping");
    expect(result).toContain("Reply with pong.");
    expect(result).toContain("/help");
    expect(result).toContain("/tools");
    expect(result).toContain("/pending");
  });

  it("/tools lists all tools with HITL marker", async () => {
    const cheap = defineTool<z.ZodObject<{}>, string, CtxExt>({
      name: "cheap",
      description: "Cheap read.",
      input: z.object({}),
      execute: async () => "ok",
    });
    const sensitive = defineTool<z.ZodObject<{}>, string, CtxExt>({
      name: "sensitive",
      description: "HITL write.",
      input: z.object({}),
      requiresApproval: true,
      execute: async () => "ok",
    });

    const agent = createAgent<CtxExt>({
      tools: [cheap, sensitive],
      ...baseConfig,
    });

    const result = await agent.handleSlashCommand([userMessage("/tools")], baseCtx);
    expect(result).toContain("cheap");
    expect(result).toContain("sensitive");
    expect(result).toContain("[HITL]");
    expect(result).toContain("Cheap read.");
  });

  it("/tools reports zero when none registered", async () => {
    const agent = createAgent<CtxExt>({ tools: [], ...baseConfig });
    const result = await agent.handleSlashCommand([userMessage("/tools")], baseCtx);
    expect(result).toBe("No tools registered.");
  });

  it("/pending reports configuration error when no db", async () => {
    const agent = createAgent<CtxExt>({ tools: [], ...baseConfig });
    const result = await agent.handleSlashCommand([userMessage("/pending")], baseCtx);
    expect(result).toContain("not configured");
  });
});

describe("handleSlashCommand — dispatch behavior", () => {
  it("returns null for non-slash messages", async () => {
    const agent = createAgent<CtxExt>({ tools: [], ...baseConfig });
    const result = await agent.handleSlashCommand(
      [userMessage("Hi, please create a customer named Acme")],
      baseCtx,
    );
    expect(result).toBeNull();
  });

  it("returns null when there's no user message at all", async () => {
    const agent = createAgent<CtxExt>({ tools: [], ...baseConfig });
    const result = await agent.handleSlashCommand([], baseCtx);
    expect(result).toBeNull();
  });

  it("uses the LAST user message (ignores earlier ones)", async () => {
    const ping = defineSlashCommand<CtxExt>({
      name: "ping",
      description: "ping",
      handler: () => "pong",
    });
    const agent = createAgent<CtxExt>({
      tools: [],
      commands: [ping],
      ...baseConfig,
    });
    const result = await agent.handleSlashCommand(
      [userMessage("hello"), { role: "assistant", parts: [{ type: "text", text: "hi" }] }, userMessage("/ping")],
      baseCtx,
    );
    expect(result).toBe("pong");
  });

  it("returns helpful error for unknown commands", async () => {
    const agent = createAgent<CtxExt>({ tools: [], ...baseConfig });
    const result = await agent.handleSlashCommand(
      [userMessage("/nonexistent")],
      baseCtx,
    );
    expect(result).toContain("Unknown command");
    expect(result).toContain("/help");
  });

  it("passes args after the command name", async () => {
    const echo = defineSlashCommand<CtxExt>({
      name: "echo",
      description: "echo",
      handler: ({ args }) => `args: "${args}"`,
    });
    const agent = createAgent<CtxExt>({
      tools: [],
      commands: [echo],
      ...baseConfig,
    });
    const result = await agent.handleSlashCommand(
      [userMessage("/echo hello world  with spaces")],
      baseCtx,
    );
    expect(result).toBe(`args: "hello world  with spaces"`);
  });

  it("user commands override built-ins by name", async () => {
    const customHelp = defineSlashCommand<CtxExt>({
      name: "help",
      description: "Custom help.",
      handler: () => "MY CUSTOM HELP",
    });
    const agent = createAgent<CtxExt>({
      tools: [],
      commands: [customHelp],
      ...baseConfig,
    });
    const result = await agent.handleSlashCommand([userMessage("/help")], baseCtx);
    expect(result).toBe("MY CUSTOM HELP");
  });

  it("recovers from handler errors", async () => {
    const broken = defineSlashCommand<CtxExt>({
      name: "broken",
      description: "throws",
      handler: () => {
        throw new Error("intentional");
      },
    });
    const agent = createAgent<CtxExt>({
      tools: [],
      commands: [broken],
      ...baseConfig,
    });
    const result = await agent.handleSlashCommand(
      [userMessage("/broken")],
      baseCtx,
    );
    expect(result).toContain("/broken failed");
    expect(result).toContain("intentional");
  });

  it("supports legacy `content` string message shape", async () => {
    const ping = defineSlashCommand<CtxExt>({
      name: "ping",
      description: "ping",
      handler: () => "pong",
    });
    const agent = createAgent<CtxExt>({
      tools: [],
      commands: [ping],
      ...baseConfig,
    });
    const result = await agent.handleSlashCommand(
      [{ role: "user", content: "/ping" }],
      baseCtx,
    );
    expect(result).toBe("pong");
  });
});

describe("respondWithText", () => {
  it("returns a Response with SSE content type", () => {
    const agent = createAgent<CtxExt>({ tools: [], ...baseConfig });
    const response = agent.respondWithText("hello world");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
  });

  it("body contains the text payload + lifecycle events", async () => {
    const agent = createAgent<CtxExt>({ tools: [], ...baseConfig });
    const response = agent.respondWithText("hello");
    const body = await response.text();
    expect(body).toContain('"type":"start"');
    expect(body).toContain('"type":"text-start"');
    expect(body).toContain('"delta":"hello"');
    expect(body).toContain('"type":"text-end"');
    expect(body).toContain('"type":"finish"');
    expect(body).toContain("[DONE]");
  });
});
