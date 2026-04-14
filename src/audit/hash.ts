/**
 * Deterministic hashing for tool inputs.
 *
 * Used for two things:
 *  1. audit_log.input_hash — lets you query "how many times was this exact
 *     input tried?" without reading the full JSON.
 *  2. HITL re-invocation guard — if a pending_tools row already exists for
 *     (orgId, toolName, inputHash), the agent's second call returns "still
 *     awaiting approval" instead of creating a duplicate pending row.
 *
 * Stable property: the same input object always produces the same hash,
 * independent of JS key-insertion order.
 */

import { createHash } from "node:crypto";

/**
 * Canonicalize a JSON-serializable value: sort object keys recursively so
 * { b: 1, a: 2 } and { a: 2, b: 1 } produce the same bytes. This is what
 * makes the hash order-independent.
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return `${JSON.stringify(k)}:${canonicalize(v)}`;
  });
  return `{${parts.join(",")}}`;
}

/**
 * Hash a tool input for audit + re-invocation guard lookups.
 * sha256, truncated to 16 hex chars (64 bits of entropy — plenty for
 * collision-avoidance within a single org's tool history).
 */
export function hashInput(input: unknown): string {
  const canonical = canonicalize(input);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
