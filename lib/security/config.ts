import { z } from "zod"

/**
 * Central, environment-driven configuration.
 *
 * Every knob is read once and frozen; `assertSecureConfig()` is called at boot
 * (see `instrumentation.ts`) so a production deploy on a debug default fails
 * loudly instead of silently shipping an insecure binary.
 */

const bool = (value: string | undefined, fallback: boolean) => {
  if (value === undefined || value === "") return fallback
  return ["1", "true", "yes", "on"].includes(value.toLowerCase())
}

const int = (value: string | undefined, fallback: number) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production"
  readonly isProduction: boolean
  readonly siteUrl: string
  readonly sessionSecret: string
  readonly sessionTtlSeconds: number
  readonly cookieName: string
  readonly csrfCookieName: string
  readonly csrfHeaderName: string
  readonly loginMaxAttempts: number
  readonly loginWindowSeconds: number
  readonly scryptN: number
  readonly storageDriver: "memory" | "file"
  readonly dataDir: string
  readonly seedDemoData: boolean
  readonly auditLogEnabled: boolean
  readonly previewEmbedding: boolean
  readonly requireSecureCookies: boolean
}

/** Development-only fallback secret. Production boot refuses to use it. */
const DEV_SECRET = "wms-dev-only-secret-do-not-use-in-production-0123456789"
export const INSECURE_DEV_SECRET = DEV_SECRET

function buildConfig(): AppConfig {
  const nodeEnv = (process.env.NODE_ENV ?? "development") as AppConfig["nodeEnv"]
  const isProduction = nodeEnv === "production"
  const sessionSecret = process.env.WMS_SESSION_SECRET?.trim() || DEV_SECRET
  // Third-party preview cookies are opt-in, require HTTPS, and are never
  // enabled in production, even if the flag is accidentally left on.
  const previewEmbedding = nodeEnv === "development" && process.env.WMS_PREVIEW_EMBED === "true"

  return Object.freeze({
    nodeEnv,
    isProduction,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
    sessionSecret,
    sessionTtlSeconds: int(process.env.WMS_SESSION_TTL_SECONDS, 8 * 60 * 60),
    cookieName: "wms_session",
    csrfCookieName: "wms_csrf",
    csrfHeaderName: "x-wms-csrf",
    loginMaxAttempts: int(process.env.WMS_LOGIN_MAX_ATTEMPTS, 5),
    loginWindowSeconds: int(process.env.WMS_LOGIN_WINDOW_SECONDS, 15 * 60),
    scryptN: int(process.env.WMS_SCRYPT_N, 32768),
    storageDriver: (process.env.WMS_STORAGE_DRIVER === "file" ? "file" : "memory") as "memory" | "file",
    dataDir: process.env.WMS_DATA_DIR ?? "./data",
    seedDemoData: bool(process.env.WMS_SEED_DEMO_DATA, !isProduction),
    auditLogEnabled: bool(process.env.WMS_AUDIT_LOG, true),
    previewEmbedding,
    // Secure cookies are required for cross-site, partitioned preview cookies.
    // Normal local dev can use HTTP; production should run behind TLS.
    requireSecureCookies: previewEmbedding || bool(process.env.WMS_SECURE_COOKIES, isProduction),
  })
}

let cached: AppConfig | null = null

export function getConfig(): AppConfig {
  if (!cached) cached = buildConfig()
  return cached
}

/** Test helper: forces the next `getConfig()` to re-read the environment. */
export function __resetConfigCache(): void {
  cached = null
}

const startupSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]),
  sessionTtlSeconds: z.number().int().min(60).max(30 * 24 * 60 * 60),
  loginMaxAttempts: z.number().int().min(1).max(100),
  loginWindowSeconds: z.number().int().min(10).max(24 * 60 * 60),
  scryptN: z.number().int().min(1024).max(1_048_576),
  siteUrl: z.string().url(),
})

export interface ConfigViolation {
  severity: "fatal" | "warn"
  message: string
}

/**
 * Validates the configuration and returns violations.
 *
 * Kept separate from `assertSecureConfig` so tests and the `/api/health`
 * endpoint can surface the same findings without throwing.
 */
export function inspectConfig(config: AppConfig = getConfig()): ConfigViolation[] {
  const violations: ConfigViolation[] = []

  const parsed = startupSchema.safeParse(config)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      violations.push({ severity: "fatal", message: `Invalid config ${issue.path.join(".")}: ${issue.message}` })
    }
  }

  if (config.sessionSecret.length < 32) {
    violations.push({
      severity: config.isProduction ? "fatal" : "warn",
      message: "WMS_SESSION_SECRET must be at least 32 characters.",
    })
  }

  if (config.sessionSecret === INSECURE_DEV_SECRET) {
    violations.push({
      severity: config.isProduction ? "fatal" : "warn",
      message: "Running on the built-in development session secret.",
    })
  }

  if (config.isProduction && config.seedDemoData) {
    violations.push({
      severity: "warn",
      message: "WMS_SEED_DEMO_DATA is on in production — demo users and stock will be created.",
    })
  }

  if (!config.requireSecureCookies) {
    violations.push({
      severity: "warn",
      message: "Session cookie is not marked Secure (WMS_SECURE_COOKIES=false).",
    })
  }

  return violations
}

/**
 * Boot-time gate. Throws on any `fatal` violation, which stops a production
 * container from serving traffic with a debug secret or an insane TTL.
 */
export function assertSecureConfig(config: AppConfig = getConfig()): void {
  const fatal = inspectConfig(config).filter((v) => v.severity === "fatal")
  if (fatal.length > 0) {
    throw new Error(`WMS configuration refused to start:\n  - ${fatal.map((f) => f.message).join("\n  - ")}`)
  }
}
