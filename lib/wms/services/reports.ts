import { availableQuantity } from "../types"
import { expiringSoon, lowStock, skuBalances } from "./inventory"
import type { DatabaseSnapshot, Shipment, Wave } from "../types"

/**
 * Reporting and KPI aggregation.
 *
 * Everything here is derived, never stored, so a figure can always be
 * recomputed from the ledger if somebody questions it.
 */

const DAY_MS = 86_400_000

export interface KpiSummary {
  totalSkus: number
  activeSkus: number
  totalUnitsOnHand: number
  availableUnits: number
  allocatedUnits: number
  reservedUnits: number
  damagedUnits: number
  stockValue: number
  locations: number
  occupiedLocations: number
  blockedLocations: number
  utilisationPercent: number
  lowStockCount: number
  expiringCount: number
  pendingPutaway: number
  openPickTasks: number
  ordersAwaitingShip: number
  ordersShippedToday: number
  cycleCountsPending: number
  pendingAdjustments: number
  openReturns: number
  openReplenishments: number
}

export function kpiSummary(snapshot: DatabaseSnapshot): KpiSummary {
  const units = snapshot.inventory.reduce(
    (acc, r) => {
      acc.onHand += r.quantityOnHand
      acc.allocated += r.quantityAllocated
      acc.reserved += r.quantityReserved
      acc.damaged += r.quantityDamaged
      acc.available += availableQuantity(r)
      return acc
    },
    { onHand: 0, allocated: 0, reserved: 0, damaged: 0, available: 0 },
  )

  const occupied = snapshot.locations.filter((l) => l.status === "occupied").length
  const blocked = snapshot.locations.filter((l) => l.status === "blocked").length

  const balances = skuBalances(snapshot)
  const today = startOfToday()

  return {
    totalSkus: snapshot.skus.length,
    activeSkus: snapshot.skus.filter((s) => s.active).length,
    totalUnitsOnHand: units.onHand,
    availableUnits: units.available,
    allocatedUnits: units.allocated,
    reservedUnits: units.reserved,
    damagedUnits: units.damaged,
    stockValue: Math.round(balances.reduce((sum, b) => sum + b.stockValue, 0) * 100) / 100,
    locations: snapshot.locations.length,
    occupiedLocations: occupied,
    blockedLocations: blocked,
    utilisationPercent: snapshot.locations.length === 0 ? 0 : Math.round((occupied / snapshot.locations.length) * 1000) / 10,
    lowStockCount: lowStock(snapshot).length,
    expiringCount: expiringSoon(snapshot).length,
    pendingPutaway: snapshot.putawayTasks.filter((t) => t.status === "pending" || t.status === "in_progress").length,
    openPickTasks: snapshot.pickTasks.filter((t) => t.status === "pending" || t.status === "in_progress").length,
    ordersAwaitingShip: snapshot.salesOrders.filter((o) => ["new", "allocated", "picking", "packed"].includes(o.status)).length,
    ordersShippedToday: snapshot.shipments.filter((s) => Date.parse(s.shippedAt) >= today).length,
    cycleCountsPending: snapshot.cycleCounts.filter((c) => ["scheduled", "in_progress", "variance_review"].includes(c.status)).length,
    pendingAdjustments: snapshot.adjustments.filter((a) => a.status === "pending_approval").length,
    openReturns: snapshot.returns.filter((r) => ["requested", "approved", "received"].includes(r.status)).length,
    openReplenishments: snapshot.replenishmentTasks.filter((t) => t.status === "pending" || t.status === "in_progress").length,
  }
}

function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Daily received/shipped unit counts for the throughput chart. */
export function throughputSeries(snapshot: DatabaseSnapshot, days = 14): Array<{ date: string; received: number; shipped: number; picked: number }> {
  const series: Array<{ date: string; received: number; shipped: number; picked: number }> = []

  for (let offset = days - 1; offset >= 0; offset--) {
    const day = new Date(Date.now() - offset * DAY_MS)
    day.setHours(0, 0, 0, 0)
    const next = day.getTime() + DAY_MS

    const inWindow = (iso: string) => {
      const t = Date.parse(iso)
      return t >= day.getTime() && t < next
    }

    series.push({
      date: day.toISOString().slice(0, 10),
      received: snapshot.movements.filter((m) => m.type === "receipt" && inWindow(m.performedAt)).reduce((s, m) => s + m.quantity, 0),
      shipped: snapshot.movements.filter((m) => m.type === "ship" && inWindow(m.performedAt)).reduce((s, m) => s + m.quantity, 0),
      picked: snapshot.movements.filter((m) => m.type === "pick" && inWindow(m.performedAt)).reduce((s, m) => s + m.quantity, 0),
    })
  }

  return series
}

/** Stock split by category for the composition widget. */
export function stockByCategory(snapshot: DatabaseSnapshot): Array<{ category: string; units: number; value: number }> {
  const map = new Map<string, { units: number; value: number }>()

  for (const record of snapshot.inventory) {
    const sku = snapshot.skus.find((s) => s.id === record.skuId)
    if (!sku) continue
    const entry = map.get(sku.category) ?? { units: 0, value: 0 }
    entry.units += record.quantityOnHand
    entry.value += record.quantityOnHand * sku.cost
    map.set(sku.category, entry)
  }

  return [...map.entries()]
    .map(([category, v]) => ({ category, units: v.units, value: Math.round(v.value * 100) / 100 }))
    .sort((a, b) => b.value - a.value)
}

/** Units moved per operator — the productivity leaderboard. */
export function productivityByOperator(snapshot: DatabaseSnapshot, days = 14): Array<{ operator: string; picks: number; putaways: number; replenishments: number; units: number }> {
  const cutoff = Date.now() - days * DAY_MS
  const map = new Map<string, { picks: number; putaways: number; replenishments: number; units: number }>()

  for (const movement of snapshot.movements) {
    if (Date.parse(movement.performedAt) < cutoff) continue
    if (!["pick", "putaway", "replenishment"].includes(movement.type)) continue

    const entry = map.get(movement.performedBy) ?? { picks: 0, putaways: 0, replenishments: 0, units: 0 }
    if (movement.type === "pick") entry.picks += 1
    if (movement.type === "putaway") entry.putaways += 1
    if (movement.type === "replenishment") entry.replenishments += 1
    entry.units += movement.quantity
    map.set(movement.performedBy, entry)
  }

  return [...map.entries()]
    .map(([operator, v]) => ({ operator, ...v }))
    .sort((a, b) => b.units - a.units)
}

/** Zone fill-rate table — where the space is going. */
export function zoneUtilisation(snapshot: DatabaseSnapshot): Array<{ zone: string; warehouse: string; locations: number; occupied: number; percent: number }> {
  return snapshot.zones
    .map((zone) => {
      const locations = snapshot.locations.filter((l) => l.zoneId === zone.id)
      const occupied = locations.filter((l) => l.status === "occupied").length
      return {
        zone: `${snapshot.warehouses.find((w) => w.id === zone.warehouseId)?.code ?? "?"}/${zone.code}`,
        warehouse: snapshot.warehouses.find((w) => w.id === zone.warehouseId)?.name ?? "Unknown",
        locations: locations.length,
        occupied,
        percent: locations.length === 0 ? 0 : Math.round((occupied / locations.length) * 1000) / 10,
      }
    })
    .filter((row) => row.locations > 0)
    .sort((a, b) => b.percent - a.percent)
}

/** Order status distribution for the pipeline widget. */
export function orderPipeline(snapshot: DatabaseSnapshot): Array<{ status: string; count: number }> {
  const counts = new Map<string, number>()
  for (const order of snapshot.salesOrders) {
    counts.set(order.status, (counts.get(order.status) ?? 0) + 1)
  }
  return [...counts.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count)
}

/** Wave ageing — how long released waves have been open. */
export function waveAgeing(snapshot: DatabaseSnapshot): Array<{ wave: Wave; openHours: number; pickTasksOpen: number }> {
  return snapshot.waves
    .filter((w) => w.status === "released" || w.status === "picking")
    .map((wave) => ({
      wave,
      openHours: Math.round(((Date.now() - Date.parse(wave.releasedAt ?? wave.createdAt)) / 3_600_000) * 10) / 10,
      pickTasksOpen: snapshot.pickTasks.filter((t) => t.waveId === wave.id && (t.status === "pending" || t.status === "in_progress")).length,
    }))
    .sort((a, b) => b.openHours - a.openHours)
}

/** Carrier performance over a window. */
export function carrierPerformance(snapshot: DatabaseSnapshot, days = 30): Array<{ carrier: string; shipments: number; delivered: number; inTransit: number; exceptions: number }> {
  const cutoff = Date.now() - days * DAY_MS
  const map = new Map<string, { shipments: number; delivered: number; inTransit: number; exceptions: number }>()

  for (const shipment of snapshot.shipments.filter((s: Shipment) => Date.parse(s.shippedAt) >= cutoff)) {
    const entry = map.get(shipment.carrier) ?? { shipments: 0, delivered: 0, inTransit: 0, exceptions: 0 }
    entry.shipments += 1
    if (shipment.status === "delivered") entry.delivered += 1
    if (shipment.status === "in_transit" || shipment.status === "manifested") entry.inTransit += 1
    if (shipment.status === "exception") entry.exceptions += 1
    map.set(shipment.carrier, entry)
  }

  return [...map.entries()].map(([carrier, v]) => ({ carrier, ...v })).sort((a, b) => b.shipments - a.shipments)
}

/** Inventory accuracy from completed cycle counts — the headline WMS metric. */
export function inventoryAccuracy(snapshot: DatabaseSnapshot): { counts: number; linesCounted: number; accurateLines: number; accuracyPercent: number; netVariance: number } {
  const completed = snapshot.cycleCounts.filter((c) => c.status === "complete" || c.status === "variance_review")
  const lines = completed.flatMap((c) => c.lines.filter((l) => l.countedQuantity !== null))

  const accurateLines = lines.filter((l) => l.variance === 0).length
  const netVariance = lines.reduce((sum, l) => sum + l.variance, 0)

  return {
    counts: completed.length,
    linesCounted: lines.length,
    accurateLines,
    accuracyPercent: lines.length === 0 ? 100 : Math.round((accurateLines / lines.length) * 1000) / 10,
    netVariance,
  }
}
