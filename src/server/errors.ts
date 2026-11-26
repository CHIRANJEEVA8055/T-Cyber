/** Errors with messages that are safe to show to the officer. */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "FORBIDDEN" | "VALIDATION" | "CONFLICT" | "PRECONDITION" = "VALIDATION",
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFoundError = (what = "record") =>
  new AppError(`This ${what} does not exist or you do not have access to it.`, "NOT_FOUND");
export const forbiddenError = (message = "You do not have permission to do this.") => new AppError(message, "FORBIDDEN");
export const conflictError = (message: string) => new AppError(message, "CONFLICT");

export type ActionFailure = { ok: false; error: string; code?: AppError["code"]; fieldErrors?: Record<string, string> };
export type ActionResult<T = undefined> = { ok: true; data: T; message?: string } | ActionFailure;

/** Converts thrown errors to a serialisable result for server actions. Unknown errors are not leaked. */
export function toActionError(err: unknown): ActionFailure {
  if (err instanceof AppError) return { ok: false, error: err.message, code: err.code, fieldErrors: err.fieldErrors };
  console.error("[t-cyber] unexpected error", err);
  return {
    ok: false,
    error: "Something went wrong while saving. Nothing was changed. Try again, and if it keeps failing, reload the page.",
  };
}
