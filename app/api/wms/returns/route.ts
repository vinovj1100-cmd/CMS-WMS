import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ApiError, ok, parseBody } from "@/lib/api/http"
import { hasPermission } from "@/lib/security/rbac"
import { createReturn, receiveReturn, reviewReturn } from "@/lib/wms/services/operations"
import { createReturnSchema, receiveReturnSchema, reviewReturnSchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"

/**
 * GET  /api/wms/returns — return authorisations (RMAs).
 * POST /api/wms/returns — create an RMA, or drive it with `action`:
 *        review | receive.
 *
 * Reviewing and receiving both need a supervisor capability, so an operator
 * cannot approve their own return and put it straight back into saleable stock.
 */
export const GET = withAuth({ permission: "returns:read" }, async () => {
  const store = await getStore()
  const snapshot = await store.read()

  const returns = snapshot.returns
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((rma) => ({
      ...rma,
      skuCode: snapshot.skus.find((s) => s.id === rma.skuId)?.code ?? "UNKNOWN",
      skuName: snapshot.skus.find((s) => s.id === rma.skuId)?.name ?? "",
      customerName: snapshot.customers.find((c) => c.id === rma.customerId)?.name ?? "Unknown",
      orderNumber: rma.orderId ? snapshot.salesOrders.find((o) => o.id === rma.orderId)?.number ?? null : null,
    }))

  return ok({ returns })
})

export const POST = withAuth(
  { permission: "returns:read", auditAction: "returns.manage", auditResource: "return" },
  async (request: NextRequest, auth) => {
    const raw = (await request.json()) as Record<string, unknown>
    const store = await getStore()
    const action = raw.action as string | undefined

    if (action === "review") {
      if (!hasPermission(auth.user.role, "returns:approve")) {
        throw ApiError.forbidden('Reviewing a return requires the "returns:approve" permission.')
      }
      const body = reviewReturnSchema.parse(raw)
      const rma = await store.mutate((snapshot) =>
        reviewReturn(snapshot, String(raw.rmaId ?? ""), body.approve, auth.user.username),
      )
      return ok({ ok: true, rma })
    }

    if (action === "receive") {
      if (!hasPermission(auth.user.role, "returns:process")) {
        throw ApiError.forbidden('Receiving a return requires the "returns:process" permission.')
      }
      const body = receiveReturnSchema.parse(raw)
      const rma = await store.mutate((snapshot) =>
        receiveReturn(snapshot, String(raw.rmaId ?? ""), body.disposition, body.location, auth.user.username),
      )
      return ok({ ok: true, rma })
    }

    const body = createReturnSchema.parse(raw)
    const rma = await store.mutate((snapshot) => createReturn(snapshot, body))
    return ok({ ok: true, rma }, { status: 201 })
  },
)

export const dynamic = "force-dynamic"
