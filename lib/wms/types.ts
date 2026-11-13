/**
 * WMS domain model.
 *
 * These types are the single source of truth shared by the store adapters, the
 * service layer, the API routes and the React UI. Every mutable entity carries
 * `createdAt`/`updatedAt` so the audit trail can be reconstructed.
 */

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export interface Timestamps {
  createdAt: string
  updatedAt: string
}

export type IsoDateString = string

// ---------------------------------------------------------------------------
// Facility
// ---------------------------------------------------------------------------

export interface Warehouse extends Timestamps {
  id: string
  code: string
  name: string
  addressLine: string
  city: string
  country: string
  timezone: string
  active: boolean
}

export type ZoneType = "receiving" | "storage" | "picking" | "packing" | "shipping" | "staging" | "returns" | "qc"

export type ZoneTemperature = "ambient" | "chilled" | "frozen"

export interface Zone extends Timestamps {
  id: string
  warehouseId: string
  code: string
  name: string
  type: ZoneType
  temperature: ZoneTemperature
}

export type LocationType = "pallet" | "shelf" | "floor" | "bin" | "bulk"

export type LocationStatus = "empty" | "occupied" | "reserved" | "blocked"

export interface Location extends Timestamps {
  id: string
  warehouseId: string
  zoneId: string
  /** Human/barcode-scannable code, e.g. `A-01-02-03` (aisle-bay-level-position). */
  code: string
  aisle: string
  bay: string
  level: number
  position: number
  type: LocationType
  status: LocationStatus
  /** Maximum payload the location can hold, in kilograms. 0 = unbounded. */
  capacityKg: number
  currentWeightKg: number
  pickFace: boolean
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export type AbcClass = "A" | "B" | "C"

export type UnitOfMeasure = "EA" | "BOX" | "CASE" | "PLT" | "KG" | "LTR"

export interface Dimensions {
  lengthCm: number
  widthCm: number
  heightCm: number
  weightKg: number
}

export interface Sku extends Timestamps {
  id: string
  code: string
  name: string
  description: string
  category: string
  uom: UnitOfMeasure
  barcode: string
  dimensions: Dimensions
  abcClass: AbcClass
  lotControlled: boolean
  serialControlled: boolean
  expiryControlled: boolean
  hazardous: boolean
  /** Reorder point — falling to this triggers a replenishment task. */
  reorderPoint: number
  minStock: number
  maxStock: number
  leadTimeDays: number
  cost: number
  price: number
  active: boolean
}

export interface Supplier extends Timestamps {
  id: string
  code: string
  name: string
  contactName: string
  email: string
  phone: string
  rating: number
  leadTimeDays: number
  active: boolean
}

export type CustomerPriority = "standard" | "express" | "vip"

export interface Customer extends Timestamps {
  id: string
  code: string
  name: string
  contactName: string
  email: string
  shipToAddress: string
  priority: CustomerPriority
  active: boolean
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface InventoryRecord extends Timestamps {
  id: string
  warehouseId: string
  skuId: string
  locationId: string
  lot: string | null
  quantityOnHand: number
  /** Committed to an outbound order but not yet physically picked. */
  quantityAllocated: number
  /** Held back (QC, damage investigation, cycle count freeze). */
  quantityReserved: number
  quantityDamaged: number
  receivedAt: IsoDateString
  expiresAt: IsoDateString | null
  lastCountedAt: IsoDateString | null
}

/** Derived, never stored — computed from an {@link InventoryRecord}. */
export function availableQuantity(record: InventoryRecord): number {
  return Math.max(0, record.quantityOnHand - record.quantityAllocated - record.quantityReserved)
}

export type MovementType =
  | "receipt"
  | "putaway"
  | "pick"
  | "pack"
  | "ship"
  | "transfer"
  | "adjustment"
  | "return"
  | "replenishment"
  | "cycle_count"

export interface Movement extends Timestamps {
  id: string
  type: MovementType
  skuId: string
  fromLocationId: string | null
  toLocationId: string | null
  quantity: number
  lot: string | null
  reference: string
  referenceType: string
  performedBy: string
  performedAt: IsoDateString
  note?: string
}

// ---------------------------------------------------------------------------
// Inbound: purchase orders → ASN → receiving → QC → putaway
// ---------------------------------------------------------------------------

export type PurchaseOrderStatus = "draft" | "submitted" | "partially_received" | "received" | "closed" | "cancelled"

export interface PurchaseOrderLine {
  id: string
  skuId: string
  quantityOrdered: number
  quantityReceived: number
  unitCost: number
}

export interface PurchaseOrder extends Timestamps {
  id: string
  number: string
  supplierId: string
  warehouseId: string
  status: PurchaseOrderStatus
  expectedDate: IsoDateString
  lines: PurchaseOrderLine[]
  createdBy: string
  closedAt: IsoDateString | null
}

export type InboundStatus = "expected" | "arrived" | "unloading" | "receiving" | "qc" | "putaway" | "complete" | "cancelled"

export interface ReceiptLine {
  id: string
  skuId: string
  quantityExpected: number
  quantityReceived: number
  quantityRejected: number
  lot: string | null
  expiresAt: IsoDateString | null
  condition: "good" | "damaged" | "short"
}

export interface InboundShipment extends Timestamps {
  id: string
  number: string
  purchaseOrderId: string | null
  supplierId: string
  warehouseId: string
  carrier: string
  trackingNumber: string
  status: InboundStatus
  eta: IsoDateString
  dockDoor: string
  lines: ReceiptLine[]
  receivedBy: string | null
  completedAt: IsoDateString | null
}

export type TaskStatus = "pending" | "in_progress" | "complete" | "cancelled"

export interface PutawayTask extends Timestamps {
  id: string
  number: string
  inboundShipmentId: string
  skuId: string
  quantity: number
  lot: string | null
  fromLocationId: string
  suggestedLocationId: string | null
  actualLocationId: string | null
  assignedTo: string | null
  status: TaskStatus
  priority: number
  completedAt: IsoDateString | null
}

// ---------------------------------------------------------------------------
// Outbound: sales order → wave → pick → pack → ship
// ---------------------------------------------------------------------------

export type SalesOrderStatus =
  | "new"
  | "allocated"
  | "picking"
  | "packed"
  | "shipped"
  | "cancelled"
  | "backordered"

export interface SalesOrderLine {
  id: string
  skuId: string
  quantityOrdered: number
  quantityAllocated: number
  quantityPicked: number
  quantityPacked: number
}

export interface SalesOrder extends Timestamps {
  id: string
  number: string
  customerId: string
  warehouseId: string
  status: SalesOrderStatus
  priority: CustomerPriority
  requiredDate: IsoDateString
  waveId: string | null
  carrier: string
  trackingNumber: string | null
  lines: SalesOrderLine[]
  cancelledReason: string | null
}

export type WaveStatus = "planned" | "released" | "picking" | "complete" | "cancelled"

export type WaveStrategy = "single_order" | "batch" | "zone" | "priority"

export interface Wave extends Timestamps {
  id: string
  number: string
  warehouseId: string
  orderIds: string[]
  status: WaveStatus
  strategy: WaveStrategy
  releasedAt: IsoDateString | null
  completedAt: IsoDateString | null
  releasedBy: string | null
}

export interface PickTask extends Timestamps {
  id: string
  number: string
  waveId: string
  orderId: string
  skuId: string
  quantity: number
  quantityPicked: number
  fromLocationId: string
  lot: string | null
  assignedTo: string | null
  status: TaskStatus | "short"
  sequence: number
  completedAt: IsoDateString | null
}

export interface PackLine {
  skuId: string
  quantity: number
}

export type PackStatus = "in_progress" | "complete"

export interface PackRecord extends Timestamps {
  id: string
  number: string
  orderId: string
  packedBy: string
  items: PackLine[]
  weightKg: number
  cartonCount: number
  status: PackStatus
  completedAt: IsoDateString | null
}

export type ShipmentStatus = "label_created" | "manifested" | "in_transit" | "delivered" | "exception"

export interface Shipment extends Timestamps {
  id: string
  number: string
  orderId: string
  carrier: string
  serviceLevel: string
  trackingNumber: string
  weightKg: number
  cartonCount: number
  status: ShipmentStatus
  shippedAt: IsoDateString
}

// ---------------------------------------------------------------------------
// Cycle counting & adjustments
// ---------------------------------------------------------------------------

export type CycleCountStatus = "scheduled" | "in_progress" | "variance_review" | "complete" | "cancelled"

export interface CycleCountLine {
  id: string
  locationId: string
  skuId: string
  lot: string | null
  systemQuantity: number
  countedQuantity: number | null
  variance: number
  recountRequired: boolean
}

export interface CycleCount extends Timestamps {
  id: string
  number: string
  warehouseId: string
  zoneId: string | null
  status: CycleCountStatus
  scheduledDate: IsoDateString
  counter: string | null
  lines: CycleCountLine[]
  completedAt: IsoDateString | null
}

export type AdjustmentReason =
  | "cycle_count"
  | "damage"
  | "expiry"
  | "theft"
  | "correction"
  | "return"
  | "sample"

export interface InventoryAdjustment extends Timestamps {
  id: string
  number: string
  skuId: string
  locationId: string
  lot: string | null
  quantityBefore: number
  quantityAfter: number
  reason: AdjustmentReason
  reference: string
  note: string
  requestedBy: string
  approvedBy: string | null
  status: "pending_approval" | "approved" | "rejected"
}

// ---------------------------------------------------------------------------
// Replenishment
// ---------------------------------------------------------------------------

export type ReplenishmentTrigger = "min_stock" | "wave_demand" | "manual"

export interface ReplenishmentTask extends Timestamps {
  id: string
  number: string
  skuId: string
  fromLocationId: string
  toLocationId: string
  quantity: number
  trigger: ReplenishmentTrigger
  status: TaskStatus
  assignedTo: string | null
  completedAt: IsoDateString | null
}

// ---------------------------------------------------------------------------
// Returns (RMA)
// ---------------------------------------------------------------------------

export type ReturnReason = "damaged" | "wrong_item" | "not_needed" | "late_delivery" | "quality"

export type ReturnDisposition = "restock" | "refurbish" | "scrap" | "vendor_return"

export type ReturnStatus = "requested" | "approved" | "received" | "processed" | "rejected"

export interface ReturnAuthorization extends Timestamps {
  id: string
  number: string
  orderId: string | null
  customerId: string
  warehouseId: string
  skuId: string
  quantity: number
  reason: ReturnReason
  disposition: ReturnDisposition | null
  status: ReturnStatus
  lot: string | null
  reviewedBy: string | null
  receivedAt: IsoDateString | null
}

// ---------------------------------------------------------------------------
// Identity, sessions, audit
// ---------------------------------------------------------------------------

export type Role = "admin" | "warehouse_manager" | "supervisor" | "operator" | "viewer"

export interface User extends Timestamps {
  id: string
  username: string
  email: string
  name: string
  role: Role
  passwordHash: string
  passwordSalt: string
  mustChangePassword: boolean
  failedAttempts: number
  lockedUntil: IsoDateString | null
  lastLoginAt: IsoDateString | null
  mfaEnabled: boolean
  active: boolean
}

export interface Session {
  id: string
  userId: string
  createdAt: IsoDateString
  expiresAt: IsoDateString
  ip: string
  userAgent: string
  revoked: boolean
}

export type AuditOutcome = "success" | "denied" | "failure"

export interface AuditEntry {
  id: string
  timestamp: IsoDateString
  actor: string
  actorRole: Role | "anonymous"
  action: string
  resource: string
  resourceId: string | null
  outcome: AuditOutcome
  ip: string
  userAgent: string
  metadata: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Aggregate root used by the store adapters
// ---------------------------------------------------------------------------

export interface DatabaseSnapshot {
  warehouses: Warehouse[]
  zones: Zone[]
  locations: Location[]
  skus: Sku[]
  suppliers: Supplier[]
  customers: Customer[]
  users: User[]
  sessions: Session[]
  inventory: InventoryRecord[]
  movements: Movement[]
  purchaseOrders: PurchaseOrder[]
  inboundShipments: InboundShipment[]
  putawayTasks: PutawayTask[]
  salesOrders: SalesOrder[]
  waves: Wave[]
  pickTasks: PickTask[]
  packRecords: PackRecord[]
  shipments: Shipment[]
  cycleCounts: CycleCount[]
  adjustments: InventoryAdjustment[]
  replenishmentTasks: ReplenishmentTask[]
  returns: ReturnAuthorization[]
  auditLog: AuditEntry[]
  /** Monotonic counters used to mint human-readable document numbers. */
  sequences: Record<string, number>
}

export type CollectionName = Exclude<keyof DatabaseSnapshot, "sequences">
