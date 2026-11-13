import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ok, parseBody } from "@/lib/api/http"
import { transferInventory } from "@/lib/wms/services/inventory"
import { transferInventorySchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"
import { availableQuantity } from "@/lib/wms/types"

/**
 * POST /api/wms/inventory/transfer
 *
 * Ad-hoc move between two locations (damage segregation, consolidating a split
 * SKU, moving a pallet to a different aisle). Planned moves go through putaway
 * or replenishment tasks instead, so the ledger shows *why* the stock moved.
 */
export const POST = withAuth(
  { permission: "inventory:transfer", auditAction: "inventory.transfer", auditResource: "inventory" },
  async (request: NextRequest, auth) => {
    const body = await parseBody(request, transferInventorySchema)
    const store = await getStore()

    const result = await store.mutate((snapshot) =>
      transferInventory(snapshot, {
        skuId: body.skuId,
        fromLocationId: body.fromLocationId,
        toLocationId: body.toLocationId,
        lot: body.lot ?? null,
        quantity: body.quantity,
        reference: body.reference,
        performedBy: auth.user.username,
        note: body.note,
      }),
    )

    return ok({
      ok: true,
      from: { locationId: result.from.locationId, onHand: result.from.quantityOnHand, available: availableQuantity(result.from) },
      to: { locationId: result.to.locationId, onHand: result.to.quantityOnHand, available: availableQuantity(result.to) },
    })
  },
)

export const dynamic = "force-dynamic"
