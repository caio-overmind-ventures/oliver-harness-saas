/**
 * Prompt builder — assembles the system prompt for the agent channel.
 *
 * Structured with XML tags (Anthropic recommends this over prose) and split
 * into a STABLE prefix (cacheable by the model provider) and a MUTABLE
 * suffix (per-turn context).
 *
 *   STABLE PREFIX (changes only when instructions or tool list changes):
 *     <voice>              ← SOUL.md
 *     <domain>             ← domain.md
 *     <playbook>           ← playbook.md
 *     <lessons>            ← lessons.md (snapshot at session start; growth
 *                            between sessions invalidates cache, which is fine)
 *     <available_tools>    ← tool name + description table
 *     <anti_hallucination> ← fixed rules
 *     <tenant>             ← orgId, userId, slug (stable within a session)
 *
 *   MUTABLE SUFFIX (changes per turn):
 *     <page_context>           ← current route / viewed entity (if provided)
 *     <pending_approvals>      ← Phase 4 — recitation of in-flight HITL
 *
 * KV-cache behavior:
 * The stable prefix is identical across turns of the same session, so the
 * provider caches it. Only the suffix + user messages are re-processed.
 * Manus measured ~10x cost reduction with cached prefixes.
 *
 * Providers (OpenAI, Anthropic) cache automatically based on prefix match.
 * Oliver doesn't emit explicit cache breakpoints — the structure alone is
 * enough for current APIs.
 */

import type { AssembledInstructions } from "../instructions/loader";
import type { Tool } from "../core/defineTool";
import type { ToolContextBase } from "../core/context";

export interface PageContext {
  /** Current route path (e.g., "/org/geoia/quotes/qot_abc"). */
  route?: string;
  /** Human-readable label for the focused entity (e.g., "quote Q00042"). */
  entityLabel?: string;
  /** Free-form hint the builder wants the agent to know about the current page. */
  hint?: string;
}

export interface BuildPromptInput<TContextExt = Record<string, unknown>> {
  instructions: AssembledInstructions;
  tools: ReadonlyArray<Tool<any, any, any>>;
  ctx: ToolContextBase & TContextExt;
  /** Optional — only emitted into the mutable suffix when provided. */
  pageContext?: PageContext;
}

/**
 * Build the agent's system prompt. Deterministic for a given input — same
 * inputs produce byte-identical output (critical for KV-cache).
 */
export function buildSystemPrompt<TContextExt = Record<string, unknown>>(
  input: BuildPromptInput<TContextExt>,
): string {
  const { instructions, tools, ctx, pageContext } = input;

  const stable = buildStablePrefix(
    instructions,
    tools,
    ctx as ToolContextBase & Record<string, unknown>,
  );
  const mutable = buildMutableSuffix(pageContext);

  // Empty mutable section → no trailing whitespace, preserves cache.
  return mutable ? `${stable}\n\n${mutable}` : stable;
}

function buildStablePrefix(
  instructions: AssembledInstructions,
  tools: ReadonlyArray<Tool<any, any, any>>,
  ctx: ToolContextBase & Record<string, unknown>,
): string {
  const parts: string[] = [];

  parts.push(tag("voice", instructions.soul));

  if (instructions.domain.trim()) {
    parts.push(tag("domain", instructions.domain));
  }

  if (instructions.playbook.trim()) {
    parts.push(tag("playbook", instructions.playbook));
  }

  if (instructions.lessons.trim()) {
    parts.push(tag("lessons", instructions.lessons));
  }

  parts.push(tag("available_tools", formatToolList(tools)));

  parts.push(tag("anti_hallucination", ANTI_HALLUCINATION_RULES));

  parts.push(tag("tenant", formatTenant(ctx)));

  return parts.join("\n\n");
}

function buildMutableSuffix(pageContext?: PageContext): string {
  if (!pageContext) return "";

  const hasAny =
    pageContext.route || pageContext.entityLabel || pageContext.hint;
  if (!hasAny) return "";

  const lines: string[] = [];
  if (pageContext.route) lines.push(`route: ${pageContext.route}`);
  if (pageContext.entityLabel)
    lines.push(`viewing: ${pageContext.entityLabel}`);
  if (pageContext.hint) lines.push(`hint: ${pageContext.hint}`);

  return tag("page_context", lines.join("\n"));
}

function formatToolList(
  tools: ReadonlyArray<Tool<any, any, any>>,
): string {
  if (tools.length === 0) {
    return "(no tools registered)";
  }
  const rows = tools.map((t) => {
    const approval = t.requiresApproval ? " [requires human approval]" : "";
    return `- ${t.name}${approval}: ${t.description}`;
  });
  return rows.join("\n");
}

function formatTenant(
  ctx: ToolContextBase & Record<string, unknown>,
): string {
  const lines: string[] = [
    `orgId: ${ctx.orgId}`,
    `userId: ${ctx.userId}`,
  ];
  // Include any other primitive ctx fields (skip objects/functions) so the
  // builder's extension (e.g., slug) naturally appears here without Oliver
  // knowing about it.
  for (const [key, value] of Object.entries(ctx)) {
    if (key === "orgId" || key === "userId" || key === "source") continue;
    if (value === null || value === undefined) continue;
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean") {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join("\n");
}

function tag(name: string, content: string): string {
  const trimmed = content.trim();
  return `<${name}>\n${trimmed}\n</${name}>`;
}

/**
 * Fixed rules the agent must follow regardless of builder-provided
 * instructions. These are Oliver opinions, not builder-configurable.
 */
const ANTI_HALLUCINATION_RULES = `You can ONLY invoke tools listed in <available_tools>. Any other tool name is invalid.

If the user asks for something you cannot do with the available tools, respond with the exact shape (in the user's language):
  "Isso ainda não tá disponível. Posso fazer: <list tool names>."
Then stop. Do NOT attempt the task. Do NOT fake a result.

NEVER claim success without a preceding tool call that returned status "ok" in THIS turn. Specifically:
- Do NOT write "✅ feito/criado/aplicado" unless a tool just succeeded.
- Do NOT summarize an action as if it happened unless a tool call proves it happened.
- If you did not call a tool, you did not perform an action. Say so.

If a tool returns status "awaiting_approval", tell the user a human approval is pending. Do NOT re-invoke the tool until the user confirms.

NEVER execute write operations without user confirmation (e.g., "sim", "ok", "confirmo").`;
