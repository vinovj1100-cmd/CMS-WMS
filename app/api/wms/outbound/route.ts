import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ok, parseBody } from "@/lib/api/http"
import { allocateOrder, createSalesOrder } from "@/lib/wms/services/outbound"
import { createSalesOrderSchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"

/**
 * GET  /api/wms/outbound — sales orders with line detail and customer names.
 * POST /api/wms/outbound — create a sales order.
 *
 * Allocation is a separate action rather than a side effect of creation, so an
 * order can be reviewed before stock is committed to it.
 */
export const GET = withAuth({ permission: "outbound:read" }, async (request: NextRequest) => {
  const store = await getStore()
  const snapshot = await store.read()

  const params = new URL(request.url).searchParams
  const status = params.get("status")
  const unassignedOnly = params.get("unassigned") === "true"

  const orders = snapshot.salesOrders
    .filter((order) => (!status || order.status === status) && (!unassignedOnly || !order.waveId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((order) => ({
      ...order,
      customerName: snapshot.customers.find((c) => c.id === order.customerId)?.name ?? "Unknown",
      customerCode: snapshot.customers.find((c) => c.id === order.customerId)?.code ?? "",
      warehouseCode: snapshot.warehouses.find((w) => w.id === order.warehouseId)?.code ?? "",
      waveNumber: order.waveId ? snapshot.waves.find((w) => w.id === order.waveId)?.number ?? null : null,
      lines: order.lines.map((line) => ({
        ...line,
        skuCode: snapshot.skus.find((s) => s.id === line.skuId)?.code ?? "UNKNOWN",
        skuName: snapshot.skus.find((s) => s.id === line.skuId)?.name ?? "",
        uom: snapshot.skus.find((s) => s.id === line.skuId)?.uom ?? "EA",
      })),
    }))

  return ok({ orders })
})

export const POST = withAuth(
  { permission: "outbound:create", auditAction: "outbound.create", auditResource: "sales_order" },
  async (request: NextRequest) => {
    const body = await parseBody(request, createSalesOrderSchema)
    const store = await getStore()
    const order = await store.mutate((snapshot) => createSalesOrder(snapshot, body))
    return ok({ order }, { status: 201 })
  },
)

export const dynamic = "force-dynamic"
