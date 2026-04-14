/**
 * Built-in slash commands shipped with every Oliver agent.
 *
 * /help     — list available commands
 * /tools    — list registered tools with descriptions
 * /pending  — list HITL approvals waiting (queries oliver.pending_tools)
 *
 * These are added automatically by createAgent. Adopters can shadow any
 * built-in by registering a command with the same name in `commands` —
 * user-defined commands are matched first.
 */

import type { Agent } from "../gateway/createAgent";
import { defineSlashCommand } from "./defineSlashCommand";
import type { SlashCommand } from "./types";

export function createBuiltinCommands<TContextExt>(
  agent: Agent<TContextExt>,
): ReadonlyArray<SlashCommand<TContextExt>> {
  return [
    defineSlashCommand<TContextExt>({
      name: "help",
      description: "List available slash commands.",
      handler: () => {
        const lines = ["Available commands:"];
        // Defer reading commands until handler-time so user-defined and
        // built-in commands all appear (registry is fully assembled by
        // the time anyone could type /help).
        for (const cmd of agent._commands ?? []) {
          lines.push(`  /${cmd.name} — ${cmd.description}`);
        }
        return lines.join("\n");
      },
    }),

    defineSlashCommand<TContextExt>({
      name: "tools",
      description: "List the tools this agent can call.",
      handler: () => {
        if (agent.tools.length === 0) return "No tools registered.";
        const lines = [`Available tools (${agent.tools.length}):`];
        for (const tool of agent.tools) {
          const hitl = tool.requiresApproval ? " [HITL]" : "";
          lines.push(`  • ${tool.name}${hitl} — ${tool.description}`);
        }
        return lines.join("\n");
      },
    }),

    defineSlashCommand<TContextExt>({
      name: "pending",
      description: "List approvals waiting for your click.",
      handler: async ({ ctx }) => {
        if (!agent._pending) {
          return "Pending-approvals storage not configured (createAgent was called without `db`).";
        }
        const rows = await agent._pending.listActive(ctx.orgId);
        if (rows.length === 0) return "No approvals pending.";

        const lines = [`${rows.length} pending approval(s):`];
        for (const row of rows) {
          const age = Math.round(
            (Date.now() - new Date(row.createdAt).getTime()) / 1000,
          );
          lines.push(
            `  • ${row.toolName} (id: ${row.id}, ${age}s ago)`,
          );
        }
        return lines.join("\n");
      },
    }),
  ];
}
