import { NextResponse } from "next/server"
import { z, ZodError, type ZodTypeAny } from "zod"

/**
 * HTTP helpers shared by every route handler.
 *
 * The point of this module is that route handlers never hand-roll a JSON error
 * shape, so the client always gets `{ error: { code, message, details } }` and
 * stack traces / internal messages never leak to the browser.
 */

export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "CSRF_FAILED"
  | "LOCKED"
  | "INTERNAL"

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  CSRF_FAILED: 403,
  LOCKED: 423,
  INTERNAL: 500,
}

export class ApiError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = "ApiError"
    this.code = code
    this.status = STATUS[code]
    this.details = details
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError("BAD_REQUEST", message, details)
  }
  static unauthorized(message = "Authentication required.") {
    return new ApiError("UNAUTHORIZED", message)
  }
  static forbidden(message = "You do not have permission to perform this action.") {
    return new ApiError("FORBIDDEN", message)
  }
  static notFound(message = "Resource not found.") {
    return new ApiError("NOT_FOUND", message)
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError("CONFLICT", message, details)
  }
  static locked(message: string) {
    return new ApiError("LOCKED", message)
  }
}

export function errorResponse(error: ApiError): NextResponse {
  const headers: Record<string, string> = {}
  if (error.code === "RATE_LIMITED" && error.details && typeof error.details === "object") {
    const retry = (error.details as { retryAfterMs?: number }).retryAfterMs
    if (typeof retry === "number") headers["Retry-After"] = String(Math.ceil(retry / 1000))
  }
  return NextResponse.json(
    { error: { code: error.code, message: error.message, details: error.details ?? undefined } },
    { status: error.status, headers },
  )
}

/**
 * Converts any thrown value into a safe response.
 * Unknown errors are logged server-side and reported to the client as a
 * generic 500 — leaking internals is how you hand an attacker a map.
 */
export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) return errorResponse(error)

  if (error instanceof ZodError) {
    return errorResponse(
      new ApiError(
        "VALIDATION_ERROR",
        "The submitted data failed validation.",
        error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      ),
    )
  }

  console.error("[wms] unhandled route error:", error)
  return errorResponse(new ApiError("INTERNAL", "An unexpected error occurred. The event has been logged."))
}

export function ok<T>(data: T, init?: { status?: number; headers?: Record<string, string> }): NextResponse {
  return NextResponse.json(data, { status: init?.status ?? 200, headers: init?.headers })
}

export function created<T>(data: T): NextResponse {
  return ok(data, { status: 201 })
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 })
}

/** Parses and validates a request body, or throws a VALIDATION_ERROR. */
export async function parseBody<Schema extends ZodTypeAny>(request: Request, schema: Schema): Promise<z.infer<Schema>> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    throw ApiError.badRequest("Request body must be valid JSON.")
  }
  return schema.parse(raw)
}

/** Validates query params. */
export function parseQuery<Schema extends ZodTypeAny>(url: URL | string, schema: Schema): z.infer<Schema> {
  const searchParams = new URL(url).searchParams
  const raw: Record<string, string | string[]> = {}
  for (const [key, value] of searchParams.entries()) {
    const existing = raw[key]
    raw[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value]
  }
  return schema.parse(raw)
}

/** Bounded integer parse for pagination — rejects absurd values before use. */
export function readIntParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === "") return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Trims and caps a free-text filter so it cannot be used as a DoS vector. */
export function readSearchParam(value: string | null, max = 120): string {
  if (!value) return ""
  return value.trim().slice(0, max)
}
