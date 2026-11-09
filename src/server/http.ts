import "server-only";

import { NextResponse } from "next/server";

import type { FieldError } from "@/domain/mandate";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  UpstreamError,
} from "@/domain/errors";

/** An error that already knows its HTTP shape. Messages are safe to show to the caller. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const BASE_HEADERS = { "Cache-Control": "no-store" } as const;

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(body, { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function validationFailed(errors: FieldError[]): NextResponse {
  return json(
    { error: "VALIDATION_FAILED", message: "Some fields are invalid.", fields: errors },
    422,
  );
}

export const MAX_BODY_BYTES = 16 * 1024;

/**
 * Reads a bounded JSON body. Requires `Content-Type: application/json`: a plain HTML form (the classic
 * CSRF vehicle) cannot send that cross-site without a CORS preflight, which this API never answers.
 */
/**
 * Reads a request body as text but stops as soon as it exceeds `maxBytes`, so a client that omits (or lies about)
 * Content-Length cannot make the server buffer an unbounded body before the size check runs.
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new HttpError(413, "BODY_TOO_LARGE", "The request body is too large.");
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, "BODY_TOO_LARGE", "The request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type)) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the body as application/json.");
  }
  const text = await readBoundedText(request, MAX_BODY_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
}

/** Maps any thrown error to a response. Unknown errors become a bare 500: no message, no stack. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError)
    return json({ error: err.code, message: err.message }, err.status, err.headers);
  if (err instanceof UnauthorizedError)
    return json({ error: "UNAUTHENTICATED", message: err.message }, 401);
  if (err instanceof ForbiddenError) return json({ error: "FORBIDDEN", message: err.message }, 403);
  if (err instanceof NotFoundError) return json({ error: "NOT_FOUND", message: err.message }, 404);
  if (err instanceof ConflictError) return json({ error: "CONFLICT", message: err.message }, 409);
  if (err instanceof UpstreamError)
    return json(
      {
        error: err.code === "NOT_CONFIGURED" ? "PAYPAL_NOT_CONFIGURED" : "PAYPAL_UNAVAILABLE",
        message: err.message,
        ...(err.correlationId === null ? {} : { correlationId: err.correlationId }),
        ...(err.reference === null ? {} : { reference: err.reference }),
      },
      err.code === "NOT_CONFIGURED" ? 503 : 502,
    );
  return json({ error: "INTERNAL_ERROR", message: "Something went wrong." }, 500);
}
