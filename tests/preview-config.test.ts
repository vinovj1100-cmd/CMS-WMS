import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"

/** Load next.config.mjs in a fresh process so each case gets its own env. */
function securityHeaders(overrides: Record<string, string>): Record<string, string> {
  const env = { ...process.env, ...overrides }
  const script = `
    const { default: config } = await import('./next.config.mjs');
    const rules = await config.headers();
    console.log(JSON.stringify(Object.fromEntries(rules[0].headers.map(({key, value}) => [key, value]))));
  `
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  })
  return JSON.parse(output) as Record<string, string>
}

describe("development preview security headers", () => {
  it("enables the Next 14 startup instrumentation hook", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", "const {default: config} = await import('./next.config.mjs'); console.log(config.experimental?.instrumentationHook)"], {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
    })
    expect(output.trim()).toBe("true")
  })

  it("allows Next.js development HMR without enabling framing by default", () => {
    const headers = securityHeaders({ NODE_ENV: "development", WMS_PREVIEW_EMBED: "false", CSP_ENFORCE: "true" })
    expect(headers["Content-Security-Policy"]).toContain("'unsafe-eval'")
    expect(headers["Content-Security-Policy"]).toContain("connect-src 'self' ws: wss:")
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'")
    expect(headers["X-Frame-Options"]).toBe("DENY")
  })

  it("allows framing only when the development preview explicitly opts in", () => {
    const headers = securityHeaders({ NODE_ENV: "development", WMS_PREVIEW_EMBED: "true", CSP_ENFORCE: "true" })
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors *")
    expect(headers["X-Frame-Options"]).toBeUndefined()
  })

  it("keeps production protected even if the preview flag is set", () => {
    const headers = securityHeaders({ NODE_ENV: "production", WMS_PREVIEW_EMBED: "true", CSP_ENFORCE: "true" })
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'")
    expect(headers["Content-Security-Policy"]).not.toContain("'unsafe-eval'")
    expect(headers["Content-Security-Policy"]).toContain("connect-src 'self';")
    expect(headers["X-Frame-Options"]).toBe("DENY")
  })

  it("honours the report-only setting instead of silently enforcing the policy", () => {
    const headers = securityHeaders({ NODE_ENV: "production", WMS_PREVIEW_EMBED: "false", CSP_ENFORCE: "false" })
    expect(headers["Content-Security-Policy"]).toBeUndefined()
    expect(headers["Content-Security-Policy-Report-Only"]).toContain("frame-ancestors 'none'")
    expect(headers["X-Frame-Options"]).toBe("DENY")
  })
})
