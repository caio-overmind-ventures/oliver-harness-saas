/**
 * PendingToolStore — persistence layer for the HITL state machine.
 *
 * When the agent proposes a tool call that requires human approval, we
 * insert a row into `oliver.pending_tools` with status='pending_approval'.
 * The UI polls `listActive(orgId)` to render approval cards. When the user
 * clicks Approve/Reject, the corresponding server action flips the status
 * and (for approve) triggers real execution.
 *
 * Re-invocation guard: before inserting a new pending row we look for an
 * existing unexpired one with the same (orgId, toolName, inputHash). If
 * found, we return the existing row instead of creating a duplicate. This
 * means the LLM can retry its proposal N times without flooding the UI.
 *
 * Expiration is passive — `findActive` / `listActive` filter out rows
 * whose `expiresAt < now()`. There's no cron job in v0; stale rows simply
 * stop showing up in the UI and stop blocking re-proposals after their TTL.
 */

import { and, desc, eq, gte } from "drizzle-orm";
import { generateId } from "../db/ids";
import { pendingTools } from "../db/schema";
import type { DrizzleDbLike } from "../db/types";

export const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * The subset of fields callers need. Status is a string union, not the DB
 * column's raw text, to keep the state machine documented here.
 */
export type PendingToolStatus =
  | "pending_approval"
  | "approved"
  | "executing"
  | "rejected"
  | "timed_out"
  | "succeeded"
  | "failed"
  | "failed_verification";

export interface PendingToolRow {
  approvedBy: string | null;
  createdAt: Date;
  errorMessage: string | null;
  expiresAt: Date;
  id: string;
  input: unknown;
  inputHash: string;
  orgId: string;
  previewAfter: unknown;
  previewBefore: unknown;
  proposedBy: string;
  rejectedBy: string | null;
  result: unknown;
  status: PendingToolStatus;
  toolName: string;
  updatedAt: Date;
  userId: string;
}

export interface CreatePendingInput {
  input: unknown;
  inputHash: string;
  orgId: string;
  previewAfter?: unknown;
  previewBefore?: unknown;
  toolName: string;
  /** Override the default 10-minute TTL. */
  ttlMs?: number;
  userId: string;
}

export class PendingToolStore {
  constructor(private readonly db: DrizzleDbLike) {}

  /**
   * Find an active (unexpired, not-yet-resolved) pending row for the given
   * (orgId, toolName, inputHash). Used by the re-invocation guard in the
   * agent-tools channel so a retry doesn't create a duplicate card.
   */
  async findActive(params: {
    orgId: string;
    toolName: string;
    inputHash: string;
  }): Promise<PendingToolRow | null> {
    const rows = (await this.db
      .select()
      .from(pendingTools)
      .where(
        and(
          eq(pendingTools.orgId, params.orgId),
          eq(pendingTools.toolName, params.toolName),
          eq(pendingTools.inputHash, params.inputHash),
          eq(pendingTools.status, "pending_approval"),
          gte(pendingTools.expiresAt, new Date())
        )
      )) as PendingToolRow[];
    return rows[0] ?? null;
  }

  async getById(id: string): Promise<PendingToolRow | null> {
    const rows = (await this.db
      .select()
      .from(pendingTools)
      .where(eq(pendingTools.id, id))) as PendingToolRow[];
    return rows[0] ?? null;
  }

  async create(params: CreatePendingInput): Promise<PendingToolRow> {
    const id = generateId.pendingTool();
    const now = new Date();
    const ttl = params.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    const expiresAt = new Date(now.getTime() + ttl);

    const row: PendingToolRow = {
      id,
      orgId: params.orgId,
      userId: params.userId,
      toolName: params.toolName,
      input: params.input,
      inputHash: params.inputHash,
      previewBefore: params.previewBefore ?? null,
      previewAfter: params.previewAfter ?? null,
      status: "pending_approval",
      proposedBy: "agent",
      approvedBy: null,
      rejectedBy: null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
      result: null,
      errorMessage: null,
    };

    await this.db.insert(pendingTools).values(row);
    return row;
  }

  async markExecuting(id: string, approvedBy: string): Promise<void> {
    await this.db
      .update(pendingTools)
      .set({
        status: "executing",
        approvedBy,
        updatedAt: new Date(),
      })
      .where(eq(pendingTools.id, id));
  }

  async markSucceeded(id: string, result: unknown): Promise<void> {
    await this.db
      .update(pendingTools)
      .set({
        status: "succeeded",
        result: result ?? null,
        updatedAt: new Date(),
      })
      .where(eq(pendingTools.id, id));
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.db
      .update(pendingTools)
      .set({
        status: "failed",
        errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(pendingTools.id, id));
  }

  async markRejected(id: string, rejectedBy: string): Promise<void> {
    await this.db
      .update(pendingTools)
      .set({
        status: "rejected",
        rejectedBy,
        updatedAt: new Date(),
      })
      .where(eq(pendingTools.id, id));
  }

  /**
   * List all active (unexpired, still-pending) approvals for an org.
   * Sorted by most recent first so the UI naturally shows the newest card
   * on top. Excludes rows past their `expiresAt`.
   */
  async listActive(orgId: string): Promise<PendingToolRow[]> {
    const rows = (await this.db
      .select()
      .from(pendingTools)
      .where(
        and(
          eq(pendingTools.orgId, orgId),
          eq(pendingTools.status, "pending_approval"),
          gte(pendingTools.expiresAt, new Date())
        )
      )
      .orderBy(desc(pendingTools.createdAt))) as PendingToolRow[];
    return rows;
  }
}
