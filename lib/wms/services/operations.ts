import { ApiError } from "@/lib/api/http"
import { generateId } from "@/lib/security/password"
import { findLocation, findSku, getOrCreateRecord, recordMovement, refreshLocation } from "./inventory"
import { nextNumber } from "./inbound"
import type { DatabaseSnapshot, ReplenishmentTask, ReturnAuthorization, ReturnDisposition } from "../types"

/**
 * Replenishment and returns.
 *
 * Replenishment keeps pick faces full from bulk reserve — the single highest-
 * leverage automation in a picking operation, because a picker standing at an
 * empty bin is the most expensive idle time in a warehouse.
 */

// ---------------------------------------------------------------------------
// Replenishment
// ---------------------------------------------------------------------------

/**
 * Generates replenishment tasks for pick faces that fell to their minimum.
 *
 * Returns the tasks it created so the caller can report them. Running it twice
 * is safe: an open task for the same SKU/location pair suppresses a duplicate.
 */
export function generateReplenishment(snapshot: DatabaseSnapshot, warehouseId: string, performedBy: string): ReplenishmentTask[] {
  const created: ReplenishmentTask[] = []
  const now = new Date().toISOString()

  for (const sku of snapshot.skus.filter((s) => s.active)) {
    const faces = snapshot.locations.filter(
      (l) => l.warehouseId === warehouseId && l.pickFace && l.status !== "blocked",
    )

    for (const face of faces) {
      const faceRecord = snapshot.inventory.find((r) => r.skuId === sku.id && r.locationId === face.id)
      if (!faceRecord) continue

      const available = faceRecord.quantityOnHand - faceRecord.quantityAllocated - faceRecord.quantityReserved
      if (available > sku.minStock) continue

      // Don't stack a second open task for the same SKU/face.
      const alreadyOpen = snapshot.replenishmentTasks.some(
        (t) => t.skuId === sku.id && t.toLocationId === face.id && t.status !== "complete" && t.status !== "cancelled",
      )
      if (alreadyOpen) continue

      // Source from the fullest bulk location holding this SKU.
      const bulk = snapshot.inventory
        .filter((r) => {
          if (r.skuId !== sku.id || r.locationId === face.id) return false
          const location = snapshot.locations.find((l) => l.id === r.locationId)
          return Boolean(location && !location.pickFace && r.quantityOnHand - r.quantityAllocated > 0)
        })
        .sort((a, b) => b.quantityOnHand - a.quantityOnHand)[0]

      if (!bulk) continue

      const bulkLocation = snapshot.locations.find((l) => l.id === bulk.locationId)
      const capacityHeadroom = face.capacityKg === 0 ? Number.POSITIVE_INFINITY : Math.max(0, face.capacityKg - face.currentWeightKg)
      const maxByCapacity = Math.floor(capacityHeadroom / Math.max(0.001, sku.dimensions.weightKg))
      const wanted = Math.min(sku.maxStock - available, maxByCapacity, bulk.quantityOnHand - bulk.quantityAllocated)

      if (wanted <= 0) continue

      created.push({
        id: generateId("rep"),
        number: nextNumber(snapshot, "REP"),
        skuId: sku.id,
        fromLocationId: bulk.locationId,
        toLocationId: face.id,
        quantity: wanted,
        trigger: "min_stock",
        status: "pending",
        assignedTo: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      })
    }
  }

  snapshot.replenishmentTasks.unshift(...created)
  void performedBy
  return created
}

/** Executes a replenishment: moves stock from bulk into the pick face. */
export function executeReplenishment(snapshot: DatabaseSnapshot, taskId: string, performedBy: string): ReplenishmentTask {
  const task = snapshot.replenishmentTasks.find((t) => t.id === taskId)
  if (!task) throw ApiError.notFound(`Replenishment task "${taskId}" does not exist.`)
  if (task.status === "complete") throw ApiError.conflict(`Replenishment task ${task.number} is already complete.`)

  const now = new Date().toISOString()
  const source = snapshot.inventory.find(
    (r) => r.skuId === task.skuId && r.locationId === task.fromLocationId,
  )
  if (!source) throw ApiError.conflict(`No stock for this SKU at the source location.`)

  const available = source.quantityOnHand - source.quantityAllocated - source.quantityReserved
  const quantity = Math.min(task.quantity, available)
  if (quantity <= 0) throw ApiError.conflict("The source location has no uncommitted stock to replenish from.")

  source.quantityOnHand -= quantity
  source.updatedAt = now

  const destination = getOrCreateRecord(snapshot, task.skuId, task.toLocationId, source.lot)
  destination.quantityOnHand += quantity
  destination.updatedAt = now

  recordMovement(snapshot, {
    type: "replenishment",
    skuId: task.skuId,
    fromLocationId: task.fromLocationId,
    toLocationId: task.toLocationId,
    quantity,
    lot: source.lot,
    reference: task.number,
    referenceType: "replenishment_task",
    performedBy,
    performedAt: now,
  })

  refreshLocation(snapshot, task.fromLocationId)
  refreshLocation(snapshot, task.toLocationId)

  task.quantity = quantity
  task.status = "complete"
  task.assignedTo = performedBy
  task.completedAt = now
  task.updatedAt = now
  return task
}

// ---------------------------------------------------------------------------
// Returns (RMA)
// ---------------------------------------------------------------------------

export interface CreateReturnInput {
  orderId?: string | null
  customerId: string
  warehouseId: string
  skuId: string
  quantity: number
  reason: ReturnAuthorization["reason"]
}

export function createReturn(snapshot: DatabaseSnapshot, input: CreateReturnInput): ReturnAuthorization {
  const customer = snapshot.customers.find((c) => c.id === input.customerId)
  if (!customer) throw ApiError.notFound(`Customer "${input.customerId}" does not exist.`)
  const sku = findSku(snapshot, input.skuId)
  if (input.quantity <= 0) throw ApiError.badRequest("Return quantity must be greater than zero.")

  if (input.orderId) {
    const order = snapshot.salesOrders.find((o) => o.id === input.orderId)
    if (!order) throw ApiError.notFound(`Sales order "${input.orderId}" does not exist.`)
    const line = order.lines.find((l) => l.skuId === sku.id)
    const alreadyReturning = snapshot.returns
      .filter((r) => r.orderId === order.id && r.skuId === sku.id && r.status !== "rejected")
      .reduce((sum, r) => sum + r.quantity, 0)
    const shipped = line?.quantityPacked ?? 0
    if (alreadyReturning + input.quantity > shipped) {
      throw ApiError.conflict(
        `Only ${shipped - alreadyReturning} unit(s) of ${sku.code} on ${order.number} remain eligible for return.`,
      )
    }
  }

  const now = new Date().toISOString()
  const rma: ReturnAuthorization = {
    id: generateId("rma"),
    number: nextNumber(snapshot, "RMA"),
    orderId: input.orderId ?? null,
    customerId: customer.id,
    warehouseId: input.warehouseId,
    skuId: sku.id,
    quantity: input.quantity,
    reason: input.reason,
    disposition: null,
    status: "requested",
    lot: null,
    reviewedBy: null,
    receivedAt: null,
    createdAt: now,
    updatedAt: now,
  }

  snapshot.returns.unshift(rma)
  return rma
}

export function reviewReturn(snapshot: DatabaseSnapshot, rmaId: string, approve: boolean, reviewedBy: string): ReturnAuthorization {
  const rma = snapshot.returns.find((r) => r.id === rmaId)
  if (!rma) throw ApiError.notFound(`Return "${rmaId}" does not exist.`)
  if (rma.status !== "requested") throw ApiError.conflict(`Return ${rma.number} is "${rma.status}" and cannot be reviewed.`)

  rma.status = approve ? "approved" : "rejected"
  rma.reviewedBy = reviewedBy
  rma.updatedAt = new Date().toISOString()
  return rma
}

/**
 * Receives a returned item back into stock.
 *
 * Disposition decides where it lands: `restock` returns it to saleable stock,
 * everything else parks it in the returns location as reserved until a human
 * decides what to do with it.
 */
export function receiveReturn(snapshot: DatabaseSnapshot, rmaId: string, disposition: ReturnDisposition, locationCode: string, receivedBy: string): ReturnAuthorization {
  const rma = snapshot.returns.find((r) => r.id === rmaId)
  if (!rma) throw ApiError.notFound(`Return "${rmaId}" does not exist.`)
  if (rma.status !== "approved") throw ApiError.conflict(`Return ${rma.number} must be approved before receipt (it is "${rma.status}").`)

  const now = new Date().toISOString()
  const sku = findSku(snapshot, rma.skuId)

  if (disposition === "restock") {
    const location = findLocation(snapshot, locationCode)
    const record = getOrCreateRecord(snapshot, sku.id, location.id, rma.lot)
    record.quantityOnHand += rma.quantity
    record.updatedAt = now

    recordMovement(snapshot, {
      type: "return",
      skuId: sku.id,
      fromLocationId: null,
      toLocationId: location.id,
      quantity: rma.quantity,
      lot: rma.lot,
      reference: rma.number,
      referenceType: "return",
      performedBy: receivedBy,
      performedAt: now,
      note: `Returned item restocked (${rma.reason})`,
    })
    refreshLocation(snapshot, location.id)
  } else {
    // Hold in the returns area, reserved, so it never shows as saleable.
    const returnsLocation =
      snapshot.locations.find((l) => l.warehouseId === rma.warehouseId && l.zoneId.endsWith("_ret")) ??
      findLocation(snapshot, locationCode)

    const record = getOrCreateRecord(snapshot, sku.id, returnsLocation.id, rma.lot)
    record.quantityOnHand += rma.quantity
    record.quantityReserved += rma.quantity
    record.updatedAt = now

    recordMovement(snapshot, {
      type: "return",
      skuId: sku.id,
      fromLocationId: null,
      toLocationId: returnsLocation.id,
      quantity: rma.quantity,
      lot: rma.lot,
      reference: rma.number,
      referenceType: "return",
      performedBy: receivedBy,
      performedAt: now,
      note: `Return held for ${disposition}`,
    })
    refreshLocation(snapshot, returnsLocation.id)
  }

  rma.disposition = disposition
  rma.status = "processed"
  rma.receivedAt = now
  rma.updatedAt = now
  return rma
}
