import type { NextRequest } from "next/server"

import { ok, toErrorResponse } from "@/lib/api/http"
import { recordAudit } from "@/lib/security/audit"
import { getConfig } from "@/lib/security/config"
import { rotateCsrfToken } from "@/lib/security/csrf"
import { readSessionFromCookies } from "@/lib/security/session"
import { getStore } from "@/lib/wms/store"

/**
 * POST /api/auth/logout
 *
 * Revokes the session server-side rather than only clearing the cookie — a
 * cookie that has already leaked stays useless.
 */
export async function POST(request: NextRequest) {
  try {
    const payload = readSessionFromCookies()

    if (payload) {
      const store = await getStore()
      await store.mutate((snapshot) => {
        const session = snapshot.sessions.find((s) => s.id === payload.sessionId)
        if (session) session.revoked = true
        const user = snapshot.users.find((u) => u.id === payload.userId)
        if (user) {
          void recordAudit({
            actor: user.username,
            actorRole: user.role,
            action: "auth.logout",
            resource: "session",
            resourceId: payload.sessionId,
            outcome: "success",
            ip: request.headers.get("x-forwarded-for") ?? "unknown",
            userAgent: request.headers.get("user-agent") ?? "unknown",
          })
        }
      })
    }

    const config = getConfig()
    const csrf = rotateCsrfToken()

    const response = ok({ ok: true })
    // Expire the session cookie immediately.
    response.cookies.set(config.cookieName, "", { ...({}), path: "/", maxAge: 0 })
    // Rotate CSRF so the old token cannot be replayed after sign-out.
    response.cookies.set(csrf.cookieName, csrf.token, csrf.options)
    return response
  } catch (error) {
    return toErrorResponse(error)
  }
}

export const dynamic = "force-dynamic"
