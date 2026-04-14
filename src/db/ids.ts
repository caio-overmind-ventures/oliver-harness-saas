/**
 * Oliver's ID generators. Prefixed-nanoid pattern (e.g. `hpt_xxx`) so
 * IDs are scannable and self-describing in audit logs.
 *
 * - hpt_xxx = harness pending tool (HITL)
 * - hal_xxx = harness audit log entry
 * - htr_xxx = harness trace id (groups related audit entries)
 */

import { customAlphabet } from "nanoid";

const nanoid = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  22,
);

export const generateId = {
  pendingTool: () => `hpt_${nanoid()}`,
  auditLogEntry: () => `hal_${nanoid()}`,
  trace: () => `htr_${nanoid()}`,
};
