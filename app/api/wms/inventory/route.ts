import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ok, parseBody, parseQuery, readIntParam, readSearchParam } from "@/lib/api/http"
import { adjustInventory, lowStock, skuBalances } from "@/lib/wms/services/inventory"
import { adjustInventorySchema, inventoryQuerySchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"
import { availableQuantity } from "@/lib/wms/types"

/**
 * GET  /api/wms/inventory — paginated stock ledger with filters.
 * POST /api/wms/inventory — manual stock adjustment (requires inventory:adjust).
 *
 * The GET intentionally joins SKU and location names server-side so the client
 * never has to hold the full catalogue in memory.
 */
export const GET = withAuth({ permission: "inventory:read" }, async (request: NextRequest) => {
  const query = parseQuery(request.url, inventoryQuerySchema)
  const store = await getStore()
  const snapshot = await store.read()

  const search = readSearchParam(query.search ?? null).toLowerCase()

  let records = snapshot.inventory.filter((record) => {
    if (query.warehouseId && record.warehouseId !== query.warehouseId) return false
    if (query.skuId && record.skuId !== query.skuId) return false
    if (query.locationId && record.locationId !== query.locationId) return false
    if (query.zoneId) {
      const location = snapshot.locations.find((l) => l.id === record.locationId)
      if (!location || location.zoneId !== query.zoneId) return false
    }
    if (search) {
      const sku = snapshot.skus.find((s) => s.id === record.skuId)
      const location = snapshot.locations.find((l) => l.id === record.locationId)
      const haystack = `${sku?.code ?? ""} ${sku?.name ?? ""} ${location?.code ?? ""} ${record.lot ?? ""}`.toLowerCase()
      if (!haystack.includes(search)) return false
    }
    return true
  })

  // "Available only" hides empty and fully-committed rows.
  records = records.filter((r) => r.quantityOnHand > 0 || r.quantityAllocated > 0)

  records.sort((a, b) => {
    const codeA = snapshot.skus.find((s) => s.id === a.skuId)?.code ?? ""
    const codeB = snapshot.skus.find((s) => s.id === b.skuId)?.code ?? ""
    return codeA.localeCompare(codeB)
  })

  const page = readIntParam(String(query.page), 1, 1, 1000)
  const pageSize = readIntParam(String(query.pageSize), 50, 1, 200)
  const start = (page - 1) * pageSize

  const rows = records.slice(start, start + pageSize).map((record) => {
    const sku = snapshot.skus.find((s) => s.id === record.skuId)
    const location = snapshot.locations.find((l) => l.id === record.locationId)
    const zone = snapshot.zones.find((z) => z.id === location?.zoneId)
    return {
      ...record,
      available: availableQuantity(record),
      skuCode: sku?.code ?? "UNKNOWN",
      skuName: sku?.name ?? "Unknown SKU",
      uom: sku?.uom ?? "EA",
      category: sku?.category ?? "",
      abcClass: sku?.abcClass ?? "C",
      reorderPoint: sku?.reorderPoint ?? 0,
      locationCode: location?.code ?? "UNKNOWN",
      zoneCode: zone?.code ?? "",
      warehouseCode: snapshot.warehouses.find((w) => w.id === record.warehouseId)?.code ?? "",
    }
  })

  return ok({
    data: rows,
    pagination: { page, pageSize, total: records.length, totalPages: Math.max(1, Math.ceil(records.length / pageSize)) },
    summary: {
      balances: skuBalances(snapshot).length,
      lowStock: lowStock(snapshot).length,
    },
  })
})

export const POST = withAuth(
  { permission: "inventory:adjust", auditAction: "inventory.adjust", auditResource: "inventory" },
  async (request: NextRequest, auth) => {
    const body = await parseBody(request, adjustInventorySchema)
    const store = await getStore()

    const record = await store.mutate((snapshot) =>
      adjustInventory(snapshot, {
        skuId: body.skuId,
        locationId: body.locationId,
        lot: body.lot ?? null,
        delta: body.delta,
        reason: body.reason,
        reference: body.reference,
        note: body.note,
        performedBy: auth.user.username,
      }),
    )

    return ok({
      ok: true,
      inventoryId: record.id,
      quantityOnHand: record.quantityOnHand,
      available: availableQuantity(record),
      adjustedBy: auth.user.username,
    })
  },
)

export const dynamic = "force-dynamic"
