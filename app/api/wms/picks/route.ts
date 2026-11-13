import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ok, parseBody } from "@/lib/api/http"
import { confirmPick } from "@/lib/wms/services/outbound"
import { confirmPickRequestSchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"

/**
 * GET  /api/wms/picks — pick tasks, optionally filtered to one wave.
 * POST /api/wms/picks — confirm a pick. Body: { taskId, quantityPicked }.
 *
 * Tasks come back in `sequence` order, which is the travel-optimised walk path
 * computed when the wave was released. The handheld walks the list top to
 * bottom and never doubles back down an aisle.
 */
export const GET = withAuth({ permission: "outbound:pick" }, async (request: NextRequest) => {
  const store = await getStore()
  const snapshot = await store.read()

  const params = new URL(request.url).searchParams
  const waveId = params.get("waveId")
  const status = params.get("status") ?? "open"

  const tasks = snapshot.pickTasks
    .filter((task) => {
      if (waveId && task.waveId !== waveId) return false
      if (status === "open") return task.status === "pending" || task.status === "in_progress"
      if (status !== "all") return task.status === status
      return true
    })
    .sort((a, b) => a.sequence - b.sequence)
    .map((task) => {
      const sku = snapshot.skus.find((s) => s.id === task.skuId)
      const location = snapshot.locations.find((l) => l.id === task.fromLocationId)
      return {
        ...task,
        skuCode: sku?.code ?? "UNKNOWN",
        skuName: sku?.name ?? "",
        uom: sku?.uom ?? "EA",
        barcode: sku?.barcode ?? "",
        locationCode: location?.code ?? "",
        aisle: location?.aisle ?? "",
        orderNumber: snapshot.salesOrders.find((o) => o.id === task.orderId)?.number ?? "",
        waveNumber: snapshot.waves.find((w) => w.id === task.waveId)?.number ?? "",
      }
    })

  return ok({ tasks })
})

export const POST = withAuth(
  { permission: "outbound:pick", auditAction: "outbound.pick.confirm", auditResource: "pick_task" },
  async (request: NextRequest, auth) => {
    const body = await parseBody(request, confirmPickRequestSchema)
    const store = await getStore()

    const result = await store.mutate((snapshot) => {
      const task = confirmPick(snapshot, {
        taskId: body.taskId,
        quantityPicked: body.quantityPicked,
        performedBy: auth.user.username,
      })
      const wave = snapshot.waves.find((w) => w.id === task.waveId)
      const remaining = snapshot.pickTasks.filter(
        (t) => t.waveId === task.waveId && (t.status === "pending" || t.status === "in_progress"),
      ).length
      return { task, waveStatus: wave?.status ?? null, remainingInWave: remaining }
    })

    return ok({
      ok: true,
      task: result.task,
      short: result.task.status === "short",
      waveStatus: result.waveStatus,
      remainingInWave: result.remainingInWave,
    })
  },
)

export const dynamic = "force-dynamic"
