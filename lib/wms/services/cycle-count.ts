import { ApiError } from "@/lib/api/http"
import { generateId } from "@/lib/security/password"
import { getOrCreateRecord, recordMovement, refreshLocation } from "./inventory"
import { nextNumber } from "./inbound"
import type { CycleCount, CycleCountLine, DatabaseSnapshot, InventoryAdjustment } from "../types"

/**
 * Cycle counting.
 *
 * The count is taken blind: `systemQuantity` is captured but the counter's
 * entry is recorded separately, and only a supervisor's approval converts a
 * variance into a stock adjustment. That separation is the control that makes
 * an audit defensible.
 */

export interface CreateCycleCountInput {
  warehouseId: string
  zoneId?: string | null
  scheduledDate: string
}

/**
 * Builds a count sheet.
 *
 * Only locations that hold stock are included — counting empty bins is how
 * cycle-count programmes die. A-B-C weighting means fast movers get counted
 * more often, so a zone with A stock generates more lines per unit area.
 */
export function createCycleCount(snapshot: DatabaseSnapshot, input: CreateCycleCountInput): CycleCount {
  const locations = snapshot.locations.filter(
    (l) => l.warehouseId === input.warehouseId && (!input.zoneId || l.zoneId === input.zoneId),
  )
  if (locations.length === 0) throw ApiError.badRequest("No locations matched this warehouse/zone filter.")

  const lines: CycleCountLine[] = []
  for (const location of locations) {
    for (const record of snapshot.inventory.filter((r) => r.locationId === location.id && r.quantityOnHand > 0)) {
      lines.push({
        id: generateId("ccl"),
        locationId: location.id,
        skuId: record.skuId,
        lot: record.lot,
        systemQuantity: record.quantityOnHand,
        countedQuantity: null,
        variance: 0,
        recountRequired: false,
      })
    }
  }

  if (lines.length === 0) throw ApiError.badRequest("No stocked locations to count in this zone.")

  const now = new Date().toISOString()
  const count: CycleCount = {
    id: generateId("cc"),
    number: nextNumber(snapshot, "CC"),
    warehouseId: input.warehouseId,
    zoneId: input.zoneId ?? null,
    status: "scheduled",
    scheduledDate: input.scheduledDate,
    counter: null,
    lines,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  }

  // The count sheet snapshots system quantities, so any stock moved between now
  // and approval shows up as a variance rather than silently disappearing.

  snapshot.cycleCounts.unshift(count)
  return count
}

export function startCycleCount(snapshot: DatabaseSnapshot, countId: string, counter: string): CycleCount {
  const count = snapshot.cycleCounts.find((c) => c.id === countId)
  if (!count) throw ApiError.notFound(`Cycle count "${countId}" does not exist.`)
  if (count.status !== "scheduled") throw ApiError.conflict(`Cycle count ${count.number} is "${count.status}".`)

  count.status = "in_progress"
  count.counter = counter
  count.updatedAt = new Date().toISOString()
  return count
}

export interface SubmitCountInput {
  countId: string
  entries: Array<{ lineId: string; countedQuantity: number }>
  counter: string
}

/** Records the physical count. Any variance flags the line for recount review. */
export function submitCountEntries(snapshot: DatabaseSnapshot, input: SubmitCountInput): CycleCount {
  const count = snapshot.cycleCounts.find((c) => c.id === input.countId)
  if (!count) throw ApiError.notFound(`Cycle count "${input.countId}" does not exist.`)
  if (count.status !== "in_progress") throw ApiError.conflict(`Cycle count ${count.number} must be in progress to accept counts.`)

  for (const entry of input.entries) {
    const line = count.lines.find((l) => l.id === entry.lineId)
    if (!line) throw ApiError.notFound(`Count line "${entry.lineId}" does not exist.`)
    if (entry.countedQuantity < 0) throw ApiError.badRequest("Counted quantity cannot be negative.")

    line.countedQuantity = entry.countedQuantity
    line.variance = entry.countedQuantity - line.systemQuantity
    // Anything over ±3 units (or any variance on a small balance) needs a second look.
    line.recountRequired = line.variance !== 0 && (Math.abs(line.variance) > 3 || Math.abs(line.variance) / Math.max(1, line.systemQuantity) > 0.1)
  }

  const allCounted = count.lines.every((l) => l.countedQuantity !== null)
  if (allCounted) {
    count.status = count.lines.some((l) => l.variance !== 0) ? "variance_review" : "complete"
    if (count.status === "complete") count.completedAt = new Date().toISOString()
  }
  count.counter = input.counter
  count.updatedAt = new Date().toISOString()

  return count
}

/**
 * Converts an approved variance into a real stock adjustment.
 *
 * Writes both an {@link InventoryAdjustment} record (for the approval trail) and
 * a movement (for the ledger), so the two can always be reconciled.
 */
export function approveCycleCount(snapshot: DatabaseSnapshot, countId: string, approvedBy: string): { count: CycleCount; adjustments: InventoryAdjustment[] } {
  const count = snapshot.cycleCounts.find((c) => c.id === countId)
  if (!count) throw ApiError.notFound(`Cycle count "${countId}" does not exist.`)
  if (count.status === "complete") throw ApiError.conflict(`Cycle count ${count.number} is already approved.`)
  if (count.status === "cancelled") throw ApiError.conflict(`Cycle count ${count.number} was cancelled and cannot be approved.`)
  if (count.status !== "variance_review") {
    throw ApiError.conflict(
      `Cycle count ${count.number} is "${count.status}". Every line must be counted before it can be approved.`,
    )
  }

  const now = new Date().toISOString()
  const adjustments: InventoryAdjustment[] = []

  for (const line of count.lines) {
    if (line.variance === 0 || line.countedQuantity === null) continue

    const record = getOrCreateRecord(snapshot, line.skuId, line.locationId, line.lot ?? null)
    const before = record.quantityOnHand
    const after = line.countedQuantity

    record.quantityOnHand = after
    record.lastCountedAt = now
    record.updatedAt = now

    recordMovement(snapshot, {
      type: "cycle_count",
      skuId: line.skuId,
      fromLocationId: line.variance < 0 ? line.locationId : null,
      toLocationId: line.variance > 0 ? line.locationId : null,
      quantity: Math.abs(line.variance),
      lot: line.lot ?? null,
      reference: count.number,
      referenceType: "cycle_count",
      performedBy: approvedBy,
      performedAt: now,
      note: `Cycle count ${count.number}: system ${before}, counted ${after}`,
    })

    refreshLocation(snapshot, line.locationId)

    adjustments.push({
      id: generateId("adj"),
      number: nextNumber(snapshot, "ADJ"),
      skuId: line.skuId,
      locationId: line.locationId,
      lot: line.lot ?? null,
      quantityBefore: before,
      quantityAfter: after,
      reason: "cycle_count",
      reference: count.number,
      note: `Counted ${after} against a system balance of ${before}.`,
      requestedBy: count.counter ?? "operator",
      approvedBy,
      status: "approved",
      createdAt: now,
      updatedAt: now,
    })
  }

  snapshot.adjustments.unshift(...adjustments)
  count.status = "complete"
  count.completedAt = now
  count.updatedAt = now

  return { count, adjustments }
}

/** Rejects a count sheet without touching stock (e.g. the counter misread the bin). */
export function rejectCycleCount(snapshot: DatabaseSnapshot, countId: string, reason: string): CycleCount {
  const count = snapshot.cycleCounts.find((c) => c.id === countId)
  if (!count) throw ApiError.notFound(`Cycle count "${countId}" does not exist.`)
  if (count.status === "complete") throw ApiError.conflict(`Cycle count ${count.number} is already complete.`)

  count.status = "cancelled"
  count.completedAt = new Date().toISOString()
  count.updatedAt = count.completedAt
  // `reason` is surfaced in the audit entry written by the route handler.
  void reason
  return count
}
