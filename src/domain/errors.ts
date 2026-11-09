/** Errors shared across layers. Messages never contain secrets. */

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

/** The request conflicts with current state (stale revision, already approved, duplicate draft, ...). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** The caller is known but not allowed to do this (for example an AI agent trying to edit a mandate). */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** The caller is not authenticated. */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * An external service (PayPal) could not be reached, refused, or is not configured. The message is ours, never the
 * provider's. `correlationId` is our own id for the operation (and `reference` the provider's debug id, if any) so
 * a person can find the audit trail without any secret or provider text being shown.
 */
export class UpstreamError extends Error {
  readonly code: "NOT_CONFIGURED" | "UNAVAILABLE";
  readonly correlationId: string | null;
  readonly reference: string | null;
  constructor(
    code: "NOT_CONFIGURED" | "UNAVAILABLE",
    message: string,
    ids: { correlationId?: string | null; reference?: string | null } = {},
  ) {
    super(message);
    this.name = "UpstreamError";
    this.code = code;
    this.correlationId = ids.correlationId ?? null;
    this.reference = ids.reference ?? null;
  }
}
