import { z } from "zod"

/**
 * Request validation schemas.
 *
 * Every API input crosses a zod boundary here. Nothing reaches the service layer
 * unvalidated, which is what makes the services safe to call directly from
 * scripts and tests without re-checking their arguments.
 */

const id = z.string().min(1, "Required").max(64)
const code = z.string().min(1, "Required").max(32)
const note = z.string().max(500).optional().or(z.literal("")).transform((v) => v || undefined)

const positiveInt = z.coerce.number().int("Must be a whole number").positive("Must be greater than zero").max(1_000_000)
const nonNegativeInt = z.coerce.number().int("Must be a whole number").min(0).max(1_000_000)
const isoDate = z.string().datetime({ offset: true, message: "Must be an ISO-8601 date" })
const weight = z.coerce.number().min(0).max(100_000)

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  username: z.string().min(1, "Username is required").max(64),
  password: z.string().min(1, "Password is required").max(128),
})

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required").max(128),
    newPassword: z.string().min(12, "New password must be at least 12 characters").max(128),
    confirmPassword: z.string().max(128),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  })

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export const inventoryQuerySchema = z.object({
  warehouseId: id.optional(),
  zoneId: id.optional(),
  locationId: id.optional(),
  skuId: id.optional(),
  search: z.string().max(120).optional(),
  lowStockOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})

export const adjustInventorySchema = z.object({
  skuId: id,
  locationId: id,
  lot: z.string().max(32).nullable().optional(),
  delta: z.coerce.number().int("Must be a whole number").min(-1_000_000).max(1_000_000).refine((v) => v !== 0, "Delta cannot be zero"),
  reason: z.enum(["cycle_count", "damage", "expiry", "theft", "correction", "return", "sample"]),
  reference: z.string().min(1).max(64),
  note,
})

export const transferInventorySchema = z.object({
  skuId: id,
  fromLocationId: id,
  toLocationId: id,
  lot: z.string().max(32).nullable().optional(),
  quantity: positiveInt,
  reference: z.string().min(1).max(64),
  note,
})

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

export const createPurchaseOrderSchema = z.object({
  supplierId: id,
  warehouseId: id,
  expectedDate: isoDate,
  lines: z
    .array(
      z.object({
        skuId: id,
        quantityOrdered: positiveInt,
        unitCost: z.coerce.number().min(0).max(1_000_000).optional(),
      }),
    )
    .min(1, "At least one line is required")
    .max(200),
})

export const createInboundSchema = z.object({
  purchaseOrderId: id.nullable().optional(),
  supplierId: id,
  warehouseId: id,
  carrier: z.string().min(1).max(64),
  trackingNumber: z.string().max(64).optional(),
  eta: isoDate,
  dockDoor: code,
  lines: z
    .array(
      z.object({
        skuId: id,
        quantityExpected: positiveInt,
        lot: z.string().max(32).nullable().optional(),
        expiresAt: isoDate.nullable().optional(),
      }),
    )
    .max(200)
    .optional(),
})

export const advanceInboundSchema = z.object({
  to: z.enum(["arrived", "unloading", "receiving", "qc", "putaway"]),
})

export const receiveLineSchema = z.object({
  lineId: id,
  quantityReceived: nonNegativeInt,
  quantityRejected: nonNegativeInt.optional(),
  lot: z.string().max(32).nullable().optional(),
  expiresAt: isoDate.nullable().optional(),
  condition: z.enum(["good", "damaged", "short"]).optional(),
  receivingLocationCode: code.optional(),
})

export const completePutawaySchema = z.object({
  taskId: z.string().min(1, "Task is required").max(64),
  location: z.string().min(1, "Scan or enter the destination location").max(32),
})

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

export const createSalesOrderSchema = z.object({
  customerId: id,
  warehouseId: id,
  requiredDate: isoDate,
  carrier: z.string().min(1).max(64),
  lines: z
    .array(z.object({ skuId: id, quantityOrdered: positiveInt }))
    .min(1, "At least one line is required")
    .max(200),
})

export const cancelOrderSchema = z.object({
  reason: z.string().min(1, "A cancellation reason is required").max(300),
})

export const createWaveSchema = z.object({
  warehouseId: id,
  orderIds: z.array(id).min(1, "Select at least one order").max(200),
  strategy: z.enum(["single_order", "batch", "zone", "priority"]),
})

export const confirmPickSchema = z.object({
  quantityPicked: nonNegativeInt,
})

/** Pick confirmation as sent by the handheld: the task plus what was picked. */
export const confirmPickRequestSchema = z.object({
  taskId: z.string().min(1, "Task is required").max(64),
  quantityPicked: nonNegativeInt,
})

export const packOrderSchema = z.object({
  items: z.array(z.object({ skuId: id, quantity: positiveInt })).min(1).max(200),
  weightKg: weight,
  cartonCount: z.coerce.number().int().min(1).max(500),
})

export const shipOrderSchema = z.object({
  trackingNumber: z.string().min(4, "Tracking number is required").max(64),
  serviceLevel: z.string().min(1).max(64),
})

// ---------------------------------------------------------------------------
// Cycle counts
// ---------------------------------------------------------------------------

export const createCycleCountSchema = z.object({
  warehouseId: id,
  zoneId: id.nullable().optional(),
  scheduledDate: isoDate,
})

export const submitCountSchema = z.object({
  entries: z
    .array(z.object({ lineId: id, countedQuantity: nonNegativeInt }))
    .min(1, "At least one counted line is required")
    .max(2000),
})

export const rejectCountSchema = z.object({
  reason: z.string().min(1).max(300),
})

// ---------------------------------------------------------------------------
// Returns & replenishment
// ---------------------------------------------------------------------------

export const createReturnSchema = z.object({
  orderId: id.nullable().optional(),
  customerId: id,
  warehouseId: id,
  skuId: id,
  quantity: positiveInt,
  reason: z.enum(["damaged", "wrong_item", "not_needed", "late_delivery", "quality"]),
})

export const reviewReturnSchema = z.object({
  approve: z.boolean(),
})

export const receiveReturnSchema = z.object({
  disposition: z.enum(["restock", "refurbish", "scrap", "vendor_return"]),
  location: z.string().min(1).max(32),
})

export const generateReplenishmentSchema = z.object({
  warehouseId: id,
})

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const createUserSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(32)
    .regex(/^[a-z0-9._-]+$/, "Lowercase letters, digits, dot, dash and underscore only"),
  email: z.string().email("A valid email address is required").max(120),
  name: z.string().min(2).max(80),
  role: z.enum(["admin", "warehouse_manager", "supervisor", "operator", "viewer"]),
  password: z.string().min(12, "Password must be at least 12 characters").max(128),
})

export const updateUserSchema = z
  .object({
    name: z.string().min(2).max(80).optional(),
    email: z.string().email().max(120).optional(),
    role: z.enum(["admin", "warehouse_manager", "supervisor", "operator", "viewer"]).optional(),
    active: z.boolean().optional(),
    resetPassword: z.string().min(12).max(128).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "Nothing to update" })

export const auditQuerySchema = z.object({
  actor: z.string().max(64).optional(),
  action: z.string().max(64).optional(),
  resource: z.string().max(64).optional(),
  outcome: z.enum(["success", "denied", "failure"]).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})

export const locationQuerySchema = z.object({
  warehouseId: id.optional(),
  zoneId: id.optional(),
  status: z.enum(["empty", "occupied", "reserved", "blocked"]).optional(),
  search: z.string().max(64).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
})

export const locationUpdateSchema = z.object({
  locationId: z.string().min(1, "Location is required").max(64),
  status: z.enum(["empty", "occupied", "reserved", "blocked"]).optional(),
  pickFace: z.boolean().optional(),
  capacityKg: weight.optional(),
})
