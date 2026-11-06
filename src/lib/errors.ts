export type NotecliErrorCode =
  | "usage_error"
  | "input_error"
  | "auth_error"
  | "not_found"
  | "rate_limited"
  | "api_error"
  | "unknown_error";

const EXIT_CODES: Record<NotecliErrorCode, number> = {
  usage_error: 2,
  auth_error: 3,
  not_found: 4,
  rate_limited: 5,
  api_error: 6,
  input_error: 7,
  unknown_error: 1,
};

export interface NotecliErrorOptions {
  code: NotecliErrorCode;
  message: string;
  statusCode?: number;
  retryAfter?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class NotecliError extends Error {
  readonly code: NotecliErrorCode;
  readonly statusCode?: number;
  readonly retryAfter?: number;
  readonly details?: Record<string, unknown>;

  constructor(options: NotecliErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "NotecliError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.retryAfter = options.retryAfter;
    this.details = options.details;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}

export class UsageError extends NotecliError {
  constructor(message: string) {
    super({ code: "usage_error", message });
    this.name = "UsageError";
  }
}

export class InputError extends NotecliError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: "input_error", message, details });
    this.name = "InputError";
  }
}

export class AuthError extends NotecliError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: "auth_error", message, details });
    this.name = "AuthError";
  }
}

export class NotFoundError extends NotecliError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: "not_found", message, statusCode: 404, details });
    this.name = "NotFoundError";
  }
}

export class RateLimitError extends NotecliError {
  constructor(message: string, retryAfter?: number, details?: Record<string, unknown>) {
    super({ code: "rate_limited", message, statusCode: 429, retryAfter, details });
    this.name = "RateLimitError";
  }
}

export class ApiError extends NotecliError {
  constructor(
    message: string,
    statusCode?: number,
    details?: Record<string, unknown>,
    cause?: unknown
  ) {
    super({ code: "api_error", message, statusCode, details, cause });
    this.name = "ApiError";
  }
}

export function errorExitCode(error: unknown): number {
  return error instanceof NotecliError ? error.exitCode : 1;
}

export function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof NotecliError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.statusCode !== undefined ? { status: error.statusCode } : {}),
        ...(error.retryAfter !== undefined ? { retry_after: error.retryAfter } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    };
  }

  return {
    error: {
      code: "unknown_error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
