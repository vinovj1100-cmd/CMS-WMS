import { ApiError } from "@/lib/api/http"
import { generateId } from "@/lib/security/password"
import { allocateStock, deallocateStock, findLocation, findSku, getOrCreateRecord, recordMovement, refreshLocation } from "./inventory"
import { nextNumber } from "./inbound"
import type {
  DatabaseSnapshot,
  PackRecord,
  PickTask,
  SalesOrder,
  Shipment,
  Wave,
  WaveStrategy,
} from "../types"

/**
 * Outbound flow: sales order → allocation → wave → pick → pack → ship.
 *
 * Allocation reserves stock; picking physically removes it; shipping writes the
 * ledger entry that decrements on-hand. Keeping those separate is what allows a
 * short pick or a cancelled order to be reversed cleanly.
 */

// ---------------------------------------------------------------------------
// Sales orders
// ---------------------------------------------------------------------------

export interface CreateSalesOrderInput {
  customerId: string
  warehouseId: string
  requiredDate: string
  carrier: string
  lines: Array<{ skuId: string; quantityOrdered: number }>
}

export function createSalesOrder(snapshot: DatabaseSnapshot, input: CreateSalesOrderInput): SalesOrder {
  const customer = snapshot.customers.find((c) => c.id === input.customerId)
  if (!customer) throw ApiError.notFound(`Customer "${input.customerId}" does not exist.`)
  if (input.lines.length === 0) throw ApiError.badRequest("A sales order needs at least one line.")

  const now = new Date().toISOString()
  const order: SalesOrder = {
    id: generateId("so"),
    number: nextNumber(snapshot, "SO"),
    customerId: customer.id,
    warehouseId: input.warehouseId,
    status: "new",
    priority: customer.priority,
    requiredDate: input.requiredDate,
    waveId: null,
    carrier: input.carrier,
    trackingNumber: null,
    lines: input.lines.map((line) => {
      const sku = findSku(snapshot, line.skuId)
      if (line.quantityOrdered <= 0) throw ApiError.badRequest(`Quantity for ${sku.code} must be greater than zero.`)
      return {
        id: generateId("sol"),
        skuId: sku.id,
        quantityOrdered: line.quantityOrdered,
        quantityAllocated: 0,
        quantityPicked: 0,
        quantityPacked: 0,
      }
    }),
    cancelledReason: null,
    createdAt: now,
    updatedAt: now,
  }

  snapshot.salesOrders.unshift(order)
  return order
}

/**
 * Reserves stock for every line on an order.
 *
 * All-or-nothing: if any line cannot be fully satisfied the whole allocation is
 * rolled back and the order is marked backordered. A partially allocated order
 * is a warehouse problem — the picker discovers the shortage at the rack.
 */
export function allocateOrder(snapshot: DatabaseSnapshot, orderId: string): SalesOrder {
  const order = snapshot.salesOrders.find((o) => o.id === orderId)
  if (!order) throw ApiError.notFound(`Sales order "${orderId}" does not exist.`)
  if (order.status === "cancelled") throw ApiError.conflict(`Sales order ${order.number} is cancelled.`)
  if (!["new", "backordered"].includes(order.status)) {
    throw ApiError.conflict(`Sales order ${order.number} is already "${order.status}".`)
  }

  const attempted: Array<{ skuId: string; quantity: number }> = []

  try {
    for (const line of order.lines) {
      if (line.quantityAllocated >= line.quantityOrdered) continue
      const needed = line.quantityOrdered - line.quantityAllocated
      allocateStock(snapshot, line.skuId, needed)
      attempted.push({ skuId: line.skuId, quantity: needed })
      line.quantityAllocated = line.quantityOrdered
    }
  } catch (error) {
    // Roll back everything already reserved for this order.
    for (const entry of attempted) deallocateStock(snapshot, entry.skuId, entry.quantity)
    order.status = "backordered"
    order.updatedAt = new Date().toISOString()
    throw error
  }

  order.status = "allocated"
  order.updatedAt = new Date().toISOString()
  return order
}

/** Releases a cancelled or backordered order's commitments. */
export function cancelOrder(snapshot: DatabaseSnapshot, orderId: string, reason: string): SalesOrder {
  const order = snapshot.salesOrders.find((o) => o.id === orderId)
  if (!order) throw ApiError.notFound(`Sales order "${orderId}" does not exist.`)
  if (["shipped", "cancelled"].includes(order.status)) {
    throw ApiError.conflict(`Sales order ${order.number} is "${order.status}" and cannot be cancelled.`)
  }

  for (const line of order.lines) {
    if (line.quantityAllocated > line.quantityPicked) {
      deallocateStock(snapshot, line.skuId, line.quantityAllocated - line.quantityPicked)
    }
    line.quantityAllocated = line.quantityPicked
  }

  order.status = "cancelled"
  order.cancelledReason = reason
  order.updatedAt = new Date().toISOString()
  return order
}

// ---------------------------------------------------------------------------
// Waves
// ---------------------------------------------------------------------------

export interface CreateWaveInput {
  warehouseId: string
  orderIds: string[]
  strategy: WaveStrategy
}

/**
 * Groups allocated orders into a wave.
 *
 * Only `allocated` orders qualify — waving an unallocated order would create
 * pick tasks for stock nobody has reserved.
 */
export function createWave(snapshot: DatabaseSnapshot, input: CreateWaveInput): Wave {
  if (input.orderIds.length === 0) throw ApiError.badRequest("A wave needs at least one order.")

  const orders: SalesOrder[] = []
  for (const orderId of input.orderIds) {
    const order = snapshot.salesOrders.find((o) => o.id === orderId)
    if (!order) throw ApiError.notFound(`Sales order "${orderId}" does not exist.`)
    if (order.status !== "allocated") {
      throw ApiError.conflict(`Sales order ${order.number} must be allocated before waving (it is "${order.status}").`)
    }
    if (order.waveId) throw ApiError.conflict(`Sales order ${order.number} is already on a wave.`)
    orders.push(order)
  }

  const now = new Date().toISOString()
  const wave: Wave = {
    id: generateId("wav"),
    number: nextNumber(snapshot, "WAV"),
    warehouseId: input.warehouseId,
    orderIds: orders.map((o) => o.id),
    status: "planned",
    strategy: input.strategy,
    releasedAt: null,
    completedAt: null,
    releasedBy: null,
    createdAt: now,
    updatedAt: now,
  }

  snapshot.waves.unshift(wave)

  // Link each order back to the wave. Without this the guard above
  // ("already on a wave") could never fire, so the same order could be
  // waved twice and picked from two locations.
  for (const order of orders) order.waveId = wave.id

  return wave
}

/**
 * Releases a wave: generates pick tasks and assigns them a travel sequence.
 *
 * The sequence sorts by aisle → bay → level → position so a picker walks each
 * aisle once. This single sort is usually the biggest picking-productivity win
 * available in a WMS.
 */
export function releaseWave(snapshot: DatabaseSnapshot, waveId: string, releasedBy: string): { wave: Wave; pickTasks: PickTask[] } {
  const wave = snapshot.waves.find((w) => w.id === waveId)
  if (!wave) throw ApiError.notFound(`Wave "${waveId}" does not exist.`)
  if (wave.status !== "planned") throw ApiError.conflict(`Wave ${wave.number} is "${wave.status}" and cannot be released.`)

  const now = new Date().toISOString()
  const tasks: PickTask[] = []

  for (const orderId of wave.orderIds) {
    const order = snapshot.salesOrders.find((o) => o.id === orderId)
    if (!order) continue
    order.waveId = wave.id
    order.status = "picking"
    order.updatedAt = now

    for (const line of order.lines) {
      const remaining = line.quantityOrdered - line.quantityPicked
      if (remaining <= 0) continue

      // Split across locations in FEFO order, matching how the stock was allocated.
      const sources = snapshot.inventory
        .filter((r) => r.skuId === line.skuId && r.quantityAllocated > 0)
        .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))

      let toAssign = remaining
      for (const source of sources) {
        if (toAssign <= 0) break
        const take = Math.min(toAssign, source.quantityAllocated)
        if (take <= 0) continue

        const location = snapshot.locations.find((l) => l.id === source.locationId)
        tasks.push({
          id: generateId("pick"),
          number: nextNumber(snapshot, "PICK"),
          waveId: wave.id,
          orderId: order.id,
          skuId: line.skuId,
          quantity: take,
          quantityPicked: 0,
          fromLocationId: source.locationId,
          lot: source.lot,
          assignedTo: null,
          status: "pending",
          sequence: 0,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        })
        toAssign -= take
      }

      if (toAssign > 0) {
        throw ApiError.conflict(
          `Cannot release ${wave.number}: ${toAssign} unit(s) of ${findSku(snapshot, line.skuId).code} on ${order.number} have no allocated stock.`,
        )
      }
    }
  }

  // Travel-optimised sequence: aisle, then bay, then level, then position.
  const rank = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId)!
    const location = snapshot.locations.find((l) => l.id === task.fromLocationId)
    return {
      aisle: location?.aisle ?? "~",
      bay: location?.bay ?? "~",
      level: location?.level ?? 99,
      position: location?.position ?? 99,
    }
  }

  tasks
    .sort((a, b) => {
      const ra = rank(a.id)
      const rb = rank(b.id)
      return (
        ra.aisle.localeCompare(rb.aisle) ||
        ra.bay.localeCompare(rb.bay) ||
        ra.level - rb.level ||
        ra.position - rb.position
      )
    })
    .forEach((task, index) => {
      task.sequence = index + 1
    })

  snapshot.pickTasks.unshift(...tasks)

  wave.status = "released"
  wave.releasedAt = now
  wave.releasedBy = releasedBy
  wave.updatedAt = now

  return { wave, pickTasks: [...tasks].sort((a, b) => a.sequence - b.sequence) }
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

export interface ConfirmPickInput {
  taskId: string
  quantityPicked: number
  performedBy: string
}

/**
 * Confirms a pick line.
 *
 * On-hand is decremented here (the stock physically left the rack) while the
 * allocation is cleared at the same time, so available stock stays correct.
 * A short pick leaves the balance on the order for the supervisor to resolve.
 */
export function confirmPick(snapshot: DatabaseSnapshot, input: ConfirmPickInput): PickTask {
  const task = snapshot.pickTasks.find((t) => t.id === input.taskId)
  if (!task) throw ApiError.notFound(`Pick task "${input.taskId}" does not exist.`)
  if (task.status === "complete") throw ApiError.conflict(`Pick task ${task.number} is already complete.`)
  if (input.quantityPicked < 0) throw ApiError.badRequest("Picked quantity cannot be negative.")
  if (input.quantityPicked > task.quantity) {
    throw ApiError.badRequest(`Cannot pick ${input.quantityPicked} — the task is for ${task.quantity}.`)
  }

  const now = new Date().toISOString()
  const location = findLocation(snapshot, task.fromLocationId)
  const record = getOrCreateRecord(snapshot, task.skuId, task.fromLocationId, task.lot ?? null)

  record.quantityOnHand = Math.max(0, record.quantityOnHand - input.quantityPicked)
  record.quantityAllocated = Math.max(0, record.quantityAllocated - input.quantityPicked)
  record.updatedAt = now

  recordMovement(snapshot, {
    type: "pick",
    skuId: task.skuId,
    fromLocationId: task.fromLocationId,
    toLocationId: null,
    quantity: input.quantityPicked,
    lot: task.lot ?? null,
    reference: task.number,
    referenceType: "pick_task",
    performedBy: input.performedBy,
    performedAt: now,
    note: `Picked for ${snapshot.salesOrders.find((o) => o.id === task.orderId)?.number ?? task.orderId}`,
  })

  refreshLocation(snapshot, task.fromLocationId)

  const order = snapshot.salesOrders.find((o) => o.id === task.orderId)
  const orderLine = order?.lines.find((l) => l.skuId === task.skuId)
  if (orderLine) {
    orderLine.quantityPicked = Math.min(orderLine.quantityOrdered, orderLine.quantityPicked + input.quantityPicked)
    order!.updatedAt = now
  }

  task.quantityPicked = input.quantityPicked
  task.status = input.quantityPicked < task.quantity ? "short" : "complete"
  task.assignedTo = input.performedBy
  task.completedAt = now
  task.updatedAt = now

  maybeCompleteWave(snapshot, task.waveId)
  return task
}

function maybeCompleteWave(snapshot: DatabaseSnapshot, waveId: string): void {
  const wave = snapshot.waves.find((w) => w.id === waveId)
  if (!wave || wave.status === "complete") return

  const tasks = snapshot.pickTasks.filter((t) => t.waveId === waveId)
  const settled = tasks.filter((t) => t.status === "complete" || t.status === "short")
  if (settled.length === tasks.length && tasks.length > 0) {
    wave.status = "complete"
    wave.completedAt = new Date().toISOString()
    wave.updatedAt = wave.completedAt
  } else if (wave.status === "released") {
    wave.status = "picking"
    wave.updatedAt = new Date().toISOString()
  }
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

export interface PackInput {
  orderId: string
  items: Array<{ skuId: string; quantity: number }>
  weightKg: number
  cartonCount: number
  packedBy: string
}

export function packOrder(snapshot: DatabaseSnapshot, input: PackInput): PackRecord {
  const order = snapshot.salesOrders.find((o) => o.id === input.orderId)
  if (!order) throw ApiError.notFound(`Sales order "${input.orderId}" does not exist.`)
  if (order.status !== "picking") {
    throw ApiError.conflict(`Sales order ${order.number} must be fully picked before packing (it is "${order.status}").`)
  }

  for (const item of input.items) {
    const line = order.lines.find((l) => l.skuId === item.skuId)
    if (!line) throw ApiError.badRequest(`${findSku(snapshot, item.skuId).code} is not on ${order.number}.`)
    if (item.quantity > line.quantityPicked) {
      throw ApiError.badRequest(`Cannot pack ${item.quantity} of ${findSku(snapshot, item.skuId).code}; only ${line.quantityPicked} were picked.`)
    }
  }

  const now = new Date().toISOString()
  const pack: PackRecord = {
    id: generateId("pack"),
    number: nextNumber(snapshot, "PACK"),
    orderId: order.id,
    packedBy: input.packedBy,
    items: input.items,
    weightKg: input.weightKg,
    cartonCount: Math.max(1, input.cartonCount),
    status: "complete",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  }

  for (const item of input.items) {
    const line = order.lines.find((l) => l.skuId === item.skuId)!
    line.quantityPacked = Math.min(line.quantityPicked, line.quantityPacked + item.quantity)
  }

  snapshot.packRecords.unshift(pack)
  order.status = "packed"
  order.updatedAt = now
  return pack
}

// ---------------------------------------------------------------------------
// Shipping
// ---------------------------------------------------------------------------

export interface ShipInput {
  orderId: string
  trackingNumber: string
  serviceLevel: string
  shippedBy: string
}

/** Final step: writes the outbound ledger entry and decrements on-hand stock. */
export function shipOrder(snapshot: DatabaseSnapshot, input: ShipInput): Shipment {
  const order = snapshot.salesOrders.find((o) => o.id === input.orderId)
  if (!order) throw ApiError.notFound(`Sales order "${input.orderId}" does not exist.`)
  if (order.status !== "packed") throw ApiError.conflict(`Sales order ${order.number} must be packed before shipping (it is "${order.status}").`)

  const pack = snapshot.packRecords.find((p) => p.orderId === order.id && p.status === "complete")
  if (!pack) throw ApiError.conflict(`Sales order ${order.number} has no completed pack record.`)

  const now = new Date().toISOString()
  const shipment: Shipment = {
    id: generateId("shp"),
    number: nextNumber(snapshot, "SHP"),
    orderId: order.id,
    carrier: order.carrier,
    serviceLevel: input.serviceLevel,
    trackingNumber: input.trackingNumber,
    weightKg: pack.weightKg,
    cartonCount: pack.cartonCount,
    status: "manifested",
    shippedAt: now,
    createdAt: now,
    updatedAt: now,
  }

  for (const line of order.lines) {
    if (line.quantityPacked <= 0) continue
    const stagingLocation = snapshot.locations.find((l) => l.warehouseId === order.warehouseId && l.zoneId.endsWith("_pak"))
    recordMovement(snapshot, {
      type: "ship",
      skuId: line.skuId,
      fromLocationId: stagingLocation?.id ?? null,
      toLocationId: null,
      quantity: line.quantityPacked,
      lot: null,
      reference: shipment.number,
      referenceType: "shipment",
      performedBy: input.shippedBy,
      performedAt: now,
      note: `${order.carrier} ${input.trackingNumber}`,
    })
  }

  snapshot.shipments.unshift(shipment)
  order.status = "shipped"
  order.trackingNumber = input.trackingNumber
  order.updatedAt = now
  return shipment
}
