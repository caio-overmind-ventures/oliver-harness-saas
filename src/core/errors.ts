/**
 * ToolError — typed errors from tool execution.
 *
 * When a tool throws, the harness catches and wraps in ToolError before:
 * - Logging to audit
 * - Returning to the caller (UI gets { ok: false, error }, agent gets error
 *   string in tool result)
 *
 * Builders can throw ToolError directly for expected failures (validation,
 * authorization) with a specific code. Unexpected errors become
 * ToolError with code="unexpected".
 */

export type ToolErrorCode =
  | "validation"
  | "authorization"
  | "not_found"
  | "conflict"
  | "timeout"
  | "unexpected";

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly toolName: string;
  readonly cause?: unknown;

  constructor(params: {
    code: ToolErrorCode;
    toolName: string;
    message: string;
    cause?: unknown;
  }) {
    super(params.message);
    this.name = "ToolError";
    this.code = params.code;
    this.toolName = params.toolName;
    this.cause = params.cause;
  }

  /**
   * Serialize for audit log / tool result. Never includes the raw `cause`
   * (which might contain sensitive data like DB connection strings).
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      toolName: this.toolName,
      message: this.message,
    };
  }
}

/**
 * Wraps an unknown error into a ToolError. Used by the harness to normalize
 * anything a tool might throw.
 */
export function wrapError(toolName: string, error: unknown): ToolError {
  if (error instanceof ToolError) return error;

  const message =
    error instanceof Error ? error.message : "Unknown error during tool execution";

  return new ToolError({
    code: "unexpected",
    toolName,
    message,
    cause: error,
  });
}
