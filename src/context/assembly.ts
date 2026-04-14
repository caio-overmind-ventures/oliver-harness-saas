/**
 * Session assembly — the Context component's public entry point for the
 * agent channel. Bundles everything a chat route needs for one session:
 *   - tools (AI SDK tool record from the Gateway)
 *   - systemPrompt (from the Prompt Builder)
 *
 * Called ONCE at the start of each chat turn from the builder's api/chat
 * route. Pass the result to `streamText` / `generateText` / `ToolLoopAgent`.
 *
 * v0.1 will add:
 *   - pendingApprovals (list of harness_pending_tools entries)
 *   - workingMemory (compressed summary of older turns)
 */

import type { Agent } from "../gateway/createAgent";
import { buildAgentTools } from "../gateway/agentTools";
import type { ToolContext } from "../core/context";
import {
  buildSystemPrompt,
  type PageContext,
} from "./promptBuilder";

export interface AssembleSessionInput<TContextExt> {
  ctx: ToolContext<TContextExt>;
  /** Optional page/UI context for the mutable suffix of the prompt. */
  pageContext?: PageContext;
}

export interface SessionBundle {
  /** AI SDK tools record, bound to this session's ctx. */
  // biome-ignore lint/suspicious/noExplicitAny: AI SDK tool record
  tools: Record<string, any>;
  /** Fully-assembled system prompt, ready to hand to the LLM. */
  systemPrompt: string;
}

/**
 * Assemble everything needed for one agent session.
 */
export function assembleSession<TContextExt>(
  agent: Agent<TContextExt>,
  input: AssembleSessionInput<TContextExt>,
): SessionBundle {
  const ctx = { ...input.ctx, source: "agent" as const };

  if (!agent._instructions) {
    throw new Error(
      "[oliver-agent] assembleSession called but no instructions were provided to createAgent. Pass `instructions: await loadInstructions(dir)` when creating the agent.",
    );
  }

  const tools = buildAgentTools(agent, { ctx });

  const systemPrompt = buildSystemPrompt({
    instructions: agent._instructions,
    tools: agent.tools,
    ctx,
    pageContext: input.pageContext,
  });

  return { tools, systemPrompt };
}
