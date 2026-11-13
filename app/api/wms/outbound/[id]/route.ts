import type { NextRequest } from "next/server"

import { withAuth, type AuthContext } from "@/lib/api/guard"
import { ApiError, ok } from "@/lib/api/http"
import { hasPermission, type Permission } from "@/lib/security/rbac"
import { allocateOrder, cancelOrder, packOrder, shipOrder } from "@/lib/wms/services/outbound"
import { cancelOrderSchema, packOrderSchema, shipOrderSchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"

/**
 * POST /api/wms/outbound/[id]
 *
 * State-machine transitions for one order, selected by `action`:
 *   allocate | cancel | pack | ship
 *
 * Each branch declares the capability it needs. Routing the check through the
 * user's permission list (rather than `withAuth`'s single `permission` option)
 * lets one endpoint serve four different capability levels — a packer and a
 * shipping clerk both use it, for different halves of the flow.
 */
export const POST = withAuth(
  { auditAction: "outbound.transition", auditResource: "sales_order" },
  async (request: NextRequest, auth, { params }) => {
    const orderId = params.id
    const raw = (await request.json()) as Record<string, unknown>
    const store = await getStore()

    switch (raw.action) {
      case "allocate": {
        require(auth, "outbound:allocate")
        const order = await store.mutate((snapshot) => allocateOrder(snapshot, orderId))
        return ok({ ok: true, order })
      }

      case "cancel": {
        require(auth, "outbound:allocate")
        const body = cancelOrderSchema.parse(raw)
        const order = await store.mutate((snapshot) => cancelOrder(snapshot, orderId, body.reason))
        return ok({ ok: true, order })
      }

      case "pack": {
        require(auth, "outbound:pack")
        const body = packOrderSchema.parse(raw)
        const pack = await store.mutate((snapshot) =>
          packOrder(snapshot, { ...body, orderId, packedBy: auth.user.username }),
        )
        return ok({ ok: true, pack })
      }

      case "ship": {
        require(auth, "outbound:ship")
        const body = shipOrderSchema.parse(raw)
        const shipment = await store.mutate((snapshot) =>
          shipOrder(snapshot, { ...body, orderId, shippedBy: auth.user.username }),
        )
        return ok({ ok: true, shipment })
      }

      default:
        throw ApiError.badRequest(
          `Unknown action "${String(raw.action)}". Expected allocate, cancel, pack or ship.`,
        )
    }
  },
)

/** Throws a 403 unless the caller holds `permission`. */
function require(auth: AuthContext, permission: Permission): void {
  if (!hasPermission(auth.user.role, permission)) {
    throw ApiError.forbidden(`This action requires the "${permission}" permission.`)
  }
}

export const dynamic = "force-dynamic"
