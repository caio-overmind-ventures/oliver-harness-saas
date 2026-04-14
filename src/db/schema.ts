/**
 * Oliver's database schema.
 *
 * All Oliver tables live in a dedicated Postgres schema named `oliver`.
 * This isolates the harness from the builder's app schema — no name
 * collisions, clean `SHOW TABLES`, easy to drop/rename during spin-off.
 *
 * v0 tables (in the `oliver` schema):
 *   oliver.pending_tools — HITL state machine (requiresApproval flow)
 *   oliver.audit_log     — invocation log + verification results
 *
 * v0.1+ tables (not yet):
 *   oliver.user_profile (dialectic user modeling, Hermes-style)
 */

import {
  index,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Oliver's dedicated Postgres schema. Separate from `public` (where the
 * builder's own tables live). Still in the same database — preserves
 * cross-schema transactional atomicity (business op + audit write in
 * one commit).
 */
export const oliverSchema = pgSchema("oliver");

// ============================================================
// oliver.pending_tools — HITL state machine
// ============================================================
//
// Lifecycle:
//   proposed → pending_approval → (approved | rejected | timed_out)
//                                        │
//                                        ▼
//                                   executing → (succeeded | failed | failed_verification)
//
// When a tool with requiresApproval=true is called by the agent:
//   1. Row inserted with status="pending_approval"
//   2. Harness returns "awaiting approval" message to LLM
//   3. UI reads this table to render approval card
//   4. User clicks [Approve] → status="approved" → harness re-invokes tool
//   5. Or user clicks [Reject] → status="rejected" → tool never runs
//   6. If expires_at passes → status="timed_out"
//
// Re-invocation guard: if a pending row exists for (tool_name, input_hash),
// subsequent calls return "still awaiting approval" instead of creating a
// second pending entry.

export const pendingTools = oliverSchema.table(
  "pending_tools",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    toolName: text("tool_name").notNull(),
    input: jsonb("input").notNull(),
    /** Hash of (toolName + input) for re-invocation guard lookups. */
    inputHash: text("input_hash").notNull(),
    /** Preview diff (if tool.previewChange was defined). */
    previewBefore: jsonb("preview_before"),
    previewAfter: jsonb("preview_after"),
    /**
     * proposed | pending_approval | approved | rejected | timed_out |
     * executing | succeeded | failed | failed_verification
     */
    status: text("status").notNull().default("pending_approval"),
    /** Who proposed — "agent" or "mcp" (v0.1+). Always "agent" in v0. */
    proposedBy: text("proposed_by").notNull().default("agent"),
    /** Who approved, if any. NULL until approval. */
    approvedBy: text("approved_by"),
    rejectedBy: text("rejected_by"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    /** Result or error set when the tool actually executes post-approval. */
    result: jsonb("result"),
    errorMessage: text("error_message"),
  },
  (t) => ({
    // Re-invocation guard lookup: find pending entries by tool+input hash
    pendingLookupIdx: index("pending_tools_lookup_idx").on(
      t.orgId,
      t.toolName,
      t.inputHash,
      t.status,
    ),
    // Context assembly: load pending entries for an org at session start
    orgStatusIdx: index("pending_tools_org_status_idx").on(
      t.orgId,
      t.status,
    ),
  }),
);

// ============================================================
// oliver.audit_log — invocation + verification log
// ============================================================
//
// Every tool invocation is recorded here. Not just writes — reads too, so
// the audit is a complete log of agent activity.
//
// The audit also captures:
// - Verification results (when tool.verify was defined)
// - Approval events (when HITL was involved)
// - Errors (when execution failed)

export const auditLog = oliverSchema.table(
  "audit_log",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    toolName: text("tool_name").notNull(),
    /** "ui" (server action) or "agent" (chat tool). MCP in v0.1+. */
    source: text("source").notNull(),
    /** Hashed input (don't store raw if it has sensitive data). */
    inputHash: text("input_hash").notNull(),
    /** Full input (builder's responsibility to avoid PII). */
    input: jsonb("input"),
    /** Output of execute(), if succeeded. */
    output: jsonb("output"),
    /**
     * invoked | pending_approval | approved | rejected | succeeded |
     * failed | verified | failed_verification | verification_skipped
     */
    status: text("status").notNull(),
    /** Link to pending_tools row when applicable. */
    pendingToolId: text("pending_tool_id"),
    /** Latency in milliseconds. Populated after execute() returns. */
    latencyMs: numeric("latency_ms"),
    /** Error message if status indicates failure. */
    errorMessage: text("error_message"),
    errorCode: text("error_code"),
    /** Parent trace ID for grouping related events (HITL flow spans multiple rows). */
    traceId: text("trace_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    orgTimeIdx: index("audit_log_org_time_idx").on(t.orgId, t.createdAt),
    traceIdx: index("audit_log_trace_idx").on(t.traceId),
    toolIdx: index("audit_log_tool_idx").on(t.orgId, t.toolName),
  }),
);

// ============================================================
// Legacy exports (keep until all consumers migrate)
// ============================================================
// Nothing else references these yet — safe to remove in a follow-up
// commit once the refactor lands.
