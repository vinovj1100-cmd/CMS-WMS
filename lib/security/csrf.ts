import { timingSafeEqual } from "node:crypto"

import { getConfig } from "./config"
import { newCsrfToken } from "./session"

/**
 * Double-submit cookie CSRF defence.
 *
 * The server sets `wms_csrf` as a *readable* (non-HttpOnly) cookie; the client
 * echoes it back in the `x-wms-csrf` header on every state-changing request.
 * A cross-origin attacker cannot read the cookie value, so it cannot populate
 * the header.
 *
 * This sits on top of `SameSite=Lax` on the session cookie — the two are
 * complementary, not redundant.
 */

export function csrfCookieOptions() {
  const config = getConfig()
  return {
    // Deliberately NOT httpOnly: the browser JS needs to read it.
    httpOnly: false,
    sameSite: "lax" as const,
    secure: config.requireSecureCookies,
    path: "/",
    maxAge: config.sessionTtlSeconds,
  }
}

/** Methods that mutate state and therefore require a CSRF token. */
export const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

export function requiresCsrf(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase())
}

/**
 * Validates the header against the cookie.
 * Also accepts a same-origin `Origin`/`Referer` match, which keeps non-browser
 * API clients (curl, a scanner app with no JS) working.
 */
export function verifyCsrf(request: Request): { ok: boolean; reason?: string } {
  const config = getConfig()
  const cookieToken = readCookie(request, config.csrfCookieName)
  const headerToken = request.headers.get(config.csrfHeaderName)

  if (cookieToken && headerToken) {
    return equalSafe(cookieToken, headerToken)
      ? { ok: true }
      : { ok: false, reason: "CSRF token mismatch" }
  }

  // No token pair present: fall back to a strict same-origin check.
  const origin = request.headers.get("origin") ?? request.headers.get("referer")
  if (origin) {
    try {
      const expected = new URL(config.siteUrl).origin
      return new URL(origin).origin === expected ? { ok: true } : { ok: false, reason: "Cross-origin request rejected" }
    } catch {
      return { ok: false, reason: "Malformed Origin header" }
    }
  }

  // No Origin/Referer at all (same-origin navigation, server-to-server).
  return { ok: true }
}

/** Rotates the CSRF token. Called on login and on session revocation. */
export function rotateCsrfToken(): { token: string; cookieName: string; options: ReturnType<typeof csrfCookieOptions> } {
  const config = getConfig()
  return { token: newCsrfToken(), cookieName: config.csrfCookieName, options: csrfCookieOptions() }
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie")
  if (!header) return undefined
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index === -1) continue
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim())
    }
  }
  return undefined
}

function equalSafe(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
