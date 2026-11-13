import { NextResponse, type NextRequest } from "next/server"

/**
 * Edge middleware.
 *
 * Two jobs, both cheap enough to run on every request:
 *   1. Redirect unauthenticated users away from app pages to /auth/login.
 *   2. Keep authenticated users out of the login screens.
 *
 * This is a *navigation* guard only — it checks that a session cookie exists and
 * looks well-formed. The real authorisation (signature verification, revocation,
 * expiry, per-route capability) happens in `lib/api/guard.ts` on the Node
 * runtime, because the edge cannot reach the session store.
 *
 * Trusting the cookie here would be a vulnerability; treating it as a hint is
 * fine because every API call re-verifies it.
 */

/** App routes that require a session. */
const PROTECTED_PREFIXES = ["/wms", "/dashboard", "/dashboard-cms", "/dashboard-saas", "/settings", "/plugins"]

/** Routes that only make sense when signed out. */
const AUTH_ROUTES = ["/auth/login", "/auth/register", "/auth/forgot", "/auth/reset-password"]

const SESSION_COOKIE = "wms_session"

/**
 * Cheap shape check: `payload.signature` with both parts present and base64url
 * characters only. Deliberately does not verify the HMAC — that needs the
 * secret, which must not be shipped to the edge bundle.
 */
function looksLikeValidSession(cookie: string | undefined): boolean {
  if (!cookie) return false
  const separatorIndex = cookie.lastIndexOf(".")
  if (separatorIndex <= 0 || separatorIndex === cookie.length - 1) return false

  const value = cookie.slice(0, separatorIndex)
  const signature = cookie.slice(separatorIndex + 1)
  const base64url = /^[A-Za-z0-9_-]+$/

  return base64url.test(value) && base64url.test(signature) && value.length > 16
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const hasSession = looksLikeValidSession(request.cookies.get(SESSION_COOKIE)?.value)

  const isProtected = PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  const isAuthRoute = AUTH_ROUTES.includes(pathname)

  if (isProtected && !hasSession) {
    const login = new URL("/auth/login", request.url)
    // Preserve where they were headed so login can send them back.
    login.searchParams.set("next", pathname)
    return NextResponse.redirect(login)
  }

  if (isAuthRoute && hasSession && pathname === "/auth/login") {
    return NextResponse.redirect(new URL("/wms", request.url))
  }

  const response = NextResponse.next()

  // Basic hardening that must apply even to static assets.
  response.headers.set("X-Content-Type-Options", "nosniff")
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin")

  return response
}

/**
 * Skip the middleware for static assets and API routes — API auth is handled by
 * the route guard, and running this on every image request is wasted work.
 */
export const config = {
  matcher: [
    /*
     * Match everything except:
     *  - _next/static, _next/image (build output)
     *  - favicon / icon / manifest files
     *  - public media assets
     */
    "/((?!_next/static|_next/image|api/|favicon.ico|icon.svg|icon-light-32x32.png|icon-dark-32x32.png|apple-icon.png|manifest.webmanifest|placeholder.*\\.(?:png|jpg|svg)).*)",
  ],
}
