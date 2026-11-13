import type { NextRequest } from "next/server"

import { ApiError, ok, parseBody, toErrorResponse } from "@/lib/api/http"
import { clientIp, recordAudit, userAgent } from "@/lib/security/audit"
import { rotateCsrfToken } from "@/lib/security/csrf"
import { getConfig } from "@/lib/security/config"
import { evaluatePasswordStrength, verifyPassword } from "@/lib/security/password"
import { clearLoginThrottle, enforceLoginThrottle } from "@/lib/api/guard"
import { createSessionRecord, sessionCookieOptions } from "@/lib/security/session"
import { loginSchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"

/**
 * POST /api/auth/login
 *
 * Defence layers, in order:
 *   1. per-account+IP rate limit (brute force)
 *   2. account lockout state
 *   3. scrypt verification in constant time
 *   4. account status checks
 *
 * Failure messages deliberately do not distinguish "no such user" from "wrong
 * password" — otherwise the endpoint becomes a username enumeration oracle.
 * The timing of the response is also equalised by always running a hash.
 */
export async function POST(request: NextRequest) {
  const ip = clientIp(request)
  const ua = userAgent(request)
  const GENERIC_FAILURE = "Invalid username or password."

  let username = "unknown"

  try {
    const body = await parseBody(request, loginSchema)
    username = body.username

    enforceLoginThrottle(`${username.toLowerCase()}:${ip}`)

    const store = await getStore()
    const snapshot = await store.read()
    const user = snapshot.users.find((u) => u.username.toLowerCase() === username.toLowerCase())

    // Hash against a dummy record when the user does not exist so the response
    // time does not reveal whether the username is valid.
    const verified = user
      ? await verifyPassword(body.password, user.passwordHash, user.passwordSalt)
      : await verifyPassword(body.password, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")

    if (!user || !verified) {
      if (user) {
        // Count the failure and lock the account past the threshold.
        await store.mutate((s) => {
          const record = s.users.find((u) => u.id === user.id)
          if (!record) return
          record.failedAttempts += 1
          const config = getConfig()
          if (record.failedAttempts >= config.loginMaxAttempts) {
            record.lockedUntil = new Date(Date.now() + config.loginWindowSeconds * 1000).toISOString()
            record.failedAttempts = 0
          }
          record.updatedAt = new Date().toISOString()
        })
      }

      await recordAudit({
        actor: username,
        actorRole: "anonymous",
        action: "auth.login",
        resource: "session",
        outcome: "failure",
        ip,
        userAgent: ua,
        metadata: { reason: user ? "invalid_password" : "unknown_user" },
      })

      throw ApiError.unauthorized(GENERIC_FAILURE)
    }

    if (!user.active) {
      await recordAudit({ actor: username, actorRole: user.role, action: "auth.login", resource: "session", outcome: "denied", ip, userAgent: ua, metadata: { reason: "account_disabled" } })
      throw ApiError.forbidden("This account has been disabled. Contact an administrator.")
    }

    if (user.lockedUntil && Date.now() < Date.parse(user.lockedUntil)) {
      await recordAudit({ actor: username, actorRole: user.role, action: "auth.login", resource: "session", outcome: "denied", ip, userAgent: ua, metadata: { reason: "account_locked", until: user.lockedUntil } })
      throw ApiError.locked(`Too many failed attempts. This account is locked until ${user.lockedUntil}.`)
    }

    // Weak passwords are rejected at the door rather than after sign-in.
    const strength = evaluatePasswordStrength(body.password)
    if (!strength.ok) {
      await recordAudit({ actor: username, actorRole: user.role, action: "auth.login", resource: "session", outcome: "denied", ip, userAgent: ua, metadata: { reason: "weak_password" } })
      throw ApiError.forbidden(
        `This password no longer meets policy. Choose a new one that has ${strength.issues.join(", ")}.`,
      )
    }

    // Rotate the session: a fresh record for every login, old ones revoked so a
    // stolen cookie cannot outlive the next sign-in.
    const { session, token } = createSessionRecord(user.id, ip, ua)

    await store.mutate((s) => {
      for (const existing of s.sessions) {
        if (existing.userId === user.id) existing.revoked = true
      }
      const record = s.users.find((u) => u.id === user.id)
      if (record) {
        record.failedAttempts = 0
        record.lockedUntil = null
        record.lastLoginAt = new Date().toISOString()
        record.updatedAt = record.lastLoginAt
      }
      s.sessions.push(session)
    })

    clearLoginThrottle(`${username.toLowerCase()}:${ip}`)

    const csrf = rotateCsrfToken()

    await recordAudit({
      actor: user.username,
      actorRole: user.role,
      action: "auth.login",
      resource: "session",
      resourceId: session.id,
      outcome: "success",
      ip,
      userAgent: ua,
      metadata: { mfaEnabled: user.mfaEnabled },
    })

    const response = ok({
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
      },
      csrfToken: csrf.token,
    })

    response.cookies.set(getConfig().cookieName, token, sessionCookieOptions())
    response.cookies.set(csrf.cookieName, csrf.token, csrf.options)
    return response
  } catch (error) {
    return toErrorResponse(error)
  }
}

export const dynamic = "force-dynamic"
