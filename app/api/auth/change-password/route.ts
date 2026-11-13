import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ApiError, ok, parseBody } from "@/lib/api/http"
import { recordAudit } from "@/lib/security/audit"
import { evaluatePasswordStrength, hashPassword, verifyPassword } from "@/lib/security/password"
import { changePasswordSchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"

/**
 * POST /api/auth/change-password
 *
 * Changing a password revokes every *other* session. That is the behaviour a
 * user expects when they change a password because they think it leaked.
 */
export const POST = withAuth(
  { auditAction: "auth.change_password", auditResource: "user" },
  async (request: NextRequest, auth) => {
    const body = await parseBody(request, changePasswordSchema)

    const valid = await verifyPassword(body.currentPassword, auth.user.passwordHash, auth.user.passwordSalt)
    if (!valid) {
      await recordAudit({
        actor: auth.user.username,
        actorRole: auth.user.role,
        action: "auth.change_password",
        resource: "user",
        resourceId: auth.user.id,
        outcome: "failure",
        ip: auth.ip,
        userAgent: auth.userAgent,
        metadata: { reason: "current_password_incorrect" },
      })
      throw ApiError.unauthorized("Your current password is incorrect.")
    }

    if (body.newPassword === body.currentPassword) {
      throw ApiError.badRequest("The new password must differ from the current one.")
    }

    const strength = evaluatePasswordStrength(body.newPassword)
    if (!strength.ok) {
      throw ApiError.badRequest(`New password does not meet policy: ${strength.issues.join("; ")}.`, {
        issues: strength.issues,
      })
    }

    const { hash, salt } = await hashPassword(body.newPassword)
    const store = await getStore()
    const currentSessionId = auth.session.id

    await store.mutate((snapshot) => {
      const user = snapshot.users.find((u) => u.id === auth.user.id)
      if (!user) throw ApiError.notFound("Account no longer exists.")

      user.passwordHash = hash
      user.passwordSalt = salt
      user.mustChangePassword = false
      user.updatedAt = new Date().toISOString()

      // Keep the active session alive; drop every other one.
      for (const session of snapshot.sessions) {
        if (session.userId === user.id && session.id !== currentSessionId) session.revoked = true
      }
    })

    return ok({ ok: true, otherSessionsRevoked: true })
  },
)

export const dynamic = "force-dynamic"
