import { NextResponse } from "next/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import { __resetConfigCache, getConfig } from "@/lib/security/config"
import { csrfCookieOptions } from "@/lib/security/csrf"
import { partitionPreviewCookies } from "@/lib/security/preview-cookies"
import { sessionCookieOptions } from "@/lib/security/session"

function configure(nodeEnv: "development" | "production", preview: boolean) {
  vi.stubEnv("NODE_ENV", nodeEnv)
  vi.stubEnv("WMS_PREVIEW_EMBED", String(preview))
  vi.stubEnv("WMS_SECURE_COOKIES", "false")
  __resetConfigCache()
}

function responseCookies(): string {
  const response = NextResponse.json({ ok: true })
  response.cookies.set("wms_session", "session", sessionCookieOptions())
  response.cookies.set("wms_csrf", "csrf", csrfCookieOptions())
  partitionPreviewCookies(response)
  return response.headers.get("set-cookie") ?? ""
}

afterEach(() => {
  vi.unstubAllEnvs()
  __resetConfigCache()
})

describe("embedded preview cookies", () => {
  it("uses Secure, SameSite=None and Partitioned cookies only for an opted-in development preview", () => {
    configure("development", true)
    expect(getConfig().previewEmbedding).toBe(true)
    expect(sessionCookieOptions()).toMatchObject({ httpOnly: true, secure: true, sameSite: "none" })
    expect(csrfCookieOptions()).toMatchObject({ httpOnly: false, secure: true, sameSite: "none" })
    const cookies = responseCookies()
    expect(cookies.match(/Partitioned/g)).toHaveLength(2)
    expect(cookies).toContain("HttpOnly")
    expect(cookies).toContain("SameSite=none")
  })

  it("keeps normal development cookies same-site", () => {
    configure("development", false)
    expect(sessionCookieOptions()).toMatchObject({ secure: false, sameSite: "lax" })
    expect(responseCookies()).not.toContain("Partitioned")
  })

  it("ignores the preview flag in production", () => {
    configure("production", true)
    expect(getConfig().previewEmbedding).toBe(false)
    expect(sessionCookieOptions().sameSite).toBe("lax")
    expect(responseCookies()).not.toContain("Partitioned")
  })
})
