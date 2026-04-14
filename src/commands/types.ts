/**
 * Slash commands — chat shortcuts that bypass the LLM.
 *
 * When the user types `/pending` or `/tools` in chat, the chat route
 * intercepts BEFORE calling the model. Useful for:
 *  - Listing harness state (pending approvals, available tools, audit)
 *  - Cheap deterministic answers ("/help") that shouldn't burn tokens
 *  - Operator-only commands that don't make sense to expose to the LLM
 *
 * This is the agent's *control plane* in the chat — distinct from tools,
 * which are the agent's *data plane*.
 */

import type { ToolContext } from "../core/context";

/**
 * Result returned by a slash command handler. String for simple text
 * responses; structured for richer UI rendering later (v0.3+).
 */
export type SlashCommandResult = string;

export interface SlashCommandHandlerParams<TContextExt> {
  /** Everything after the command name, raw. e.g. "/pending --verbose" → "--verbose". */
  args: string;
  ctx: ToolContext<TContextExt>;
}

export interface SlashCommand<TContextExt = Record<string, unknown>> {
  /** No leading slash. `/help` → name is "help". */
  name: string;
  /** One-line description shown by `/help`. */
  description: string;
  /**
   * The handler. Receives the raw args string + agent context. Return a
   * string to render in chat. Throw to surface an error to the user.
   *
   * Built to be deterministic — no LLM calls inside. If you need LLM
   * reasoning, you want a tool, not a slash command.
   */
  handler: (
    params: SlashCommandHandlerParams<TContextExt>,
  ) => Promise<SlashCommandResult> | SlashCommandResult;
}
