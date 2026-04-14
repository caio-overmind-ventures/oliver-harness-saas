import { describe, it, expect } from "vitest";
import { runVerify } from "../../src/audit/verify";

describe("runVerify", () => {
  it("returns 'verified' when verify resolves true quickly", async () => {
    const result = await runVerify(async () => true);
    expect(result.outcome).toBe("verified");
    expect(result.error).toBeUndefined();
  });

  it("returns 'failed_verification' when verify resolves false", async () => {
    const result = await runVerify(async () => false);
    expect(result.outcome).toBe("failed_verification");
  });

  it("returns 'verification_skipped' when verify throws", async () => {
    const result = await runVerify(async () => {
      throw new Error("db query blew up");
    });
    expect(result.outcome).toBe("verification_skipped");
    expect(result.error).toBe("db query blew up");
  });

  it("returns 'verification_skipped' on timeout", async () => {
    // Set a long delay that exceeds the 5s timeout — but since tests shouldn't
    // actually wait 5s, we test the structure. We simulate by pre-racing.
    const never = new Promise<boolean>(() => {});
    // Wrap so we can cancel it via the race — actual timeout fires inside runVerify.
    // Shortcut: instead of real 5s, spot-check via throwing; real timeout behavior
    // is covered by the implementation itself (Promise.race w/ setTimeout).
    // Just ensure the function resolves with verification_skipped and a timeout msg.

    // In this test, we force a timeout by setting a Promise that never resolves.
    // NOTE: this test WILL take ~5s in practice. Keep to one timeout test.
    const result = await runVerify(() => never);
    expect(result.outcome).toBe("verification_skipped");
    expect(result.error).toMatch(/timeout/);
  }, 10_000); // allow up to 10s for the 5s timeout to fire + margin
});
