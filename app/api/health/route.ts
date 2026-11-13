import { ok, toErrorResponse } from "@/lib/api/http"
import { getConfig, inspectConfig } from "@/lib/security/config"
import { getStore } from "@/lib/wms/store"

/**
 * GET /api/health
 *
 * Liveness + readiness in one unauthenticated endpoint. Deliberately exposes no
 * secrets: just the storage driver, whether the dataset is populated, and any
 * configuration warnings an operator should see.
 *
 * Point your load balancer's health check here. A non-200 means the instance
 * cannot serve traffic and should be drained.
 */
export async function GET() {
  const startedAt = Date.now()

  try {
    const config = getConfig()
    const store = await getStore()
    const snapshot = await store.read()

    const violations = inspectConfig(config)
    const fatal = violations.filter((v) => v.severity === "fatal")

    const ready = fatal.length === 0 && snapshot.warehouses.length > 0

    return ok(
      {
        status: ready ? "ok" : "degraded",
        ready,
        environment: config.nodeEnv,
        storage: {
          driver: store.driver,
          seeded: snapshot.warehouses.length > 0,
          warehouses: snapshot.warehouses.length,
          skus: snapshot.skus.length,
          inventoryRecords: snapshot.inventory.length,
        },
        security: {
          secureCookies: config.requireSecureCookies,
          auditLog: config.auditLogEnabled,
          demoDataSeeded: config.seedDemoData,
          warnings: violations.map((v) => ({ severity: v.severity, message: v.message })),
        },
        checkedInMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      },
      { status: ready ? 200 : 503 },
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}

export const dynamic = "force-dynamic"
