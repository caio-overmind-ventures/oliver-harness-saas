/**
 * AuditLogger — writes every tool lifecycle event to oliver.audit_log.
 *
 * Instantiated once per agent (at createAgent time) with a Drizzle-like
 * db handle. The Gateway channels call `record()` at the right moments:
 *
 *   - Before execute: record(invoked)
 *   - After success: record(succeeded, output, latencyMs)
 *   - After failure: record(failed, errorMessage, latencyMs)
 *   - Verify hook: record(verified | failed_verification | verification_skipped)
 *   - HITL transitions (Phase 4b): record(pending_approval | approved | rejected | timed_out)
 *
 * Critical guard #1 (eng review): audit write failure is surfaced, NOT
 * silenced. If the INSERT throws, the configured `onAuditFailure` is
 * invoked (default: console.error). The tool call itself is NOT rolled
 * back — losing business state to save audit state would be worse.
 */

import { auditLog } from "../db/schema";
import { generateId } from "../db/ids";
import type { DrizzleDbLike } from "../db/types";
import type { AuditEvent, OnAuditFailure } from "./types";

// Re-exported for backwards compatibility (was defined here in Phase 4a).
export type { DrizzleDbLike };

const defaultOnAuditFailure: OnAuditFailure = (event, cause) => {
  console.error(
    `[@repo/oliver] audit write failed for tool "${event.toolName}" (status=${event.status}):`,
    cause,
  );
};

export class AuditLogger {
  constructor(
    private readonly db: DrizzleDbLike,
    private readonly onFailure: OnAuditFailure = defaultOnAuditFailure,
  ) {}

  /**
   * Write one audit event. Non-throwing by design — a failure inside
   * record() must NOT propagate to the tool caller. Critical guard #1.
   */
  async record(event: AuditEvent): Promise<void> {
    try {
      await this.db.insert(auditLog).values({
        id: generateId.auditLogEntry(),
        orgId: event.orgId,
        userId: event.userId,
        toolName: event.toolName,
        source: event.source,
        inputHash: event.inputHash,
        input: event.input ?? null,
        output: event.output ?? null,
        status: event.status,
        pendingToolId: event.pendingToolId ?? null,
        latencyMs: event.latencyMs != null ? String(event.latencyMs) : null,
        errorMessage: event.errorMessage ?? null,
        errorCode: event.errorCode ?? null,
        traceId: event.traceId,
      });
    } catch (cause) {
      try {
        await this.onFailure(event, cause);
      } catch (handlerErr) {
        // If even the failure handler throws, fall back to console.error.
        // Nothing else we can do without risking a loop.
        console.error(
          "[@repo/oliver] audit onFailure handler threw:",
          handlerErr,
        );
      }
    }
  }
}

/**
 * Generate a new trace id for one logical tool invocation. Multiple audit
 * rows share the same trace id when they belong to the same flow (HITL
 * propose → approve → execute → verify).
 */
export function newTraceId(): string {
  return generateId.trace();
}
