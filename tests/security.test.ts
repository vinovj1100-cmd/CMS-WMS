import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { evaluatePasswordStrength, generateToken, hashPassword, verifyPassword } from "@/lib/security/password"
import { verifyCsrf, requiresCsrf } from "@/lib/security/csrf"
import { RateLimiter, __resetRateLimiters } from "@/lib/security/rate-limit"
import { hasAllPermissions, hasAnyPermission, hasPermission, isRole, permissionsFor } from "@/lib/security/rbac"
import { getConfig, INSECURE_DEV_SECRET, inspectConfig } from "@/lib/security/config"
import type { AppConfig } from "@/lib/security/config"
import { DEMO_USERS } from "@/lib/wms/store/seed-data"
import { makeSnapshot } from "./helpers"

/**
 * Security primitives.
 *
 * These are the parts of the system that fail silently in the worst way, so
 * they get the most explicit coverage: password hashing, CSRF validation,
 * rate limiting, the permission matrix, and the boot-time config gate.
 */

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "production",
    isProduction: true,
    siteUrl: "https://wms.example.com",
    sessionSecret: "a-genuinely-long-production-secret-value",
    sessionTtlSeconds: 60 * 60 * 8,
    cookieName: "wms_session",
    csrfCookieName: "wms_csrf",
    csrfHeaderName: "x-wms-csrf",
    loginMaxAttempts: 5,
    loginWindowSeconds: 900,
    scryptN: 4096,
    storageDriver: "memory",
    dataDir: ".wms-data",
    seedDemoData: false,
    auditLogEnabled: true,
    requireSecureCookies: true,
    ...overrides,
  }
}

describe("password hashing", () => {
  it("round-trips a valid password", async () => {
    const { hash, salt } = await hashPassword("Correct-Horse-99")
    await expect(verifyPassword("Correct-Horse-99", hash, salt)).resolves.toBe(true)
  })

  it("rejects a wrong password", async () => {
    const { hash, salt } = await hashPassword("Correct-Horse-99")
    await expect(verifyPassword("Correct-Horse-98", hash, salt)).resolves.toBe(false)
  })

  it("produces a different salt and hash for the same password", async () => {
    const a = await hashPassword("Same-Password-123")
    const b = await hashPassword("Same-Password-123")

    expect(a.salt).not.toBe(b.salt)
    expect(a.hash).not.toBe(b.hash)

    // Both must still verify against the original.
    await expect(verifyPassword("Same-Password-123", a.hash, a.salt)).resolves.toBe(true)
    await expect(verifyPassword("Same-Password-123", b.hash, b.salt)).resolves.toBe(true)
  })

  it("rejects garbage stored values instead of throwing", async () => {
    await expect(verifyPassword("anything", "not-base64-!!!", "")).resolves.toBe(false)
    await expect(verifyPassword("anything", "", "")).resolves.toBe(false)
  })

  it("does not let a prefix of the password verify", async () => {
    const { hash, salt } = await hashPassword("Correct-Horse-99")
    await expect(verifyPassword("Correct-Horse-9", hash, salt)).resolves.toBe(false)
    await expect(verifyPassword("Correct-Horse-990", hash, salt)).resolves.toBe(false)
  })

  it("treats Unicode-equivalent forms of a password as the same password", async () => {
    // NFKC normalisation means a full-width variant hashes identically, which
    // stops a user being locked out by an input method.
    const { hash, salt } = await hashPassword("P\u00e4ssword-One-2026")
    await expect(verifyPassword("Pa\u0308ssword-One-2026", hash, salt)).resolves.toBe(true)
  })
})

describe("password policy", () => {
  it("rejects anything under 12 characters", () => {
    const result = evaluatePasswordStrength("Ab1!")
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.includes("12 characters"))).toBe(true)
  })

  it("requires three of four character classes", () => {
    expect(evaluatePasswordStrength("alllowercaseonly").ok).toBe(false)
    expect(evaluatePasswordStrength("ALLUPPERCASEONLY").ok).toBe(false)
    expect(evaluatePasswordStrength("LowerAndUpper12").ok).toBe(true)
  })

  it("rejects common weak passwords regardless of length", () => {
    for (const weak of ["passwordpassword", "123456789012", "qwertyqwertyqwerty"]) {
      expect(evaluatePasswordStrength(weak).ok).toBe(false)
    }
  })

  it("accepts the seeded demo credentials", () => {
    for (const demo of DEMO_USERS) {
      expect(evaluatePasswordStrength(demo.password).ok).toBe(true)
    }
  })

  it("verifies the seeded demo credentials against their stored hashes", async () => {
    const snapshot = await makeSnapshot()
    for (const demo of DEMO_USERS) {
      const user = snapshot.users.find((u) => u.username === demo.username)
      expect(user, `seeded user ${demo.username} missing`).toBeDefined()
      await expect(verifyPassword(demo.password, user!.passwordHash, user!.passwordSalt)).resolves.toBe(true)
    }
  })
})

describe("CSRF", () => {
  it("requires a token only on state-changing methods", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(requiresCsrf(method)).toBe(true)
    }
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(requiresCsrf(method)).toBe(false)
    }
  })

  it("accepts a matching header and cookie", () => {
    const request = new Request("https://wms.example.com/api/wms/inventory", {
      method: "POST",
      headers: { cookie: "wms_csrf=tok-123", "x-wms-csrf": "tok-123" },
    })
    expect(verifyCsrf(request)).toEqual({ ok: true })
  })

  it("rejects a mismatched token", () => {
    const request = new Request("https://wms.example.com/api/wms/inventory", {
      method: "POST",
      headers: { cookie: "wms_csrf=tok-123", "x-wms-csrf": "tok-456" },
    })
    const result = verifyCsrf(request)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/mismatch/i)
  })

  it("rejects a cross-origin request with no token", () => {
    const request = new Request("https://wms.example.com/api/wms/inventory", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    })
    const result = verifyCsrf(request)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/cross-origin/i)
  })

  it("accepts a same-origin request with no token", () => {
    // verifyCsrf compares against the configured siteUrl, so derive the origin
    // from the live config rather than hardcoding one.
    const origin = new URL(getConfig().siteUrl).origin

    const request = new Request(`${origin}/api/wms/inventory`, {
      method: "POST",
      headers: { origin },
    })
    expect(verifyCsrf(request).ok).toBe(true)
  })

  it("rejects a malformed Origin header rather than failing open", () => {
    const request = new Request("https://wms.example.com/api/wms/inventory", {
      method: "POST",
      headers: { origin: "ht!tp://::::" },
    })
    expect(verifyCsrf(request).ok).toBe(false)
  })
})

describe("rate limiter", () => {
  beforeEach(() => __resetRateLimiters())
  afterEach(() => __resetRateLimiters())

  it("allows up to the limit and then blocks", () => {
    const limiter = new RateLimiter({ limit: 5, windowMs: 60_000 })

    for (let i = 0; i < 5; i++) {
      expect(limiter.consume("user-1").allowed).toBe(true)
    }
    const sixth = limiter.consume("user-1")
    expect(sixth.allowed).toBe(false)
    expect(sixth.retryAfterMs).toBeGreaterThan(0)
  })

  it("counts each key independently", () => {
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000 })

    limiter.consume("user-1")
    limiter.consume("user-1")
    expect(limiter.consume("user-1").allowed).toBe(false)

    // A different user is unaffected by the first user's attempts.
    expect(limiter.consume("user-2").allowed).toBe(true)
  })

  it("reports a decreasing remaining count", () => {
    const limiter = new RateLimiter({ limit: 10, windowMs: 60_000 })

    expect(limiter.consume("k").remaining).toBe(9)
    expect(limiter.consume("k").remaining).toBe(8)
  })

  it("forgets a key on reset, as after a successful login", () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000 })

    limiter.consume("user-1")
    limiter.consume("user-1")
    limiter.consume("user-1")
    expect(limiter.consume("user-1").allowed).toBe(false)

    limiter.reset("user-1")
    expect(limiter.consume("user-1").allowed).toBe(true)
  })

  it("refills tokens as the window elapses", async () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 50 })

    expect(limiter.consume("k").allowed).toBe(true)
    expect(limiter.consume("k").allowed).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(limiter.consume("k").allowed).toBe(true)
  })
})

describe("RBAC", () => {
  it("grants admins everything an operator can do", () => {
    const operator = permissionsFor("operator")
    const admin = permissionsFor("admin")

    for (const permission of operator) {
      expect(admin).toContain(permission)
    }
    expect(admin.length).toBeGreaterThan(operator.length)
  })

  it("denies a viewer every mutating capability", () => {
    const viewer = permissionsFor("viewer")

    for (const denied of [
      "inventory:adjust",
      "inbound:receive",
      "outbound:ship",
      "cyclecount:approve",
      "returns:approve",
      "user:manage",
    ] as const) {
      expect(viewer).not.toContain(denied)
    }
  })

  it("separates counting from approving a cycle count", () => {
    expect(hasPermission("operator", "cyclecount:count")).toBe(true)
    expect(hasPermission("operator", "cyclecount:approve")).toBe(false)
    expect(hasPermission("supervisor", "cyclecount:approve")).toBe(true)
  })

  it("supports all/any matching", () => {
    expect(hasAllPermissions("admin", ["user:manage", "audit:read"])).toBe(true)
    expect(hasAllPermissions("operator", ["user:manage", "audit:read"])).toBe(false)
    expect(hasAnyPermission("operator", ["user:manage", "inventory:read"])).toBe(true)
    expect(hasAnyPermission("operator", ["user:manage", "audit:read"])).toBe(false)
  })

  it("validates role strings", () => {
    expect(isRole("admin")).toBe(true)
    expect(isRole("superuser")).toBe(false)
    expect(isRole(undefined)).toBe(false)
    expect(isRole("")).toBe(false)
  })

  it("gives every seeded user a role that exists in the matrix", async () => {
    const snapshot = await makeSnapshot()
    for (const user of snapshot.users) {
      expect(isRole(user.role)).toBe(true)
      expect(permissionsFor(user.role).length).toBeGreaterThan(0)
    }
  })
})

describe("config validation", () => {
  it("passes a correct production config", () => {
    expect(inspectConfig(baseConfig())).toEqual([])
  })

  it("fails on a short session secret", () => {
    const violations = inspectConfig(baseConfig({ sessionSecret: "short" }))
    expect(violations.some((v) => v.severity === "fatal" && v.message.includes("32 characters"))).toBe(true)
  })

  it("fails on the built-in development secret in production", () => {
    const violations = inspectConfig(baseConfig({ sessionSecret: INSECURE_DEV_SECRET }))

    const devSecret = violations.filter((v) => v.message.includes("development session secret"))
    expect(devSecret).toHaveLength(1)
    expect(devSecret[0]?.severity).toBe("fatal")
  })

  it("warns about seeding demo data in production but does not block boot", () => {
    const violations = inspectConfig(baseConfig({ seedDemoData: true }))
    const demo = violations.filter((v) => v.message.includes("SEED_DEMO_DATA"))

    expect(demo).toHaveLength(1)
    expect(demo[0]?.severity).toBe("warn")
  })

  it("warns when cookies are not marked Secure", () => {
    const violations = inspectConfig(baseConfig({ requireSecureCookies: false }))
    expect(violations.some((v) => v.message.includes("Secure"))).toBe(true)
  })
})

describe("token generation", () => {
  it("produces unique, sufficiently long tokens", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken()))
    expect(tokens.size).toBe(200)

    for (const token of tokens) {
      expect(token.length).toBeGreaterThanOrEqual(40)
    }
  })
})
