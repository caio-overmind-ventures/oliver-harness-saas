import type { SlashCommand } from "./types";

/**
 * Identity factory for slash commands — same pattern as `defineTool`.
 * Type inference flows through to consumers; no runtime work.
 *
 * @example
 * export const pendingCmd = defineSlashCommand({
 *   name: "pending",
 *   description: "List approvals waiting for your click.",
 *   handler: async ({ ctx }) => {
 *     const rows = await listPending(ctx.orgId);
 *     return rows.map((r) => `• ${r.toolName} (id ${r.id})`).join("\n");
 *   },
 * });
 */
export function defineSlashCommand<TContextExt = Record<string, unknown>>(
  command: SlashCommand<TContextExt>,
): SlashCommand<TContextExt> {
  return command;
}
