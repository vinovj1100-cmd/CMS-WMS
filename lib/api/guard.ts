import type { NextRequest } from "next/server"

import { ApiError, toErrorResponse } from "./http"
import { getConfig } from "@/lib/security/config"
import { verifySessionToken } from "@/lib/security/session"
import { verifyCsrf, requiresCsrf } from "@/lib/security/csrf"
import { apiLimiter, loginLimiter } from "@/lib/security/rate-limit"
import { clientIp, recordAudit, userAgent } from "@/lib/security/audit"
import { hasPermission, type Permission } from "@/lib/security/rbac"
import { getStore } from "@/lib/wms/store"
import type { Role, Session, User } from "@/lib/wms/types"

/**
 * The single choke point for every mutating API route.
 *
 * Order matters and is deliberate:
 *   1. rate limit  — cheapest check first, sheds floods before parsing
 *   2. CSRF        — before touching the session store
 *   3. session     — cookie signature + expiry, then the server-side record
 *   4. authorisation — the specific capability this route needs
 *   5. handler
 *   6. audit       — success and failure both recorded
 *
 * Doing it in one wrapper is the point: a new route cannot forget a step.
 */

export interface AuthContext {
  user: User
  session: Session
  permissions: Permission[]
  ip: string
  userAgent: string
}

export interface RouteOptions {
  /** Capability required. Omit for public routes (login, health). */
  permission?: Permission
  /** Skip the session check entirely. Use only for login/health. */
  public?: boolean
  /** Skip CSRF for this route (e.g. machine-to-machine webhook with its own auth). */
  skipCsrf?: boolean
  /** Human-readable action name written to the audit log. */
  auditAction?: string
  /** Resource name written to the audit log. */
  auditResource?: string
}

type Handler<Ctx> = (request: NextRequest, ctx: Ctx) => Promise<Response> | Response

interface NextRouteContext {
  params: Record<string, string>
}

export function withAuth(
  options: RouteOptions,
  handler: (request: NextRequest, auth: AuthContext, ctx: NextRouteContext) => Promise<Response> | Response,
): Handler<NextRouteContext> {
  return async (request, routeContext) => {
    const config = getConfig()
    const ip = clientIp(request)
    const ua = userAgent(request)

    try {
      // 1. Throughput throttle, keyed by IP.
      const throttle = apiLimiter().consume(`ip:${ip}`)
      if (!throttle.allowed) {
        throw new ApiError("RATE_LIMITED", "Too many requests. Please slow down.", {
          retryAfterMs: throttle.retryAfterMs,
          limit: throttle.limit,
        })
      }

      // 2. CSRF for state-changing methods. Applied to public routes too —
      //    login CSRF is a real attack (an attacker pins their own session to
      //    the victim's browser), so the login page fetches a token first.
      if (!options.skipCsrf && requiresCsrf(request.method)) {
        const csrf = verifyCsrf(request)
        if (!csrf.ok) {
          await recordAudit({
            actor: "anonymous",
            actorRole: "anonymous",
            action: options.auditAction ?? `${request.method} ${new URL(request.url).pathname}`,
            resource: options.auditResource ?? "csrf",
            outcome: "denied",
            ip,
            userAgent: ua,
            metadata: { reason: csrf.reason },
          })
          throw new ApiError("CSRF_FAILED", csrf.reason ?? "CSRF validation failed.")
        }
      }

      // 3. Session.
      if (options.public) {
        return await runHandler(handler, request, routeContext, null, ip, ua, options)
      }

      const cookieToken = request.cookies.get(config.cookieName)?.value
      const verified = verifySessionToken(cookieToken)
      if (!verified.ok || !verified.payload) {
        throw ApiError.unauthorized(
          verified.reason === "expired" ? "Your session has expired. Please sign in again." : undefined,
        )
      }

      const store = await getStore()
      const snapshot = await store.read()

      const session = snapshot.sessions.find((s) => s.id === verified.payload?.sessionId)
      if (!session || session.revoked) {
        throw ApiError.unauthorized("Session is no longer valid. Please sign in again.")
      }
      if (Date.now() > Date.parse(session.expiresAt)) {
        throw ApiError.unauthorized("Your session has expired. Please sign in again.")
      }

      const user = snapshot.users.find((u) => u.id === session.userId)
      if (!user || !user.active) {
        throw ApiError.unauthorized("This account is disabled.")
      }
      if (user.lockedUntil && Date.now() < Date.parse(user.lockedUntil)) {
        throw ApiError.locked(
          `This account is temporarily locked after repeated failed sign-in attempts. Try again after ${user.lockedUntil}.`,
        )
      }

      // 4. Authorisation.
      const { permissionsFor } = await import("@/lib/security/rbac")
      const auth: AuthContext = {
        user,
        session,
        permissions: permissionsFor(user.role),
        ip,
        userAgent: ua,
      }

      if (options.permission && !hasPermission(user.role, options.permission)) {
        await recordAudit({
          actor: user.username,
          actorRole: user.role,
          action: options.auditAction ?? `${request.method} ${new URL(request.url).pathname}`,
          resource: options.auditResource ?? "api",
          outcome: "denied",
          ip,
          userAgent: ua,
          metadata: { requiredPermission: options.permission, hasRole: user.role },
        })
        throw ApiError.forbidden(`This action requires the "${options.permission}" permission.`)
      }

      return await runHandler(handler, request, routeContext, auth, ip, ua, options)
    } catch (error) {
      return toErrorResponse(error)
    }
  }
}

async function runHandler(
  handler: (request: NextRequest, auth: AuthContext, ctx: NextRouteContext) => Promise<Response> | Response,
  request: NextRequest,
  routeContext: NextRouteContext,
  auth: AuthContext | null,
  ip: string,
  ua: string,
  options: RouteOptions,
): Promise<Response> {
  if (!auth) return handler(request, undefined as unknown as AuthContext, routeContext)

  const response = await handler(request, auth, routeContext)

  // 6. Audit every authenticated call that changed something.
  if (requiresCsrf(request.method)) {
    await recordAudit({
      actor: auth.user.username,
      actorRole: auth.user.role,
      action: options.auditAction ?? `${request.method} ${new URL(request.url).pathname}`,
      resource: options.auditResource ?? "api",
      outcome: response.ok ? "success" : "failure",
      ip,
      userAgent: ua,
      metadata: { status: response.status, permission: options.permission ?? null },
    })
  }

  return response
}

/** Brute-force guard for the login route specifically. */
export function enforceLoginThrottle(key: string): void {
  const config = getConfig()
  const limiter = loginLimiter(config.loginMaxAttempts, config.loginWindowSeconds * 1000)
  const result = limiter.consume(key)
  if (!result.allowed) {
    throw new ApiError("RATE_LIMITED", "Too many sign-in attempts. Please wait before trying again.", {
      retryAfterMs: result.retryAfterMs,
    })
  }
}

export function clearLoginThrottle(key: string): void {
  const config = getConfig()
  loginLimiter(config.loginMaxAttempts, config.loginWindowSeconds * 1000).reset(key)
}

export function roleOf(user: User): Role {
  return user.role
}
