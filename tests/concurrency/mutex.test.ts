import { afterEach, describe, expect, it } from "vitest";
import {
  __resetRegistryForTests,
  acquireLock,
  withLock,
} from "../../src/concurrency/mutex";

afterEach(() => {
  __resetRegistryForTests();
});

describe("mutex — same key serialization", () => {
  it("two calls with the same key run sequentially", async () => {
    const log: string[] = [];

    const first = withLock("res:a", async () => {
      log.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      log.push("a-end");
      return "a";
    });

    // Let the first schedule, then start the second.
    await new Promise((r) => setTimeout(r, 5));

    const second = withLock("res:a", async () => {
      log.push("b-start");
      log.push("b-end");
      return "b";
    });

    const [ra, rb] = await Promise.all([first, second]);
    expect(ra).toBe("a");
    expect(rb).toBe("b");
    // b must start AFTER a ends.
    expect(log).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("three callers form a FIFO queue", async () => {
    const log: string[] = [];
    const delays = [30, 10, 20];
    const calls = ["a", "b", "c"].map((label, i) =>
      withLock("res:k", async () => {
        log.push(`${label}-start`);
        await new Promise((r) => setTimeout(r, delays[i]));
        log.push(`${label}-end`);
      }),
    );
    await Promise.all(calls);
    expect(log).toEqual([
      "a-start",
      "a-end",
      "b-start",
      "b-end",
      "c-start",
      "c-end",
    ]);
  });
});

describe("mutex — different keys parallel", () => {
  it("runs in parallel when keys differ", async () => {
    const log: string[] = [];

    const a = withLock("res:a", async () => {
      log.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      log.push("a-end");
    });
    const b = withLock("res:b", async () => {
      log.push("b-start");
      await new Promise((r) => setTimeout(r, 10));
      log.push("b-end");
    });

    await Promise.all([a, b]);
    // b is shorter and started on a different key — should finish first
    // despite being started second conceptually. Both starts happen
    // before either end.
    expect(log.indexOf("a-start")).toBeLessThan(log.indexOf("a-end"));
    expect(log.indexOf("b-start")).toBeLessThan(log.indexOf("b-end"));
    expect(log.indexOf("b-end")).toBeLessThan(log.indexOf("a-end"));
  });
});

describe("mutex — error handling releases lock", () => {
  it("a thrown error in fn still releases the lock for the next caller", async () => {
    // First call throws.
    await expect(
      withLock("res:x", async () => {
        throw new Error("first fails");
      }),
    ).rejects.toThrow("first fails");

    // Second call must be able to acquire (no deadlock).
    const result = await withLock("res:x", async () => "second-ran");
    expect(result).toBe("second-ran");
  });
});

describe("acquireLock — manual release", () => {
  it("double release is safe (idempotent)", async () => {
    const lock = await acquireLock("res:d");
    lock.release();
    lock.release();
    // Subsequent acquire works.
    const next = await acquireLock("res:d");
    next.release();
  });
});
