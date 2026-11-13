import { ApiError } from "@/lib/api/http"
import { generateId } from "@/lib/security/password"
import { findLocation, findSku, getOrCreateRecord, recordMovement, refreshLocation } from "./inventory"
import type {
  DatabaseSnapshot,
  InboundShipment,
  PurchaseOrder,
  PutawayTask,
  ReceiptLine,
} from "../types"

/**
 * Inbound flow: purchase order → ASN → receiving → QC → putaway.
 *
 * The state machine is enforced here rather than in the UI: `receiveLine` only
 * runs while the shipment is in a receivable state, and `completePutaway` is
 * the only path that actually increases on-hand inventory. That ordering is what
 * makes the ledger trustworthy — nothing enters stock without a document behind it.
 */

const RECEIVABLE_STATUSES = new Set(["arrived", "unloading", "receiving", "qc"])

// ---------------------------------------------------------------------------
// Document numbering
// ---------------------------------------------------------------------------

export function nextNumber(snapshot: DatabaseSnapshot, prefix: string): string {
  const year = new Date().getFullYear()
  const seq = (snapshot.sequences[prefix] ?? 0) + 1
  snapshot.sequences[prefix] = seq
  return `${prefix}-${year}-${String(seq).padStart(4, "0")}`
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export interface CreatePurchaseOrderInput {
  supplierId: string
  warehouseId: string
  expectedDate: string
  lines: Array<{ skuId: string; quantityOrdered: number; unitCost?: number }>
  createdBy: string
}

export function createPurchaseOrder(snapshot: DatabaseSnapshot, input: CreatePurchaseOrderInput): PurchaseOrder {
  const supplier = snapshot.suppliers.find((s) => s.id === input.supplierId)
  if (!supplier) throw ApiError.notFound(`Supplier "${input.supplierId}" does not exist.`)
  if (!snapshot.warehouses.some((w) => w.id === input.warehouseId)) {
    throw ApiError.notFound(`Warehouse "${input.warehouseId}" does not exist.`)
  }
  if (input.lines.length === 0) throw ApiError.badRequest("A purchase order needs at least one line.")

  const now = new Date().toISOString()
  const po: PurchaseOrder = {
    id: generateId("po"),
    number: nextNumber(snapshot, "PO"),
    supplierId: supplier.id,
    warehouseId: input.warehouseId,
    status: "draft",
    expectedDate: input.expectedDate,
    lines: input.lines.map((line) => {
      const sku = findSku(snapshot, line.skuId)
      if (line.quantityOrdered <= 0) throw ApiError.badRequest(`Quantity for ${sku.code} must be greater than zero.`)
      return {
        id: generateId("pol"),
        skuId: sku.id,
        quantityOrdered: line.quantityOrdered,
        quantityReceived: 0,
        unitCost: line.unitCost ?? sku.cost,
      }
    }),
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  }

  snapshot.purchaseOrders.unshift(po)
  return po
}

export function submitPurchaseOrder(snapshot: DatabaseSnapshot, poId: string): PurchaseOrder {
  const po = snapshot.purchaseOrders.find((p) => p.id === poId)
  if (!po) throw ApiError.notFound(`Purchase order "${poId}" does not exist.`)
  if (po.status !== "draft") throw ApiError.conflict(`Only draft purchase orders can be submitted (this one is "${po.status}").`)
  po.status = "submitted"
  po.updatedAt = new Date().toISOString()
  return po
}

// ---------------------------------------------------------------------------
// Inbound shipments (ASN)
// ---------------------------------------------------------------------------

export interface CreateInboundInput {
  purchaseOrderId?: string | null
  supplierId: string
  warehouseId: string
  carrier: string
  trackingNumber?: string
  eta: string
  dockDoor: string
  lines?: Array<{ skuId: string; quantityExpected: number; lot?: string | null; expiresAt?: string | null }>
}

export function createInboundShipment(snapshot: DatabaseSnapshot, input: CreateInboundInput): InboundShipment {
  const supplier = snapshot.suppliers.find((s) => s.id === input.supplierId)
  if (!supplier) throw ApiError.notFound(`Supplier "${input.supplierId}" does not exist.`)
  if (!snapshot.warehouses.some((w) => w.id === input.warehouseId)) {
    throw ApiError.notFound(`Warehouse "${input.warehouseId}" does not exist.`)
  }

  let resolvedLines: ReceiptLine[]

  if (input.lines && input.lines.length > 0) {
    resolvedLines = input.lines.map((line) => {
      const sku = findSku(snapshot, line.skuId)
      if (line.quantityExpected <= 0) {
        throw ApiError.badRequest(`Expected quantity for ${sku.code} must be greater than zero.`)
      }
      if (sku.lotControlled && !line.lot) {
        throw ApiError.badRequest(`${sku.code} is lot-controlled — a lot number is required.`)
      }
      return {
        id: generateId("rl"),
        skuId: sku.id,
        quantityExpected: line.quantityExpected,
        quantityReceived: 0,
        quantityRejected: 0,
        lot: sku.lotControlled ? line.lot ?? null : null,
        expiresAt: sku.expiryControlled ? line.expiresAt ?? null : null,
        condition: "good" as const,
      }
    })
  } else {
    if (!input.purchaseOrderId) {
      throw ApiError.badRequest("Provide either explicit lines or a purchase order to copy from.")
    }
    const po = snapshot.purchaseOrders.find((p) => p.id === input.purchaseOrderId)
    if (!po) throw ApiError.notFound(`Purchase order "${input.purchaseOrderId}" does not exist.`)
    resolvedLines = po.lines.map((line) => {
      const sku = findSku(snapshot, line.skuId)
      return {
        id: generateId("rl"),
        skuId: line.skuId,
        quantityExpected: line.quantityOrdered,
        quantityReceived: 0,
        quantityRejected: 0,
        lot: sku.lotControlled ? null : null,
        expiresAt: null,
        condition: "good" as const,
      }
    })
  }

  const now = new Date().toISOString()
  const asn: InboundShipment = {
    id: generateId("asn"),
    number: nextNumber(snapshot, "ASN"),
    purchaseOrderId: input.purchaseOrderId ?? null,
    supplierId: supplier.id,
    warehouseId: input.warehouseId,
    carrier: input.carrier,
    trackingNumber: input.trackingNumber ?? "",
    status: "expected",
    eta: input.eta,
    dockDoor: input.dockDoor,
    lines: resolvedLines,
    receivedBy: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  }

  snapshot.inboundShipments.unshift(asn)
  return asn
}

export type InboundTransition = "arrived" | "unloading" | "receiving" | "qc" | "putaway"

const ALLOWED_TRANSITIONS: Record<string, InboundTransition[]> = {
  expected: ["arrived"],
  arrived: ["unloading"],
  unloading: ["receiving"],
  receiving: ["qc"],
  qc: ["putaway"],
  putaway: ["complete" as unknown as InboundTransition],
}

/** Advances an inbound shipment, refusing jumps that would skip a physical step. */
export function advanceInbound(snapshot: DatabaseSnapshot, asnId: string, to: InboundTransition): InboundShipment {
  const asn = snapshot.inboundShipments.find((a) => a.id === asnId)
  if (!asn) throw ApiError.notFound(`Inbound shipment "${asnId}" does not exist.`)

  const allowed = ALLOWED_TRANSITIONS[asn.status] ?? []
  if (!allowed.includes(to)) {
    throw ApiError.conflict(`Cannot move inbound shipment from "${asn.status}" to "${to}". Allowed: ${allowed.join(", ") || "none"}.`)
  }

  asn.status = to
  asn.updatedAt = new Date().toISOString()
  return asn
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

export interface ReceiveLineInput {
  asnId: string
  lineId: string
  quantityReceived: number
  quantityRejected?: number
  lot?: string | null
  expiresAt?: string | null
  condition?: ReceiptLine["condition"]
  receivingLocationCode?: string
  receivedBy: string
}

/**
 * Records what physically arrived.
 *
 * Over-receipt beyond the expected quantity is rejected — accepting more than
 * the PO authorised is how phantom stock enters a warehouse.
 */
export function receiveLine(snapshot: DatabaseSnapshot, input: ReceiveLineInput): { asn: InboundShipment; line: ReceiptLine; putaway: PutawayTask } {
  const asn = snapshot.inboundShipments.find((a) => a.id === input.asnId)
  if (!asn) throw ApiError.notFound(`Inbound shipment "${input.asnId}" does not exist.`)

  if (asn.status === "complete" || asn.status === "cancelled") {
    throw ApiError.conflict(`Inbound shipment ${asn.number} is already ${asn.status}.`)
  }
  if (!RECEIVABLE_STATUSES.has(asn.status)) {
    throw ApiError.conflict(`Inbound shipment ${asn.number} is "${asn.status}" and cannot be received yet.`)
  }

  const line = asn.lines.find((l) => l.id === input.lineId)
  if (!line) throw ApiError.notFound(`Receipt line "${input.lineId}" does not exist on ${asn.number}.`)

  if (input.quantityReceived < 0 || (input.quantityRejected ?? 0) < 0) {
    throw ApiError.badRequest("Received and rejected quantities must not be negative.")
  }

  const sku = findSku(snapshot, line.skuId)
  if (sku.lotControlled && !input.lot) {
    throw ApiError.badRequest(`${sku.code} is lot-controlled — a lot number is required at receipt.`)
  }
  if (sku.expiryControlled && !input.expiresAt) {
    throw ApiError.badRequest(`${sku.code} is expiry-controlled — an expiry date is required at receipt.`)
  }

  const totalAccepted = line.quantityReceived + input.quantityReceived
  if (totalAccepted > line.quantityExpected) {
    throw ApiError.conflict(
      `Over-receipt: ${totalAccepted} would exceed the ${line.quantityExpected} expected for ${sku.code}. Raise a variance claim instead.`,
    )
  }

  const receivingLocation = findLocation(snapshot, input.receivingLocationCode ?? asn.dockDoor)

  line.quantityReceived += input.quantityReceived
  line.quantityRejected += input.quantityRejected ?? 0
  line.lot = input.lot ?? line.lot
  line.expiresAt = input.expiresAt ?? line.expiresAt
  line.condition = input.condition ?? "good"

  asn.receivedBy = input.receivedBy
  asn.updatedAt = new Date().toISOString()

  // Stock does NOT become available here. It lands in a receiving location and
  // only becomes saleable when putaway completes — that is the QC gate.
  const stagingRecord = getOrCreateRecord(snapshot, sku.id, receivingLocation.id, line.lot ?? null)
  stagingRecord.quantityOnHand += input.quantityReceived
  stagingRecord.quantityReserved += input.quantityReceived
  stagingRecord.lot = line.lot ?? null
  stagingRecord.expiresAt = line.expiresAt ?? null
  stagingRecord.receivedAt = asn.updatedAt
  stagingRecord.updatedAt = asn.updatedAt

  if (line.quantityRejected) stagingRecord.quantityDamaged += input.quantityRejected ?? 0

  recordMovement(snapshot, {
    type: "receipt",
    skuId: sku.id,
    fromLocationId: null,
    toLocationId: receivingLocation.id,
    quantity: input.quantityReceived,
    lot: line.lot ?? null,
    reference: asn.number,
    referenceType: "inbound_shipment",
    performedBy: input.receivedBy,
    performedAt: asn.updatedAt,
    note: `Received against ${asn.number}${line.quantityRejected ? ` (${line.quantityRejected} rejected)` : ""}`,
  })

  refreshLocation(snapshot, receivingLocation.id)

  const putaway = createPutawayTask(snapshot, {
    inboundShipmentId: asn.id,
    skuId: sku.id,
    quantity: input.quantityReceived,
    lot: line.lot ?? null,
    fromLocationId: receivingLocation.id,
    createdBy: input.receivedBy,
  })

  syncPurchaseOrderStatus(snapshot, asn)

  return { asn, line, putaway }
}

function syncPurchaseOrderStatus(snapshot: DatabaseSnapshot, asn: InboundShipment): void {
  if (!asn.purchaseOrderId) return
  const po = snapshot.purchaseOrders.find((p) => p.id === asn.purchaseOrderId)
  if (!po) return

  const totalOrdered = po.lines.reduce((sum, l) => sum + l.quantityOrdered, 0)
  const totalReceived = asn.lines.reduce((sum, l) => sum + l.quantityReceived, 0)

  for (const poLine of po.lines) {
    const matching = asn.lines.find((l) => l.skuId === poLine.skuId)
    poLine.quantityReceived = matching?.quantityReceived ?? poLine.quantityReceived
  }

  po.status = totalReceived >= totalOrdered ? "received" : totalReceived > 0 ? "partially_received" : po.status
  po.updatedAt = new Date().toISOString()
}

// ---------------------------------------------------------------------------
// Putaway
// ---------------------------------------------------------------------------

/**
 * Suggests a putaway location.
 *
 * Strategy: same SKU already on a pick face wins (keeps the SKU in one place),
 * otherwise the emptiest pick-face location in the SKU's temperature zone,
 * otherwise the emptiest reserve location. Deterministic ties so two operators
 * get the same suggestion.
 */
export function suggestPutawayLocation(snapshot: DatabaseSnapshot, skuId: string, quantity: number): string | null {
  const sku = snapshot.skus.find((s) => s.id === skuId)
  if (!sku) return null

  const weight = quantity * sku.dimensions.weightKg

  const sameSkuFace = snapshot.inventory
    .filter((r) => r.skuId === skuId)
    .map((r) => snapshot.locations.find((l) => l.id === r.locationId))
    .find((l) => l && l.pickFace && l.status !== "blocked" && hasCapacity(l, weight))

  if (sameSkuFace) return sameSkuFace.id

  const usable = snapshot.locations.filter(
    (l) =>
      l.status !== "blocked" &&
      // Hazardous stock must not sit next to food-adjacent chilled zones.
      (!sku.hazardous || !snapshot.zones.find((z) => z.id === l.zoneId && z.temperature === "chilled")) &&
      hasCapacity(l, weight),
  )

  const faces = usable.filter((l) => l.pickFace)
  const pool = faces.length > 0 ? faces : usable.filter((l) => l.type !== "floor")
  if (pool.length === 0) return null

  return [...pool].sort((a, b) => a.currentWeightKg - b.currentWeightKg || a.code.localeCompare(b.code))[0]!.id
}

function hasCapacity(location: { capacityKg: number; currentWeightKg: number }, weight: number): boolean {
  return location.capacityKg === 0 || location.currentWeightKg + weight <= location.capacityKg
}

export interface CreatePutawayInput {
  inboundShipmentId: string
  skuId: string
  quantity: number
  lot?: string | null
  fromLocationId: string
  createdBy: string
}

export function createPutawayTask(snapshot: DatabaseSnapshot, input: CreatePutawayInput): PutawayTask {
  const asn = snapshot.inboundShipments.find((a) => a.id === input.inboundShipmentId)
  if (!asn) throw ApiError.notFound(`Inbound shipment "${input.inboundShipmentId}" does not exist.`)
  const sku = findSku(snapshot, input.skuId)

  const now = new Date().toISOString()
  const task: PutawayTask = {
    id: generateId("put"),
    number: nextNumber(snapshot, "PUT"),
    inboundShipmentId: asn.id,
    skuId: sku.id,
    quantity: input.quantity,
    lot: input.lot ?? null,
    fromLocationId: input.fromLocationId,
    suggestedLocationId: suggestPutawayLocation(snapshot, sku.id, input.quantity),
    actualLocationId: null,
    assignedTo: null,
    status: "pending",
    priority: sku.abcClass === "A" ? 1 : sku.abcClass === "B" ? 2 : 3,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  }

  snapshot.putawayTasks.unshift(task)
  return task
}

/**
 * Completes a putaway. This is the moment stock becomes saleable: the quantity
 * leaves the receiving hold (`quantityReserved`) and lands in a storage location.
 */
export function completePutaway(snapshot: DatabaseSnapshot, taskId: string, toLocationIdOrCode: string, performedBy: string): PutawayTask {
  const task = snapshot.putawayTasks.find((t) => t.id === taskId)
  if (!task) throw ApiError.notFound(`Putaway task "${taskId}" does not exist.`)
  if (task.status === "complete") throw ApiError.conflict(`Putaway task ${task.number} is already complete.`)

  const toLocation = findLocation(snapshot, toLocationIdOrCode)
  if (toLocation.status === "blocked") throw ApiError.conflict(`Location ${toLocation.code} is blocked.`)

  const sku = findSku(snapshot, task.skuId)
  const weight = task.quantity * sku.dimensions.weightKg
  if (!hasCapacity(toLocation, weight)) {
    throw ApiError.conflict(
      `${toLocation.code} cannot hold ${task.quantity} × ${sku.code}: it would exceed the ${toLocation.capacityKg} kg limit.`,
    )
  }

  const now = new Date().toISOString()

  // Release from the receiving hold.
  const staging = snapshot.inventory.find(
    (r) => r.skuId === task.skuId && r.locationId === task.fromLocationId && (r.lot ?? null) === (task.lot ?? null),
  )
  if (staging) {
    staging.quantityOnHand = Math.max(0, staging.quantityOnHand - task.quantity)
    staging.quantityReserved = Math.max(0, staging.quantityReserved - task.quantity)
    staging.updatedAt = now
  }

  // Land in the storage location as available stock.
  const destination = getOrCreateRecord(snapshot, task.skuId, toLocation.id, task.lot ?? null)
  destination.quantityOnHand += task.quantity
  destination.updatedAt = now

  recordMovement(snapshot, {
    type: "putaway",
    skuId: task.skuId,
    fromLocationId: task.fromLocationId,
    toLocationId: toLocation.id,
    quantity: task.quantity,
    lot: task.lot ?? null,
    reference: task.number,
    referenceType: "putaway_task",
    performedBy,
    performedAt: now,
  })

  refreshLocation(snapshot, task.fromLocationId)
  refreshLocation(snapshot, toLocation.id)

  task.status = "complete"
  task.actualLocationId = toLocation.id
  task.assignedTo = performedBy
  task.completedAt = now
  task.updatedAt = now

  // If every putaway for this ASN is done, the inbound document closes.
  const siblings = snapshot.putawayTasks.filter((t) => t.inboundShipmentId === task.inboundShipmentId)
  if (siblings.every((t) => t.status === "complete")) {
    const asn = snapshot.inboundShipments.find((a) => a.id === task.inboundShipmentId)
    if (asn && asn.status !== "complete") {
      asn.status = "complete"
      asn.completedAt = now
      asn.updatedAt = now
    }
  }

  return task
}
