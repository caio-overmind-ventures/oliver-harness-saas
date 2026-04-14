/**
 * Verify hook runner with a hard timeout.
 *
 * Critical guard #3 from the eng review: `verify()` is an optional
 * post-execute check a tool defines to confirm the operation took effect
 * (e.g., "did the DB really record the discount?"). It must not:
 *  - Hang the response if verify() itself is slow.
 *  - Pretend the verification passed if it threw.
 *
 * Behavior:
 *   verify returns true within 5s → "verified"
 *   verify returns false within 5s → "failed_verification"
 *   verify throws OR times out → "verification_skipped"
 *     (NOT "failed_verification" — we don't know whether it worked)
 */

const VERIFY_TIMEOUT_MS = 5_000;

export type VerifyOutcome =
  | "verified"
  | "failed_verification"
  | "verification_skipped";

export interface VerifyResult {
  outcome: VerifyOutcome;
  /** Error message if the verify threw or timed out. */
  error?: string;
}

/**
 * Run a verify callback with a hard timeout. Never throws — always returns
 * a VerifyResult the audit logger can record.
 */
export async function runVerify(
  verify: () => Promise<boolean>,
): Promise<VerifyResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race<boolean | "timeout">([
      verify(),
      new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), VERIFY_TIMEOUT_MS);
      }),
    ]);

    if (result === "timeout") {
      return {
        outcome: "verification_skipped",
        error: `verify() exceeded ${VERIFY_TIMEOUT_MS}ms timeout`,
      };
    }
    return { outcome: result ? "verified" : "failed_verification" };
  } catch (err) {
    return {
      outcome: "verification_skipped",
      error: err instanceof Error ? err.message : "verify() threw",
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
