import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ok, parseQuery } from "@/lib/api/http"
import { auditQuerySchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"

/**
 * GET /api/wms/audit
 *
 * Read-only view of the audit trail. Gated behind `audit:read`, which only
 * supervisors and above hold — the log is how you hold operators accountable,
 * so operators should not be able to read their colleagues' entries.
 *
 * There is no DELETE here on purpose.
 */
export const GET = withAuth({ permission: "audit:read" }, async (request: NextRequest) => {
  const store = await getStore()
  const snapshot = await store.read()

  const query = parseQuery(request.url, auditQuerySchema)

  const filtered = snapshot.auditLog
    .filter((entry) => {
      if (query.actor && entry.actor.toLowerCase() !== query.actor.toLowerCase()) return false
      if (query.action && !entry.action.toLowerCase().includes(query.action.toLowerCase())) return false
      if (query.resource && entry.resource !== query.resource) return false
      if (query.outcome && entry.outcome !== query.outcome) return false
      return true
    })
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))

  const start = (query.page - 1) * query.pageSize
  const deniedCount = snapshot.auditLog.filter((e) => e.outcome === "denied").length
  const failedCount = snapshot.auditLog.filter((e) => e.outcome === "failure").length

  return ok({
    data: filtered.slice(start, start + query.pageSize),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length,
      totalPages: Math.max(1, Math.ceil(filtered.length / query.pageSize)),
    },
    totals: {
      entries: snapshot.auditLog.length,
      denied: deniedCount,
      failed: failedCount,
    },
  })
})

export const dynamic = "force-dynamic"
