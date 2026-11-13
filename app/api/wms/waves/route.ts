import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ok, parseBody } from "@/lib/api/http"
import { createWave, releaseWave } from "@/lib/wms/services/outbound"
import { createWaveSchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"

/**
 * GET  /api/wms/waves — waves with their order and pick-task counts.
 * POST /api/wms/waves — create a wave, or release one with `{ waveId }`.
 */
export const GET = withAuth({ permission: "wave:read" }, async (request: NextRequest) => {
  const store = await getStore()
  const snapshot = await store.read()

  const waves = snapshot.waves.map((wave) => {
    const tasks = snapshot.pickTasks.filter((t) => t.waveId === wave.id)
    return {
      ...wave,
      orderCount: wave.orderIds.length,
      orderNumbers: wave.orderIds.map((id) => snapshot.salesOrders.find((o) => o.id === id)?.number ?? "?"),
      pickTasksTotal: tasks.length,
      pickTasksComplete: tasks.filter((t) => t.status === "complete" || t.status === "short").length,
      openHours:
        wave.status === "released" || wave.status === "picking"
          ? Math.round(((Date.now() - Date.parse(wave.releasedAt ?? wave.createdAt)) / 3_600_000) * 10) / 10
          : 0,
    }
  })

  return ok({ waves })
})

export const POST = withAuth(
  { permission: "wave:release", auditAction: "wave.manage", auditResource: "wave" },
  async (request: NextRequest, auth) => {
    const raw = (await request.json()) as Record<string, unknown>
    const store = await getStore()

    if (typeof raw.waveId === "string") {
      const waveId = raw.waveId
      const result = await store.mutate((snapshot) => releaseWave(snapshot, waveId, auth.user.username))
      return ok({ ok: true, released: true, wave: result.wave, pickTasks: result.pickTasks })
    }

    const body = createWaveSchema.parse(raw)
    const wave = await store.mutate((snapshot) => createWave(snapshot, body))
    return ok({ ok: true, created: true, wave }, { status: 201 })
  },
)

export const dynamic = "force-dynamic"
