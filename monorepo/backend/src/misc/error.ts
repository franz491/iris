// misc/error.ts

/** Base error carrying an HTTP-ish code and optional details. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string = "internal_error",
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(`${what} not found`, "not_found");
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "unauthorized") {
    super(message, "unauthorized");
    this.name = "UnauthorizedError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "validation_error", details);
    this.name = "ValidationError";
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super(message, "payload_too_large");
    this.name = "PayloadTooLargeError";
  }
}

export class ConfigError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "config_error", details);
    this.name = "ConfigError";
  }
}

export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof SyntaxError) return new AppError("invalid JSON payload", "validation_error");
  if (e instanceof Error) return new AppError(e.message);
  return new AppError(String(e));
}
