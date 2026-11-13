import { createHmac, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"

import { getConfig } from "./config"
import { generateId, generateToken } from "./password"
import type { Session } from "@/lib/wms/types"

/**
 * Session cookies are `value.signature`, where the signature is an HMAC-SHA256
 * over the value using the configured secret.
 *
 * The cookie is therefore self-verifying: an attacker who can read or set
 * cookies (XSS in a sibling app, a misconfigured proxy) cannot forge a session
 * without the secret. There is no server-side trust placed in the payload.
 */

const SIGNATURE_SEPARATOR = "."

export interface SessionPayload {
  sessionId: string
  userId: string
  issuedAt: number
  expiresAt: number
}

function sign(value: string): string {
  return createHmac("sha256", getConfig().sessionSecret).update(value).digest("base64url")
}

/** Serialises and signs a session payload. */
export function issueSessionToken(session: Session): string {
  const payload: SessionPayload = {
    sessionId: session.id,
    userId: session.userId,
    issuedAt: Date.parse(session.createdAt),
    expiresAt: Date.parse(session.expiresAt),
  }
  const value = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  return `${value}${SIGNATURE_SEPARATOR}${sign(value)}`
}

export interface VerifyResult {
  ok: boolean
  payload?: SessionPayload
  reason?: "malformed" | "bad_signature" | "expired"
}

/** Verifies signature and expiry. Never throws. */
export function verifySessionToken(token: string | undefined | null): VerifyResult {
  if (!token) return { ok: false, reason: "malformed" }

  const separatorIndex = token.lastIndexOf(SIGNATURE_SEPARATOR)
  if (separatorIndex <= 0) return { ok: false, reason: "malformed" }

  const value = token.slice(0, separatorIndex)
  const signature = token.slice(separatorIndex + 1)

  const expected = sign(value)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on length mismatch — check first, then compare.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" }
  }

  let payload: SessionPayload
  try {
    payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as SessionPayload
  } catch {
    return { ok: false, reason: "malformed" }
  }

  if (typeof payload.expiresAt !== "number" || Date.now() > payload.expiresAt) {
    return { ok: false, reason: "expired" }
  }

  return { ok: true, payload }
}

/** Standard attributes for the session cookie. */
export function sessionCookieOptions() {
  const config = getConfig()
  return {
    httpOnly: true,
    sameSite: config.previewEmbedding ? ("none" as const) : ("lax" as const),
    secure: config.requireSecureCookies,
    path: "/",
    maxAge: config.sessionTtlSeconds,
  }
}

/** Creates a fresh session record + its signed cookie value. */
export function createSessionRecord(userId: string, ip: string, userAgent: string): { session: Session; token: string } {
  const config = getConfig()
  const now = Date.now()
  const session: Session = {
    id: generateId("sess"),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + config.sessionTtlSeconds * 1000).toISOString(),
    ip,
    userAgent,
    revoked: false,
  }
  return { session, token: issueSessionToken(session) }
}

/** Reads and verifies the session cookie from the incoming request. */
export function readSessionFromCookies(): SessionPayload | null {
  const config = getConfig()
  const cookie = cookies().get(config.cookieName)?.value
  const result = verifySessionToken(cookie)
  return result.ok ? (result.payload ?? null) : null
}

/** A fresh double-submit CSRF token (the cookie is readable by JS by design). */
export function newCsrfToken(): string {
  return generateToken(32)
}
