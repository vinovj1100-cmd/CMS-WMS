import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ApiError, ok, parseBody } from "@/lib/api/http"
import {
  approveCycleCount,
  createCycleCount,
  rejectCycleCount,
  startCycleCount,
  submitCountEntries,
} from "@/lib/wms/services/cycle-count"
import { createCycleCountSchema, rejectCountSchema, submitCountSchema } from "@/lib/wms/schemas"
import { hasPermission } from "@/lib/security/rbac"
import { getStore } from "@/lib/wms/store"

/**
 * GET  /api/wms/cycle-counts — count sheets with their lines.
 * POST /api/wms/cycle-counts — create a sheet, or drive one through its states
 *        with `action`: start | submit | approve | reject.
 *
 * `approve` needs `cyclecount:approve` and is deliberately a separate
 * capability from counting, so the person who counted cannot be the person who
 * signs off the variance.
 */
export const GET = withAuth({ permission: "cyclecount:read" }, async (request: NextRequest) => {
  const store = await getStore()
  const snapshot = await store.read()

  const status = new URL(request.url).searchParams.get("status")

  const counts = snapshot.cycleCounts
    .filter((count) => !status || count.status === status)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((count) => ({
      ...count,
      zoneCode: count.zoneId ? snapshot.zones.find((z) => z.id === count.zoneId)?.code ?? null : null,
      warehouseCode: snapshot.warehouses.find((w) => w.id === count.warehouseId)?.code ?? "",
      totalVariance: count.lines.reduce((sum, line) => sum + line.variance, 0),
      linesWithVariance: count.lines.filter((line) => line.variance !== 0).length,
      lines: count.lines.map((line) => ({
        ...line,
        skuCode: snapshot.skus.find((s) => s.id === line.skuId)?.code ?? "UNKNOWN",
        skuName: snapshot.skus.find((s) => s.id === line.skuId)?.name ?? "",
        locationCode: snapshot.locations.find((l) => l.id === line.locationId)?.code ?? "",
      })),
    }))

  return ok({ counts })
})

export const POST = withAuth(
  { permission: "cyclecount:create", auditAction: "cyclecount.manage", auditResource: "cycle_count" },
  async (request: NextRequest, auth) => {
    const raw = (await request.json()) as Record<string, unknown>
    const store = await getStore()
    const action = raw.action as string | undefined

    if (action === "start") {
      const countId = String(raw.countId ?? "")
      const count = await store.mutate((snapshot) => startCycleCount(snapshot, countId, auth.user.username))
      return ok({ ok: true, count })
    }

    if (action === "submit") {
      const body = submitCountSchema.parse(raw)
      const countId = String(raw.countId ?? "")
      const count = await store.mutate((snapshot) =>
        submitCountEntries(snapshot, { countId, entries: body.entries, counter: auth.user.username }),
      )
      return ok({
        ok: true,
        count,
        linesWithVariance: count.lines.filter((l) => l.variance !== 0).length,
      })
    }

    if (action === "approve") {
      if (!hasPermission(auth.user.role, "cyclecount:approve")) {
        throw ApiError.forbidden('Approving a variance requires the "cyclecount:approve" permission.')
      }
      const countId = String(raw.countId ?? "")
      const result = await store.mutate((snapshot) => approveCycleCount(snapshot, countId, auth.user.username))
      return ok({ ok: true, count: result.count, adjustments: result.adjustments })
    }

    if (action === "reject") {
      if (!hasPermission(auth.user.role, "cyclecount:approve")) {
        throw ApiError.forbidden('Rejecting a count requires the "cyclecount:approve" permission.')
      }
      const body = rejectCountSchema.parse(raw)
      const count = await store.mutate((snapshot) => rejectCycleCount(snapshot, String(raw.countId ?? ""), body.reason))
      return ok({ ok: true, count })
    }

    const body = createCycleCountSchema.parse(raw)
    const count = await store.mutate((snapshot) => createCycleCount(snapshot, body))
    return ok({ ok: true, count }, { status: 201 })
  },
)

export const dynamic = "force-dynamic"
