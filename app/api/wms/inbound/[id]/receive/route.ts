import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ApiError, ok, parseBody } from "@/lib/api/http"
import { advanceInbound, receiveLine } from "@/lib/wms/services/inbound"
import { advanceInboundSchema, receiveLineSchema } from "@/lib/wms/schemas"
import { getStore } from "@/lib/wms/store"
import type { InboundTransition } from "@/lib/wms/services/inbound"

/**
 * POST /api/wms/inbound/[id]/receive
 *
 * One endpoint drives the whole dock-side flow:
 *   { "action": "advance", "to": "receiving" }   → move the ASN through its states
 *   { "action": "receive", ...line fields }      → record what physically arrived
 *
 * Keeping them together means the receiving screen makes one round trip per
 * scan, which matters when somebody is standing at a dock with a handheld.
 */
export const POST = withAuth(
  { permission: "inbound:receive", auditAction: "inbound.receive", auditResource: "inbound_shipment" },
  async (request: NextRequest, auth, { params }) => {
    const asnId = params.id
    const raw = (await request.json()) as Record<string, unknown>
    const store = await getStore()

    if (raw.action === "advance") {
      const { to } = advanceInboundSchema.parse(raw)
      const asn = await store.mutate((snapshot) => advanceInbound(snapshot, asnId, to as InboundTransition))
      return ok({ ok: true, shipment: asn })
    }

    const body = receiveLineSchema.parse(raw)
    if (body.quantityReceived === 0 && (body.quantityRejected ?? 0) === 0) {
      throw ApiError.badRequest("Record at least one received or rejected unit.")
    }

    const result = await store.mutate((snapshot) =>
      receiveLine(snapshot, {
        asnId,
        lineId: body.lineId,
        quantityReceived: body.quantityReceived,
        quantityRejected: body.quantityRejected ?? 0,
        lot: body.lot ?? null,
        expiresAt: body.expiresAt ?? null,
        condition: body.condition,
        receivingLocationCode: body.receivingLocationCode,
        receivedBy: auth.user.username,
      }),
    )

    return ok({
      ok: true,
      line: result.line,
      shipmentStatus: result.asn.status,
      putawayTask: result.putaway,
    })
  },
)

export const dynamic = "force-dynamic"
