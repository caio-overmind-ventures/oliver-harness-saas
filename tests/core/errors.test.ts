import { describe, expect, it } from "vitest";
import { ToolError, wrapError } from "../../src/core/errors";

describe("ToolError", () => {
  it("constructs with explicit fields", () => {
    const err = new ToolError({
      code: "validation",
      toolName: "createQuote",
      message: "Invalid quote id",
    });

    expect(err.name).toBe("ToolError");
    expect(err.code).toBe("validation");
    expect(err.toolName).toBe("createQuote");
    expect(err.message).toBe("Invalid quote id");
    expect(err).toBeInstanceOf(Error);
  });

  it("serializes without leaking cause", () => {
    const cause = { sensitive: "db-connection-string" };
    const err = new ToolError({
      code: "unexpected",
      toolName: "deleteQuote",
      message: "Something broke",
      cause,
    });

    const json = err.toJSON();
    expect(json).toEqual({
      name: "ToolError",
      code: "unexpected",
      toolName: "deleteQuote",
      message: "Something broke",
    });
    expect(json).not.toHaveProperty("cause");
  });
});

describe("wrapError", () => {
  it("returns ToolError as-is", () => {
    const original = new ToolError({
      code: "authorization",
      toolName: "publishQuote",
      message: "Not allowed",
    });

    const wrapped = wrapError("publishQuote", original);
    expect(wrapped).toBe(original);
  });

  it("wraps a plain Error as unexpected", () => {
    const wrapped = wrapError("someTool", new Error("boom"));
    expect(wrapped.code).toBe("unexpected");
    expect(wrapped.toolName).toBe("someTool");
    expect(wrapped.message).toBe("boom");
  });

  it("wraps non-Error values with fallback message", () => {
    const wrapped = wrapError("weirdTool", "just a string");
    expect(wrapped.code).toBe("unexpected");
    expect(wrapped.message).toBe("Unknown error during tool execution");
  });
});
