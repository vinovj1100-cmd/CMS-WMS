import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ApiError, ok, parseBody } from "@/lib/api/http"
import { evaluatePasswordStrength, generateId, hashPassword } from "@/lib/security/password"
import { ROLE_LABELS, permissionsFor } from "@/lib/security/rbac"
import { createUserSchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"
import type { User } from "@/lib/wms/types"

/**
 * GET  /api/wms/admin/users — user directory (no hashes, ever).
 * POST /api/wms/admin/users — create a user.
 *
 * New accounts always start with `mustChangePassword: true`, so the seeded or
 * admin-issued password is never the one an operator keeps using.
 */
export const GET = withAuth({ permission: "user:read" }, async () => {
  const store = await getStore()
  const snapshot = await store.read()

  return ok({
    users: snapshot.users
      .slice()
      .sort((a, b) => a.username.localeCompare(b.username))
      .map((user) => ({
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        role: user.role,
        roleLabel: ROLE_LABELS[user.role],
        permissionCount: permissionsFor(user.role).length,
        active: user.active,
        mfaEnabled: user.mfaEnabled,
        mustChangePassword: user.mustChangePassword,
        failedAttempts: user.failedAttempts,
        lockedUntil: user.lockedUntil,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      })),
  })
})

export const POST = withAuth(
  { permission: "user:manage", auditAction: "admin.user.create", auditResource: "user" },
  async (request: NextRequest) => {
    const body = await parseBody(request, createUserSchema)
    const store = await getStore()

    const strength = evaluatePasswordStrength(body.password)
    if (!strength.ok) {
      throw ApiError.badRequest(`Password does not meet policy: ${strength.issues.join("; ")}.`, { issues: strength.issues })
    }

    const { hash, salt } = await hashPassword(body.password)

    const created = await store.mutate((snapshot) => {
      const usernameTaken = snapshot.users.some((u) => u.username.toLowerCase() === body.username.toLowerCase())
      if (usernameTaken) throw ApiError.conflict(`Username "${body.username}" is already taken.`)

      const emailTaken = snapshot.users.some((u) => u.email.toLowerCase() === body.email.toLowerCase())
      if (emailTaken) throw ApiError.conflict(`Email "${body.email}" is already registered.`)

      const now = new Date().toISOString()
      const user: User = {
        id: generateId("usr"),
        username: body.username,
        email: body.email,
        name: body.name,
        role: body.role,
        passwordHash: hash,
        passwordSalt: salt,
        mustChangePassword: true,
        failedAttempts: 0,
        lockedUntil: null,
        lastLoginAt: null,
        mfaEnabled: false,
        active: true,
        createdAt: now,
        updatedAt: now,
      }

      snapshot.users.push(user)
      return user
    })

    return ok(
      {
        ok: true,
        user: {
          id: created.id,
          username: created.username,
          name: created.name,
          email: created.email,
          role: created.role,
          mustChangePassword: created.mustChangePassword,
        },
      },
      { status: 201 },
    )
  },
)

export const dynamic = "force-dynamic"
