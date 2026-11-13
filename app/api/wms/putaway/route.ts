import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ok, parseBody } from "@/lib/api/http"
import { completePutaway } from "@/lib/wms/services/inbound"
import { completePutawaySchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"

/**
 * GET  /api/wms/putaway — open putaway tasks, highest priority first.
 * POST /api/wms/putaway — complete a task. Body: { taskId, location }.
 *
 * The operator scans the destination bin; the server checks it against the
 * suggestion and reports a mismatch rather than refusing it. Racks do get full,
 * and a hard block at the scanner just gets worked around. Recording the
 * deviation instead lets a supervisor see which locations are being skipped.
 */
export const GET = withAuth({ permission: "inbound:putaway" }, async (request: NextRequest) => {
  const store = await getStore()
  const snapshot = await store.read()
  const status = new URL(request.url).searchParams.get("status") ?? "open"

  const tasks = snapshot.putawayTasks
    .filter((task) =>
      status === "open" ? task.status === "pending" || task.status === "in_progress" : task.status === status,
    )
    .sort((a, b) => a.priority - b.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((task) => {
      const sku = snapshot.skus.find((s) => s.id === task.skuId)
      return {
        ...task,
        skuCode: sku?.code ?? "UNKNOWN",
        skuName: sku?.name ?? "",
        uom: sku?.uom ?? "EA",
        lotControlled: sku?.lotControlled ?? false,
        fromLocationCode: snapshot.locations.find((l) => l.id === task.fromLocationId)?.code ?? "",
        suggestedLocationCode: task.suggestedLocationId
          ? snapshot.locations.find((l) => l.id === task.suggestedLocationId)?.code ?? null
          : null,
        inboundNumber: snapshot.inboundShipments.find((a) => a.id === task.inboundShipmentId)?.number ?? "",
      }
    })

  return ok({ tasks })
})

export const POST = withAuth(
  { permission: "inbound:putaway", auditAction: "inbound.putaway", auditResource: "putaway_task" },
  async (request: NextRequest, auth) => {
    const body = await parseBody(request, completePutawaySchema)
    const store = await getStore()

    const result = await store.mutate((snapshot) => {
      const task = snapshot.putawayTasks.find((t) => t.id === body.taskId)
      const suggested = task?.suggestedLocationId
        ? snapshot.locations.find((l) => l.id === task.suggestedLocationId)?.code ?? null
        : null

      const completed = completePutaway(snapshot, body.taskId, body.location, auth.user.username)
      const actual = snapshot.locations.find((l) => l.id === completed.actualLocationId)?.code ?? null

      return {
        task: completed,
        actualLocationCode: actual,
        suggestedLocationCode: suggested,
        deviated: suggested !== null && actual !== suggested,
      }
    })

    return ok({
      ok: true,
      task: result.task,
      locationCode: result.actualLocationCode,
      suggestedLocationCode: result.suggestedLocationCode,
      deviatedFromSuggestion: result.deviated,
    })
  },
)

export const dynamic = "force-dynamic"
