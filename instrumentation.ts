import { assertSecureConfig, getConfig, inspectConfig } from "@/lib/security/config"

/**
 * Runs once when the server boots, before any request is served.
 *
 * This is the gate that stops a production container from starting on a debug
 * secret or a nonsensical TTL. Warnings are logged but do not block startup,
 * because "your cookie isn't marked Secure" should not take a site down —
 * whereas "you're signing sessions with the public dev secret" should.
 */
export async function register() {
  // Only the Node runtime has crypto/fs; skip on the edge runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") return

  const config = getConfig()

  for (const violation of inspectConfig(config)) {
    if (violation.severity === "warn") {
      console.warn(`[wms] config warning: ${violation.message}`)
    }
  }

  try {
    assertSecureConfig(config)
  } catch (error) {
    console.error((error as Error).message)
    throw error
  }

  console.log(
    `[wms] ready — env=${config.nodeEnv} storage=${config.storageDriver} seeding=${config.seedDemoData} audit=${config.auditLogEnabled}`,
  )
}
