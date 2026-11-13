import { ApiError } from "@/lib/api/http"
import { generateId } from "@/lib/security/password"
import { availableQuantity } from "../types"
import type {
  AdjustmentReason,
  DatabaseSnapshot,
  InventoryRecord,
  Location,
  Movement,
  MovementType,
  Sku,
} from "../types"

/**
 * Inventory service.
 *
 * Every function takes the snapshot it should mutate and returns the result.
 * Route handlers wrap calls in `store.mutate(...)` so a whole operation is
 * applied under one lock — that is what stops two operators picking the same
 * last unit at the same moment.
 */

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function findLocation(snapshot: DatabaseSnapshot, idOrCode: string): Location {
  const needle = idOrCode.trim().toUpperCase()
  const found = snapshot.locations.find((l) => l.id === idOrCode || l.code.toUpperCase() === needle)
  if (!found) throw ApiError.notFound(`Location "${idOrCode}" does not exist.`)
  return found
}

export function findSku(snapshot: DatabaseSnapshot, idOrCode: string): Sku {
  const needle = idOrCode.trim().toUpperCase()
  const found = snapshot.skus.find((s) => s.id === idOrCode || s.code.toUpperCase() === needle || s.barcode === idOrCode.trim())
  if (!found) throw ApiError.notFound(`SKU "${idOrCode}" does not exist.`)
  return found
}

/**
 * The inventory record for a SKU at a location (and lot).
 * Creates one on first touch so callers never have to check for absence.
 */
export function getOrCreateRecord(
  snapshot: DatabaseSnapshot,
  skuId: string,
  locationId: string,
  lot: string | null = null,
): InventoryRecord {
  const location = snapshot.locations.find((l) => l.id === locationId)
  if (!location) throw ApiError.notFound(`Location "${locationId}" does not exist.`)

  let record = snapshot.inventory.find(
    (r) => r.skuId === skuId && r.locationId === locationId && (r.lot ?? null) === (lot ?? null),
  )

  if (!record) {
    const now = new Date().toISOString()
    record = {
      id: generateId("inv"),
      warehouseId: location.warehouseId,
      skuId,
      locationId,
      lot,
      quantityOnHand: 0,
      quantityAllocated: 0,
      quantityReserved: 0,
      quantityDamaged: 0,
      receivedAt: now,
      expiresAt: null,
      lastCountedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    snapshot.inventory.push(record)
  }

  return record
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export function recordMovement(snapshot: DatabaseSnapshot, input: Omit<Movement, "id" | "createdAt" | "updatedAt">): Movement {
  const now = new Date().toISOString()
  const movement: Movement = { ...input, id: generateId("mov"), createdAt: now, updatedAt: now }
  snapshot.movements.unshift(movement)

  // Bound the ledger so a long-running instance cannot grow without limit.
  const MAX_MOVEMENTS = 20_000
  if (snapshot.movements.length > MAX_MOVEMENTS) {
    snapshot.movements.length = MAX_MOVEMENTS
  }

  return movement
}

/** Keeps `Location.status` and `currentWeightKg` consistent after a quantity change. */
export function refreshLocation(snapshot: DatabaseSnapshot, locationId: string): void {
  const location = snapshot.locations.find((l) => l.id === locationId)
  if (!location) return

  const records = snapshot.inventory.filter((r) => r.locationId === locationId)
  const totalUnits = records.reduce((sum, r) => sum + r.quantityOnHand, 0)
  const weight = records.reduce((sum, r) => {
    const sku = snapshot.skus.find((s) => s.id === r.skuId)
    return sum + r.quantityOnHand * (sku?.dimensions.weightKg ?? 0)
  }, 0)

  location.currentWeightKg = Math.round(weight * 10) / 10
  if (location.status === "blocked") return
  location.status = totalUnits > 0 ? "occupied" : "empty"
  location.updatedAt = new Date().toISOString()
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface AdjustInput {
  skuId: string
  locationId: string
  lot?: string | null
  /** Signed delta. Negative reduces stock, positive increases it. */
  delta: number
  reason: AdjustmentReason
  reference: string
  note?: string
  performedBy: string
}

/**
 * Applies a stock adjustment.
 *
 * Guards against driving available stock negative: a correction that would
 * oversell is rejected rather than silently clamped, because an inventory
 * balance that lies is worse than an error message.
 */
export function adjustInventory(snapshot: DatabaseSnapshot, input: AdjustInput): InventoryRecord {
  const record = getOrCreateRecord(snapshot, input.skuId, input.locationId, input.lot ?? null)
  const before = record.quantityOnHand
  const after = before + input.delta

  if (after < 0) {
    throw ApiError.conflict(
      `Cannot adjust to ${after}: only ${before} on hand at this location${input.lot ? ` for lot ${input.lot}` : ""}.`,
    )
  }
  if (after - record.quantityAllocated - record.quantityReserved < 0) {
    throw ApiError.conflict(
      `Adjustment would leave ${after} on hand against ${record.quantityAllocated} allocated and ${record.quantityReserved} reserved. Release those commitments first.`,
    )
  }

  record.quantityOnHand = after
  record.updatedAt = new Date().toISOString()

  recordMovement(snapshot, {
    type: "adjustment",
    skuId: input.skuId,
    fromLocationId: input.delta < 0 ? input.locationId : null,
    toLocationId: input.delta >= 0 ? input.locationId : null,
    quantity: Math.abs(input.delta),
    lot: record.lot,
    reference: input.reference,
    referenceType: "adjustment",
    performedBy: input.performedBy,
    performedAt: record.updatedAt,
    note: input.note ?? input.reason,
  })

  refreshLocation(snapshot, input.locationId)
  return record
}

export interface TransferInput {
  skuId: string
  fromLocationId: string
  toLocationId: string
  lot?: string | null
  quantity: number
  reference: string
  performedBy: string
  note?: string
}

/** Moves stock between locations, keeping both records and the ledger in step. */
export function transferInventory(snapshot: DatabaseSnapshot, input: TransferInput): { from: InventoryRecord; to: InventoryRecord } {
  if (input.fromLocationId === input.toLocationId) {
    throw ApiError.badRequest("Source and destination locations are the same.")
  }
  if (input.quantity <= 0) throw ApiError.badRequest("Transfer quantity must be greater than zero.")

  const toLocation = findLocation(snapshot, input.toLocationId)
  if (toLocation.status === "blocked") {
    throw ApiError.conflict(`Location ${toLocation.code} is blocked and cannot receive stock.`)
  }

  const from = getOrCreateRecord(snapshot, input.skuId, input.fromLocationId, input.lot ?? null)
  const available = availableQuantity(from)
  if (input.quantity > available) {
    throw ApiError.conflict(
      `Only ${available} uncommitted unit(s) of this SKU at ${findLocation(snapshot, input.fromLocationId).code}.`,
    )
  }

  from.quantityOnHand -= input.quantity
  from.updatedAt = new Date().toISOString()

  const to = getOrCreateRecord(snapshot, input.skuId, input.toLocationId, input.lot ?? null)
  to.quantityOnHand += input.quantity
  to.updatedAt = new Date().toISOString()

  recordMovement(snapshot, {
    type: "transfer",
    skuId: input.skuId,
    fromLocationId: input.fromLocationId,
    toLocationId: input.toLocationId,
    quantity: input.quantity,
    lot: input.lot ?? null,
    reference: input.reference,
    referenceType: "transfer",
    performedBy: input.performedBy,
    performedAt: new Date().toISOString(),
    note: input.note,
  })

  refreshLocation(snapshot, input.fromLocationId)
  refreshLocation(snapshot, input.toLocationId)

  return { from, to }
}

/**
 * Reserves (allocates) stock against an outbound order.
 * Allocation does not move stock — it only marks it committed.
 */
export function allocateStock(snapshot: DatabaseSnapshot, skuId: string, quantity: number): InventoryRecord[] {
  const sku = snapshot.skus.find((s) => s.id === skuId)
  if (!sku) throw ApiError.notFound(`SKU "${skuId}" does not exist.`)

  // FEFO: oldest-expiring / earliest-received first, pick faces before reserve
  // so the picker travels less.
  const candidates = snapshot.inventory
    .filter((r) => r.skuId === skuId && availableQuantity(r) > 0)
    .sort((a, b) => {
      const aFace = isPickFace(snapshot, a.locationId) ? 0 : 1
      const bFace = isPickFace(snapshot, b.locationId) ? 0 : 1
      if (aFace !== bFace) return aFace - bFace
      const aExp = a.expiresAt ? Date.parse(a.expiresAt) : Number.POSITIVE_INFINITY
      const bExp = b.expiresAt ? Date.parse(b.expiresAt) : Number.POSITIVE_INFINITY
      if (aExp !== bExp) return aExp - bExp
      return Date.parse(a.receivedAt) - Date.parse(b.receivedAt)
    })

  let remaining = quantity
  const allocations: InventoryRecord[] = []

  for (const record of candidates) {
    if (remaining <= 0) break
    const take = Math.min(remaining, availableQuantity(record))
    if (take <= 0) continue
    record.quantityAllocated += take
    record.updatedAt = new Date().toISOString()
    remaining -= take
    allocations.push(record)
  }

  if (remaining > 0) {
    throw ApiError.conflict(
      `Insufficient available stock for ${sku.code}: requested ${quantity}, short by ${remaining}.`,
      { skuCode: sku.code, requested: quantity, shortBy: remaining },
    )
  }

  return allocations
}

export function deallocateStock(snapshot: DatabaseSnapshot, skuId: string, quantity: number): void {
  let remaining = quantity
  const records = snapshot.inventory
    .filter((r) => r.skuId === skuId && r.quantityAllocated > 0)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))

  for (const record of records) {
    if (remaining <= 0) break
    const release = Math.min(remaining, record.quantityAllocated)
    record.quantityAllocated -= release
    record.updatedAt = new Date().toISOString()
    remaining -= release
  }
}

export function isPickFace(snapshot: DatabaseSnapshot, locationId: string): boolean {
  return snapshot.locations.find((l) => l.id === locationId)?.pickFace ?? false
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

export interface SkuBalance {
  skuId: string
  code: string
  name: string
  category: string
  uom: string
  abcClass: string
  onHand: number
  allocated: number
  reserved: number
  damaged: number
  available: number
  locations: number
  reorderPoint: number
  /** True when available stock is at or below the reorder point. */
  belowReorderPoint: boolean
  stockValue: number
}

/** Rolls the per-location records up into one row per SKU. */
export function skuBalances(snapshot: DatabaseSnapshot): SkuBalance[] {
  const bySku = new Map<string, SkuBalance>()

  for (const sku of snapshot.skus) {
    bySku.set(sku.id, {
      skuId: sku.id,
      code: sku.code,
      name: sku.name,
      category: sku.category,
      uom: sku.uom,
      abcClass: sku.abcClass,
      onHand: 0,
      allocated: 0,
      reserved: 0,
      damaged: 0,
      available: 0,
      locations: 0,
      reorderPoint: sku.reorderPoint,
      belowReorderPoint: false,
      stockValue: 0,
    })
  }

  for (const record of snapshot.inventory) {
    const balance = bySku.get(record.skuId)
    if (!balance) continue
    balance.onHand += record.quantityOnHand
    balance.allocated += record.quantityAllocated
    balance.reserved += record.quantityReserved
    balance.damaged += record.quantityDamaged
    balance.available += availableQuantity(record)
    if (record.quantityOnHand > 0) balance.locations += 1
  }

  for (const balance of bySku.values()) {
    balance.belowReorderPoint = balance.available <= balance.reorderPoint
    const sku = snapshot.skus.find((s) => s.id === balance.skuId)
    balance.stockValue = Math.round(balance.onHand * (sku?.cost ?? 0) * 100) / 100
  }

  return [...bySku.values()]
}

/** SKUs at or below their reorder point, worst first. */
export function lowStock(snapshot: DatabaseSnapshot): SkuBalance[] {
  return skuBalances(snapshot)
    .filter((b) => b.belowReorderPoint && b.onHand > 0)
    .sort((a, b) => a.available / Math.max(1, a.reorderPoint) - b.available / Math.max(1, b.reorderPoint))
}

/** Records inside their expiry window, soonest first. */
export function expiringSoon(snapshot: DatabaseSnapshot, withinDays = 30): Array<InventoryRecord & { skuCode: string; daysToExpiry: number }> {
  const cutoff = Date.now() + withinDays * 86_400_000
  return snapshot.inventory
    .filter((r) => r.expiresAt && Date.parse(r.expiresAt) <= cutoff && r.quantityOnHand > 0)
    .map((r) => ({
      ...r,
      skuCode: snapshot.skus.find((s) => s.id === r.skuId)?.code ?? "UNKNOWN",
      daysToExpiry: Math.ceil((Date.parse(r.expiresAt as string) - Date.now()) / 86_400_000),
    }))
    .sort((a, b) => a.daysToExpiry - b.daysToExpiry)
}

/** Movement ledger filtered to a single SKU, newest first. */
export function movementsForSku(snapshot: DatabaseSnapshot, skuId: string, limit = 50): Movement[] {
  return snapshot.movements.filter((m) => m.skuId === skuId).slice(0, limit)
}

/** Sums a movement type over a window — used by the dashboard throughput widget. */
export function movementThroughput(snapshot: DatabaseSnapshot, type: MovementType, days: number): number {
  const cutoff = Date.now() - days * 86_400_000
  return snapshot.movements
    .filter((m) => m.type === type && Date.parse(m.performedAt) >= cutoff)
    .reduce((sum, m) => sum + m.quantity, 0)
}
