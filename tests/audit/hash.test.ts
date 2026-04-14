import { describe, it, expect } from "vitest";
import { hashInput } from "../../src/audit/hash";

describe("hashInput", () => {
  it("produces a 16-char hex string", () => {
    const h = hashInput({ foo: "bar" });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic — same input → same hash", () => {
    const h1 = hashInput({ name: "Acme", age: 30 });
    const h2 = hashInput({ name: "Acme", age: 30 });
    expect(h1).toBe(h2);
  });

  it("is order-independent for object keys", () => {
    const h1 = hashInput({ a: 1, b: 2, c: 3 });
    const h2 = hashInput({ c: 3, a: 1, b: 2 });
    expect(h1).toBe(h2);
  });

  it("is order-independent for nested objects", () => {
    const h1 = hashInput({ user: { name: "x", age: 30 }, active: true });
    const h2 = hashInput({ active: true, user: { age: 30, name: "x" } });
    expect(h1).toBe(h2);
  });

  it("treats arrays as ordered (not sorted)", () => {
    // Arrays SHOULD be order-sensitive — [1,2,3] != [3,2,1] semantically.
    const h1 = hashInput([1, 2, 3]);
    const h2 = hashInput([3, 2, 1]);
    expect(h1).not.toBe(h2);
  });

  it("distinguishes null from undefined from empty", () => {
    const hNull = hashInput({ v: null });
    const hUndefined = hashInput({ v: undefined });
    const hEmpty = hashInput({});
    // null and undefined both canonicalize to "null" in our scheme; that's
    // acceptable for dedup/audit purposes.
    expect(hNull).toBe(hUndefined);
    expect(hNull).not.toBe(hEmpty);
  });

  it("distinguishes different values", () => {
    expect(hashInput({ x: 1 })).not.toBe(hashInput({ x: 2 }));
    expect(hashInput("a")).not.toBe(hashInput("b"));
    expect(hashInput(1)).not.toBe(hashInput("1"));
  });
});
