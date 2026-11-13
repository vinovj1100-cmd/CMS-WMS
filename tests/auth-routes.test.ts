import { NextRequest } from "next/server"
import { describe, expect, it } from "vitest"

import { POST as login } from "@/app/api/auth/login/route"
import { POST as logout } from "@/app/api/auth/logout/route"

describe("authentication route CSRF protection", () => {
  it.each([
    ["login", login],
    ["logout", logout],
  ] as const)("rejects a cross-origin %s without a token", async (name, handler) => {
    const request = new NextRequest(`http://localhost:3000/api/auth/${name}`, {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ username: "viewer", password: "irrelevant" }),
    })
    const response = await handler(request)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: "CSRF_FAILED" } })
  })
})
