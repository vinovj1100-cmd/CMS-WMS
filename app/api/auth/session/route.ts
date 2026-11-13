import type { NextRequest } from "next/server"

import { ok, toErrorResponse } from "@/lib/api/http"
import { clientIp, userAgent } from "@/lib/security/audit"
import { rotateCsrfToken } from "@/lib/security/csrf"
import { getConfig } from "@/lib/security/config"
import { partitionPreviewCookies } from "@/lib/security/preview-cookies"
import { permissionsFor, ROLE_LABELS } from "@/lib/security/rbac"
import { verifySessionToken } from "@/lib/security/session"
import { getStore } from "@/lib/wms/store"

/**
 * GET /api/auth/session
 *
 * Two jobs:
 *   1. Tell the client who is signed in and what they may do.
 *   2. Hand out a CSRF token so state-changing calls — including the login
 *      form itself — can be validated.
 *
 * Public by design: an anonymous caller still needs the CSRF cookie before it
 * can post credentials.
 */
export async function GET(request: NextRequest) {
  try {
    const config = getConfig()
    const csrf = rotateCsrfToken()
    const cookieToken = request.cookies.get(config.cookieName)?.value
    const verified = verifySessionToken(cookieToken)

    let user: Record<string, unknown> | null = null

    if (verified.ok && verified.payload) {
      const store = await getStore()
      const snapshot = await store.read()

      const session = snapshot.sessions.find((s) => s.id === verified.payload?.sessionId)
      const record = snapshot.users.find((u) => u.id === session?.userId)

      if (session && record && record.active && !session.revoked && Date.now() <= Date.parse(session.expiresAt)) {
        user = {
          id: record.id,
          username: record.username,
          name: record.name,
          email: record.email,
          role: record.role,
          roleLabel: ROLE_LABELS[record.role],
          permissions: permissionsFor(record.role),
          mfaEnabled: record.mfaEnabled,
          mustChangePassword: record.mustChangePassword,
          lastLoginAt: record.lastLoginAt,
          warehouses: snapshot.warehouses
            .filter((w) => w.active)
            .map((w) => ({ id: w.id, code: w.code, name: w.name })),
        }
      }
    }

    const response = ok({ authenticated: user !== null, user, csrfToken: csrf.token })
    response.cookies.set(csrf.cookieName, csrf.token, csrf.options)
    return partitionPreviewCookies(response)
  } catch (error) {
    return toErrorResponse(error)
  }
}

export const dynamic = "force-dynamic"
