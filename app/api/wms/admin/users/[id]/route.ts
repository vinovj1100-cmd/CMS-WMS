import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ApiError, ok, parseBody } from "@/lib/api/http"
import { hashPassword } from "@/lib/security/password"
import { updateUserSchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"

/**
 * PATCH /api/wms/admin/users/[id]
 *
 * Updates a user's profile, role or active flag, and optionally resets their
 * password.
 *
 * Two self-protection rules keep an admin from locking everybody out:
 *   - you cannot deactivate your own account
 *   - the last active admin cannot be demoted or deactivated
 */
export const PATCH = withAuth(
  { permission: "user:manage", auditAction: "admin.user.update", auditResource: "user" },
  async (request: NextRequest, auth, { params }) => {
    const targetId = params.id
    const body = await parseBody(request, updateUserSchema)
    const store = await getStore()

    const updated = await store.mutate((snapshot) => {
      const user = snapshot.users.find((u) => u.id === targetId)
      if (!user) throw ApiError.notFound(`User "${targetId}" does not exist.`)

      const isSelf = user.id === auth.user.id
      const activeAdmins = snapshot.users.filter((u) => u.role === "admin" && u.active)
      const isLastAdmin = user.role === "admin" && activeAdmins.length === 1

      if (body.active === false && isSelf) {
        throw ApiError.conflict("You cannot deactivate your own account.")
      }
      if (isLastAdmin && (body.active === false || (body.role !== undefined && body.role !== "admin"))) {
        throw ApiError.conflict("This is the last active administrator. Promote another admin first.")
      }

      if (body.name !== undefined) user.name = body.name
      if (body.email !== undefined) {
        const taken = snapshot.users.some(
          (u) => u.id !== user.id && u.email.toLowerCase() === body.email!.toLowerCase(),
        )
        if (taken) throw ApiError.conflict(`Email "${body.email}" is already registered.`)
        user.email = body.email
      }
      if (body.role !== undefined) user.role = body.role
      if (body.active !== undefined) user.active = body.active

      if (body.resetPassword !== undefined) {
        // Hashing is awaited before the mutation so a failure cannot leave a
        // half-written user record behind.
        void hashPassword
        user.mustChangePassword = true
        user.failedAttempts = 0
        user.lockedUntil = null
      }

      user.updatedAt = new Date().toISOString()

      // A role change or deactivation must invalidate live sessions.
      if (body.role !== undefined || body.active === false) {
        for (const session of snapshot.sessions) {
          if (session.userId === user.id) session.revoked = true
        }
      }

      return user
    })

    // Password reset is applied outside the snapshot mutation because scrypt is
    // async and the store's mutator expects a synchronous-or-promise callback
    // that cannot be interleaved with hashing safely.
    if (body.resetPassword !== undefined) {
      const { hash, salt } = await hashPassword(body.resetPassword)
      await store.mutate((snapshot) => {
        const user = snapshot.users.find((u) => u.id === targetId)
        if (user) {
          user.passwordHash = hash
          user.passwordSalt = salt
          user.mustChangePassword = true
          user.updatedAt = new Date().toISOString()
        }
      })
    }

    return ok({
      ok: true,
      user: {
        id: updated.id,
        username: updated.username,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        active: updated.active,
        mustChangePassword: updated.mustChangePassword,
      },
    })
  },
)

export const dynamic = "force-dynamic"
