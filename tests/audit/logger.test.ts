import { describe, it, expect, vi } from "vitest";
import { AuditLogger, newTraceId } from "../../src/audit/logger";
import type { DrizzleDbLike } from "../../src/audit/logger";
import type { AuditEvent } from "../../src/audit/types";

function makeFakeDb(opts: { throwOnInsert?: boolean } = {}): {
  db: DrizzleDbLike;
  values: ReturnType<typeof vi.fn>;
} {
  const values = vi.fn(async (_v: unknown) => {
    if (opts.throwOnInsert) throw new Error("db is down");
    return undefined;
  });
  const db: DrizzleDbLike = {
    insert: () => ({ values }),
  };
  return { db, values };
}

const baseEvent: AuditEvent = {
  traceId: "htr_test",
  orgId: "org_test",
  userId: "usr_test",
  toolName: "createCustomer",
  source: "agent",
  status: "succeeded",
  inputHash: "abc1234567890def",
  input: { name: "Acme" },
  output: { id: "cust_123" },
  latencyMs: 42,
};

describe("AuditLogger.record", () => {
  it("inserts a row with the expected shape", async () => {
    const { db, values } = makeFakeDb();
    const logger = new AuditLogger(db);

    await logger.record(baseEvent);

    expect(values).toHaveBeenCalledTimes(1);
    const row = values.mock.calls[0][0];
    expect(row.traceId).toBe("htr_test");
    expect(row.orgId).toBe("org_test");
    expect(row.toolName).toBe("createCustomer");
    expect(row.status).toBe("succeeded");
    expect(row.inputHash).toBe("abc1234567890def");
    expect(row.input).toEqual({ name: "Acme" });
    expect(row.output).toEqual({ id: "cust_123" });
    // latencyMs is stringified (numeric column).
    expect(row.latencyMs).toBe("42");
    expect(row.id).toMatch(/^hal_/);
  });

  it("coerces missing optional fields to null", async () => {
    const { db, values } = makeFakeDb();
    const logger = new AuditLogger(db);

    await logger.record({
      traceId: "htr_x",
      orgId: "org_x",
      userId: "usr_x",
      toolName: "probe",
      source: "ui",
      status: "invoked",
      inputHash: "hash",
      // no input, output, latencyMs, errors, pendingToolId
    });

    const row = values.mock.calls[0][0];
    expect(row.input).toBe(null);
    expect(row.output).toBe(null);
    expect(row.latencyMs).toBe(null);
    expect(row.errorMessage).toBe(null);
    expect(row.errorCode).toBe(null);
    expect(row.pendingToolId).toBe(null);
  });

  it("does NOT throw when the insert fails (critical guard #1)", async () => {
    const { db } = makeFakeDb({ throwOnInsert: true });
    const onFailure = vi.fn();
    const logger = new AuditLogger(db, onFailure);

    await expect(logger.record(baseEvent)).resolves.toBeUndefined();

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toBe(baseEvent);
    expect((onFailure.mock.calls[0][1] as Error).message).toBe("db is down");
  });

  it("falls back to console.error when no onFailure handler is provided", async () => {
    const { db } = makeFakeDb({ throwOnInsert: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new AuditLogger(db); // default handler

    await logger.record(baseEvent);

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toContain("audit write failed");
    spy.mockRestore();
  });

  it("survives a throwing onFailure handler without propagating", async () => {
    const { db } = makeFakeDb({ throwOnInsert: true });
    const onFailure = vi.fn(() => {
      throw new Error("handler exploded");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new AuditLogger(db, onFailure);

    await expect(logger.record(baseEvent)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("newTraceId", () => {
  it("produces unique prefixed IDs", () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^htr_/);
    expect(b).toMatch(/^htr_/);
  });
});
