import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ok, parseBody } from "@/lib/api/http"
import { createInboundShipment, createPurchaseOrder, submitPurchaseOrder } from "@/lib/wms/services/inbound"
import { advanceInboundSchema, createInboundSchema, createPurchaseOrderSchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"

/**
 * GET  /api/wms/inbound — inbound shipments (ASNs) and their purchase orders.
 * POST /api/wms/inbound — create an ASN, or a purchase order with `kind: "po"`.
 */
export const GET = withAuth({ permission: "inbound:read" }, async (request: NextRequest) => {
  const store = await getStore()
  const snapshot = await store.read()
  const status = new URL(request.url).searchParams.get("status")

  const shipments = snapshot.inboundShipments
    .filter((asn) => !status || asn.status === status)
    .map((asn) => ({
      ...asn,
      supplierName: snapshot.suppliers.find((s) => s.id === asn.supplierId)?.name ?? "Unknown",
      warehouseCode: snapshot.warehouses.find((w) => w.id === asn.warehouseId)?.code ?? "",
      lines: asn.lines.map((line) => ({
        ...line,
        skuCode: snapshot.skus.find((s) => s.id === line.skuId)?.code ?? "UNKNOWN",
        skuName: snapshot.skus.find((s) => s.id === line.skuId)?.name ?? "",
        uom: snapshot.skus.find((s) => s.id === line.skuId)?.uom ?? "EA",
      })),
    }))

  const purchaseOrders = snapshot.purchaseOrders.map((po) => ({
    ...po,
    supplierName: snapshot.suppliers.find((s) => s.id === po.supplierId)?.name ?? "Unknown",
    lines: po.lines.map((line) => ({
      ...line,
      skuCode: snapshot.skus.find((s) => s.id === line.skuId)?.code ?? "UNKNOWN",
      skuName: snapshot.skus.find((s) => s.id === line.skuId)?.name ?? "",
    })),
  }))

  return ok({ shipments, purchaseOrders })
})

export const POST = withAuth(
  { permission: "inbound:create", auditAction: "inbound.create", auditResource: "inbound_shipment" },
  async (request: NextRequest, auth) => {
    const store = await getStore()
    const raw = (await request.clone().json()) as Record<string, unknown>

    // A purchase order and an ASN share an endpoint because the receiving desk
    // raises both; the discriminator keeps the client simple.
    if (raw.kind === "purchase_order") {
      const body = createPurchaseOrderSchema.parse(raw)
      const po = await store.mutate((snapshot) => createPurchaseOrder(snapshot, { ...body, createdBy: auth.user.username }))
      return ok({ created: "purchase_order", purchaseOrder: po }, { status: 201 })
    }

    const body = createInboundSchema.parse(raw)
    const asn = await store.mutate((snapshot) => createInboundShipment(snapshot, body))
    return ok({ created: "inbound_shipment", shipment: asn }, { status: 201 })
  },
)

/** POST body variants are discriminated in the handler above; this keeps the schema import used. */
void advanceInboundSchema
void submitPurchaseOrder

export const dynamic = "force-dynamic"
