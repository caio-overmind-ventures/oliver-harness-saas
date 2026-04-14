/**
 * Audit log type contract.
 *
 * Every tool lifecycle event is recorded as an entry in oliver.audit_log.
 * Multiple entries for the same tool call share a `traceId` so you can
 * reconstruct the full flow from pending → approved → succeeded (or
 * invoked → succeeded for non-HITL tools).
 */

/**
 * Lifecycle statuses, in rough order of occurrence:
 *
 *   non-HITL flow:
 *     invoked → succeeded (+ verified | failed_verification | verification_skipped)
 *     invoked → failed
 *
 *   HITL flow (adds extra rows):
 *     pending_approval → approved → invoked → succeeded (+ verify status)
 *     pending_approval → rejected (tool never runs)
 *     pending_approval → timed_out (tool never runs)
 *
 *   Bonus:
 *     audit_write_failed is emitted to a separate channel (console +
 *     onAuditFailure hook), not into audit_log itself, for obvious reasons.
 */
export type AuditStatus =
  | "invoked"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "timed_out"
  | "succeeded"
  | "failed"
  | "verified"
  | "failed_verification"
  | "verification_skipped";

/**
 * The data needed to record one audit event. Most fields are optional —
 * the logger populates what it can depending on the status.
 */
export interface AuditEvent {
  traceId: string;
  orgId: string;
  userId: string;
  toolName: string;
  source: "ui" | "agent";
  status: AuditStatus;
  inputHash: string;
  /** Full input (builder ensures no PII before invoking). */
  input?: unknown;
  output?: unknown;
  latencyMs?: number;
  errorMessage?: string;
  errorCode?: string;
  /** Link to oliver.pending_tools row when this event is part of HITL flow. */
  pendingToolId?: string;
}

/**
 * Called when the audit INSERT itself fails. Critical guard #1 from the
 * eng review: never silently lose audit data. Default handler logs to
 * console.error; builders can override to route to Sentry, Datadog, etc.
 */
export type OnAuditFailure = (
  event: AuditEvent,
  cause: unknown,
) => void | Promise<void>;
