import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ApiError, ok, parseBody, parseQuery } from "@/lib/api/http"
import { findLocation } from "@/lib/wms/services/inventory"
import { locationQuerySchema, locationUpdateSchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"

/**
 * GET   /api/wms/locations — locations with zone, status and fill.
 * PATCH /api/wms/locations — update a location's status/flags.
 *
 * Blocking a location is the operator's escape hatch: a damaged rack, a spill,
 * or a bin that keeps mis-picking can be taken out of service without deleting
 * the record or losing its history.
 */
export const GET = withAuth({ permission: "location:read" }, async (request: NextRequest) => {
  const store = await getStore()
  const snapshot = await store.read()

  const query = parseQuery(request.url, locationQuerySchema)
  const search = (query.search ?? "").trim().toLowerCase()

  const filtered = snapshot.locations
    .filter((location) => {
      if (query.warehouseId && location.warehouseId !== query.warehouseId) return false
      if (query.zoneId && location.zoneId !== query.zoneId) return false
      if (query.status && location.status !== query.status) return false
      if (search && !location.code.toLowerCase().includes(search)) return false
      return true
    })
    // Natural sort so A-02 sits before A-10 instead of after.
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))

  const start = (query.page - 1) * query.pageSize
  const rows = filtered.slice(start, start + query.pageSize).map((location) => ({
    ...location,
    zoneCode: snapshot.zones.find((z) => z.id === location.zoneId)?.code ?? "",
    zoneName: snapshot.zones.find((z) => z.id === location.zoneId)?.name ?? "",
    warehouseCode: snapshot.warehouses.find((w) => w.id === location.warehouseId)?.code ?? "",
    skuCount: snapshot.inventory.filter((r) => r.locationId === location.id && r.quantityOnHand > 0).length,
    fillPercent:
      location.capacityKg === 0 ? 0 : Math.round((location.currentWeightKg / location.capacityKg) * 1000) / 10,
  }))

  return ok({
    data: rows,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length,
      totalPages: Math.max(1, Math.ceil(filtered.length / query.pageSize)),
    },
  })
})

export const PATCH = withAuth(
  { permission: "location:manage", auditAction: "location.update", auditResource: "location" },
  async (request: NextRequest) => {
    const body = await parseBody(request, locationUpdateSchema)
    const store = await getStore()

    const updated = await store.mutate((snapshot) => {
      const location = findLocation(snapshot, body.locationId)

      if (body.status !== undefined) {
        // Refusing to block a location that still holds stock is deliberate:
        // putaway and replenishment both skip blocked locations, so stock left
        // in one would become silently unfillable.
        if (body.status === "blocked") {
          const units = snapshot.inventory
            .filter((r) => r.locationId === location.id)
            .reduce((sum, r) => sum + r.quantityOnHand, 0)
          if (units > 0) {
            throw ApiError.conflict(
              `Location ${location.code} still holds ${units} unit(s). Move the stock before blocking it.`,
            )
          }
        }
        location.status = body.status
      }

      if (body.pickFace !== undefined) location.pickFace = body.pickFace
      if (body.capacityKg !== undefined) location.capacityKg = body.capacityKg
      location.updatedAt = new Date().toISOString()

      return location
    })

    return ok({ ok: true, location: updated })
  },
)

export const dynamic = "force-dynamic"
