/**
 * Dispatcher — given the latest user message and a registry of commands,
 * decide whether it's a slash command and run the matching handler.
 *
 * Returns:
 *   - the handler's response text if matched
 *   - null if the message is not a slash command
 *   - an error string if the command name was unknown
 */

import type { ToolContext } from "../core/context";
import type { SlashCommand, SlashCommandResult } from "./types";

/**
 * Best-effort extraction of plain text from whatever shape the chat UI
 * sends in `messages[]`. Supports both the new `parts[]` AI SDK shape
 * and the legacy `content` string shape.
 */
function extractText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as Record<string, unknown>;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.parts)) {
    return m.parts
      .filter(
        (p): p is { type: "text"; text: string } =>
          !!p &&
          typeof p === "object" &&
          (p as Record<string, unknown>).type === "text" &&
          typeof (p as Record<string, unknown>).text === "string",
      )
      .map((p) => p.text)
      .join("");
  }
  return "";
}

function lastUserMessageText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (m?.role === "user") return extractText(m).trim();
  }
  return "";
}

function parseSlash(text: string): { name: string; args: string } | null {
  if (!text.startsWith("/")) return null;
  const stripped = text.slice(1);
  const spaceIdx = stripped.indexOf(" ");
  if (spaceIdx === -1) return { name: stripped, args: "" };
  return {
    name: stripped.slice(0, spaceIdx),
    args: stripped.slice(spaceIdx + 1).trim(),
  };
}

export interface DispatchInput<TContextExt> {
  /** UI messages array passed to the chat route. Last user message is checked. */
  messages: unknown[];
  ctx: ToolContext<TContextExt>;
  commands: ReadonlyArray<SlashCommand<TContextExt>>;
}

/**
 * Returns the response text if a command matched, null if the message
 * wasn't a slash command at all, or an error string for unknown commands.
 */
export async function dispatchSlashCommand<TContextExt>(
  input: DispatchInput<TContextExt>,
): Promise<SlashCommandResult | null> {
  const text = lastUserMessageText(input.messages);
  const parsed = parseSlash(text);
  if (!parsed) return null;

  const command = input.commands.find((c) => c.name === parsed.name);
  if (!command) {
    return `Unknown command: \`/${parsed.name}\`\n\nType \`/help\` to see available commands.`;
  }

  try {
    return await command.handler({ args: parsed.args, ctx: input.ctx });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Command \`/${parsed.name}\` failed: ${message}`;
  }
}
