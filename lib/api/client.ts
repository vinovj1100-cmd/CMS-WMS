/**
 * Browser-side API client.
 *
 * Centralises the three things every call needs:
 *   - the CSRF header the server expects on state-changing requests
 *   - credentials so the session cookie travels
 *   - turning a `{ error: { code, message, details } }` body into a thrown
 *     `ApiRequestError` the UI can render
 */

const CSRF_COOKIE = "wms_csrf"
const CSRF_HEADER = "x-wms-csrf"

export class ApiRequestError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = "ApiRequestError"
    this.status = status
    this.code = code
    this.details = details
  }

  /** True when the caller should send the user to the login screen. */
  get isUnauthorized(): boolean {
    return this.status === 401
  }
}

function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]*)`))
  return match ? decodeURIComponent(match[1]!) : null
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  body?: unknown
  signal?: AbortSignal
  headers?: Record<string, string>
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET"
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.headers,
  }

  // The double-submit token is read from the cookie the server set. Safe
  // requests do not need it.
  if (method !== "GET") {
    const token = readCsrfCookie()
    if (token) headers[CSRF_HEADER] = token
  }

  let payload: BodyInit | undefined
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json"
    payload = JSON.stringify(options.body)
  }

  const response = await fetch(path, {
    method,
    headers,
    body: payload,
    // Session + CSRF cookies must be sent.
    credentials: "same-origin",
    signal: options.signal,
    cache: "no-store",
  })

  // 204 and empty bodies are valid successes.
  if (response.status === 204) return undefined as T

  const text = await response.text()
  const parsed: unknown = text ? safeJson(text) : null

  if (!response.ok) {
    const body = parsed as { error?: { code?: string; message?: string; details?: unknown } } | null
    throw new ApiRequestError(
      response.status,
      body?.error?.code ?? "UNKNOWN",
      body?.error?.message ?? `Request failed with status ${response.status}.`,
      body?.error?.details,
    )
  }

  return parsed as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { method: "GET", signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
}

/** Builds a query string, dropping empty values so filters stay readable. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue
    search.set(key, String(value))
  }
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ""
}
