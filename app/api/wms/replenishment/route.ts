import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ok, parseBody } from "@/lib/api/http"
import { executeReplenishment, generateReplenishment } from "@/lib/wms/services/operations"
import { generateReplenishmentSchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"

/**
 * GET  /api/wms/replenishment — open replenishment tasks.
 * POST /api/wms/replenishment — generate tasks from min-stock rules, or execute
 *        one with `{ taskId }`.
 */
export const GET = withAuth({ permission: "replenishment:read" }, async () => {
  const store = await getStore()
  const snapshot = await store.read()

  const tasks = snapshot.replenishmentTasks
    .filter((task) => task.status !== "complete" && task.status !== "cancelled")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((task) => {
      const sku = snapshot.skus.find((s) => s.id === task.skuId)
      return {
        ...task,
        skuCode: sku?.code ?? "UNKNOWN",
        skuName: sku?.name ?? "",
        uom: sku?.uom ?? "EA",
        fromLocationCode: snapshot.locations.find((l) => l.id === task.fromLocationId)?.code ?? "",
        toLocationCode: snapshot.locations.find((l) => l.id === task.toLocationId)?.code ?? "",
      }
    })

  return ok({ tasks })
})

export const POST = withAuth(
  { permission: "replenishment:execute", auditAction: "replenishment.manage", auditResource: "replenishment_task" },
  async (request: NextRequest, auth) => {
    const raw = (await request.json()) as Record<string, unknown>
    const store = await getStore()

    if (typeof raw.taskId === "string") {
      const taskId = raw.taskId
      const task = await store.mutate((snapshot) => executeReplenishment(snapshot, taskId, auth.user.username))
      return ok({ ok: true, executed: true, task })
    }

    const body = generateReplenishmentSchema.parse(raw)
    const created = await store.mutate((snapshot) =>
      generateReplenishment(snapshot, body.warehouseId, auth.user.username),
    )
    return ok({ ok: true, generated: true, tasksCreated: created.length, tasks: created }, { status: 201 })
  },
)

export const dynamic = "force-dynamic"
