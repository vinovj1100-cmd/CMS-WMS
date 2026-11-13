import { generateId } from "@/lib/security/password"
import type {
  AbcClass,
  AuditEntry,
  Customer,
  CycleCount,
  DatabaseSnapshot,
  InventoryAdjustment,
  InventoryRecord,
  InboundShipment,
  Location,
  Movement,
  PackRecord,
  PickTask,
  PurchaseOrder,
  PutawayTask,
  ReplenishmentTask,
  ReturnAuthorization,
  SalesOrder,
  Shipment,
  Sku,
  Supplier,
  User,
  Warehouse,
  Wave,
  Zone,
} from "../types"

/**
 * Deterministic dataset builders.
 *
 * `buildCatalogue` must run before `buildOperations` — the operations reference
 * SKU and location IDs the catalogue creates.
 */

/**
 * Sign-in details for the seeded accounts.
 *
 * These only ever exist when `WMS_SEED_DEMO_DATA` is on, which defaults to off
 * in production. Documented in README.md.
 */
export const DEMO_USERS = [
  { username: "admin", password: "Wms!Owner2026", role: "admin", name: "Amara Osei", email: "admin@wms.local" },
  {
    username: "manager",
    password: "Wms!Manager2026",
    role: "warehouse_manager",
    name: "Rashid Al-Marri",
    email: "manager@wms.local",
  },
  {
    username: "supervisor",
    password: "Wms!Supervisor2026",
    role: "supervisor",
    name: "Elena Duarte",
    email: "supervisor@wms.local",
  },
  {
    username: "operator",
    password: "Wms!Operator2026",
    role: "operator",
    name: "Tomas Novak",
    email: "operator@wms.local",
  },
  { username: "viewer", password: "Wms!Viewer2026", role: "viewer", name: "Priya Raman", email: "viewer@wms.local" },
] as const

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so the dataset is reproducible.
// ---------------------------------------------------------------------------

function makeRandom(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rnd = makeRandom(20260113)

const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T
const between = (min: number, max: number): number => min + Math.floor(rnd() * (max - min + 1))
const chance = (probability: number): boolean => rnd() < probability

/** Timestamps are relative to load time so the dashboard always looks current. */
const NOW = new Date()
function daysAgo(days: number, hourOffset = 0): string {
  const d = new Date(NOW.getTime() - days * 86_400_000 - hourOffset * 3_600_000)
  return d.toISOString()
}
function daysAhead(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString()
}

/** Mints a monotonic document number like `PO-2026-0007`. */
function nextNumber(snapshot: DatabaseSnapshot, prefix: string): string {
  const year = NOW.getFullYear()
  const seq = (snapshot.sequences[prefix] ?? 0) + 1
  snapshot.sequences[prefix] = seq
  return `${prefix}-${year}-${String(seq).padStart(4, "0")}`
}

// ---------------------------------------------------------------------------
// Catalogue: warehouses, zones, locations, SKUs, trading partners
// ---------------------------------------------------------------------------

export function buildCatalogue(snapshot: DatabaseSnapshot): void {
  const createdAt = daysAgo(180)

  // --- Warehouses ---------------------------------------------------------
  const warehouses: Warehouse[] = [
    {
      id: "wh_dxb_main",
      code: "DXB-MAIN",
      name: "Dubai Distribution Centre",
      addressLine: "Plot 42, Dubai Logistics City",
      city: "Dubai",
      country: "AE",
      timezone: "Asia/Dubai",
      active: true,
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "wh_jea_xd",
      code: "JEA-XD",
      name: "Jebel Ali Cross-Dock",
      addressLine: "Warehouse 9, Jebel Ali Free Zone",
      city: "Dubai",
      country: "AE",
      timezone: "Asia/Dubai",
      active: true,
      createdAt,
      updatedAt: createdAt,
    },
  ]
  snapshot.warehouses = warehouses

  // --- Zones --------------------------------------------------------------
  const zoneSpecs: Array<{ wh: string; code: string; name: string; type: Zone["type"]; temperature: Zone["temperature"] }> =
    [
      { wh: "wh_dxb_main", code: "RCV", name: "Receiving", type: "receiving", temperature: "ambient" },
      { wh: "wh_dxb_main", code: "QC", name: "Quality Control", type: "qc", temperature: "ambient" },
      { wh: "wh_dxb_main", code: "STG", name: "Staging", type: "staging", temperature: "ambient" },
      { wh: "wh_dxb_main", code: "SA", name: "Ambient Storage A", type: "storage", temperature: "ambient" },
      { wh: "wh_dxb_main", code: "SB", name: "Ambient Storage B", type: "storage", temperature: "ambient" },
      { wh: "wh_dxb_main", code: "CH", name: "Chilled Storage", type: "storage", temperature: "chilled" },
      { wh: "wh_dxb_main", code: "PK", name: "Pick Module", type: "picking", temperature: "ambient" },
      { wh: "wh_dxb_main", code: "PAK", name: "Packing", type: "packing", temperature: "ambient" },
      { wh: "wh_dxb_main", code: "SHP", name: "Shipping", type: "shipping", temperature: "ambient" },
      { wh: "wh_dxb_main", code: "RET", name: "Returns", type: "returns", temperature: "ambient" },
      { wh: "wh_jea_xd", code: "RCV", name: "Inbound Docks", type: "receiving", temperature: "ambient" },
      { wh: "wh_jea_xd", code: "XD", name: "Cross-Dock Floor", type: "staging", temperature: "ambient" },
      { wh: "wh_jea_xd", code: "SHP", name: "Outbound Docks", type: "shipping", temperature: "ambient" },
    ]

  const zones: Zone[] = zoneSpecs.map((spec, index) => ({
    id: `zone_${spec.wh}_${spec.code.toLowerCase()}`,
    warehouseId: spec.wh,
    code: spec.code,
    name: spec.name,
    type: spec.type,
    temperature: spec.temperature,
    createdAt,
    updatedAt: createdAt,
  }))
  snapshot.zones = zones

  const zoneId = (wh: string, code: string) => `zone_${wh}_${code.toLowerCase()}`

  // --- Storage locations (rack positions) --------------------------------
  const locations: Location[] = []

  const addRacks = (warehouseId: string, zoneCode: string, aisles: string[], bays: number, levels: number, positions: number) => {
    const zid = zoneId(warehouseId, zoneCode)
    for (const aisle of aisles) {
      for (let bay = 1; bay <= bays; bay++) {
        for (let level = 1; level <= levels; level++) {
          for (let position = 1; position <= positions; position++) {
            const code = `${aisle}-${String(bay).padStart(2, "0")}-${level}-${position}`
            locations.push({
              id: `loc_${warehouseId}_${code.toLowerCase().replace(/-/g, "")}`,
              warehouseId,
              zoneId: zid,
              code,
              aisle,
              bay: String(bay).padStart(2, "0"),
              level,
              position,
              // Level 1 is the pick face; higher levels hold reserve pallets.
              type: level === 1 ? "shelf" : "pallet",
              status: "empty",
              capacityKg: level === 1 ? 250 : 900,
              currentWeightKg: 0,
              pickFace: level === 1,
              createdAt,
              updatedAt: createdAt,
            })
          }
        }
      }
    }
  }

  addRacks("wh_dxb_main", "SA", ["A", "B", "C", "D"], 6, 3, 2)
  addRacks("wh_dxb_main", "SB", ["E", "F"], 6, 3, 2)
  addRacks("wh_dxb_main", "CH", ["G"], 4, 2, 2)
  addRacks("wh_dxb_main", "PK", ["P"], 8, 1, 2)
  addRacks("wh_jea_xd", "XD", ["X"], 5, 2, 2)

  // --- Functional locations (docks, benches) ------------------------------
  const functional: Array<[string, string, string, Location["type"]]> = [
    ["wh_dxb_main", "RCV-DOCK-01", "rcv", "floor"],
    ["wh_dxb_main", "RCV-DOCK-02", "rcv", "floor"],
    ["wh_dxb_main", "RCV-DOCK-03", "rcv", "floor"],
    ["wh_dxb_main", "QC-BENCH-01", "qc", "shelf"],
    ["wh_dxb_main", "QC-BENCH-02", "qc", "shelf"],
    ["wh_dxb_main", "STG-01", "stg", "floor"],
    ["wh_dxb_main", "STG-02", "stg", "floor"],
    ["wh_dxb_main", "STG-03", "stg", "floor"],
    ["wh_dxb_main", "PACK-01", "pak", "bin"],
    ["wh_dxb_main", "PACK-02", "pak", "bin"],
    ["wh_dxb_main", "PACK-03", "pak", "bin"],
    ["wh_dxb_main", "SHP-DOCK-01", "shp", "floor"],
    ["wh_dxb_main", "SHP-DOCK-02", "shp", "floor"],
    ["wh_dxb_main", "RET-01", "ret", "shelf"],
    ["wh_jea_xd", "RCV-DOCK-01", "rcv", "floor"],
    ["wh_jea_xd", "SHP-DOCK-01", "shp", "floor"],
  ]

  for (const [warehouseId, code, zoneCode, type] of functional) {
    locations.push({
      id: `loc_${warehouseId}_${code.toLowerCase().replace(/-/g, "")}`,
      warehouseId,
      zoneId: zoneId(warehouseId, zoneCode.toUpperCase()),
      code,
      aisle: "-",
      bay: "-",
      level: 1,
      position: 1,
      type,
      status: "empty",
      capacityKg: 0,
      currentWeightKg: 0,
      pickFace: false,
      createdAt,
      updatedAt: createdAt,
    })
  }

  snapshot.locations = locations

  // --- SKUs ---------------------------------------------------------------
  const skuSpecs: Array<{
    code: string
    name: string
    category: string
    uom: Sku["uom"]
    abc: AbcClass
    weight: number
    lot?: boolean
    expiry?: boolean
    hazardous?: boolean
    cost: number
    price: number
  }> = [
    { code: "ELC-LAP-1401", name: "Industrial Rugged Laptop 14in", category: "Electronics", uom: "EA", abc: "A", weight: 3.2, cost: 1450, price: 2199 },
    { code: "ELC-SCN-2201", name: "Wireless Barcode Scanner", category: "Electronics", uom: "EA", abc: "A", weight: 0.4, cost: 180, price: 299 },
    { code: "ELC-PRT-3301", name: "Thermal Label Printer 4in", category: "Electronics", uom: "EA", abc: "B", weight: 2.8, cost: 320, price: 549 },
    { code: "ELC-BAT-4401", name: "Li-Ion Battery Pack 24V", category: "Electronics", uom: "EA", abc: "B", weight: 1.6, hazardous: true, cost: 95, price: 165 },
    { code: "ELC-CHG-4402", name: "Forklift Charger Unit", category: "Electronics", uom: "EA", abc: "C", weight: 12, cost: 640, price: 999 },
    { code: "CON-GLV-1101", name: "Nitrile Gloves Box/100", category: "Consumables", uom: "BOX", abc: "A", weight: 0.6, cost: 8.5, price: 14 },
    { code: "CON-TAP-1102", name: "Packing Tape 48mm Roll", category: "Consumables", uom: "CASE", abc: "A", weight: 4.2, cost: 18, price: 29 },
    { code: "CON-WRP-1103", name: "Stretch Wrap Film 500mm", category: "Consumables", uom: "CASE", abc: "A", weight: 9, cost: 42, price: 68 },
    { code: "CON-MRK-1104", name: "Permanent Marker Pack/12", category: "Consumables", uom: "BOX", abc: "C", weight: 0.3, cost: 4.5, price: 9 },
    { code: "PPE-HLM-2201", name: "Safety Helmet Class E", category: "PPE", uom: "EA", abc: "B", weight: 0.5, cost: 22, price: 39 },
    { code: "PPE-VEST-2202", name: "Hi-Vis Vest Class 2", category: "PPE", uom: "EA", abc: "A", weight: 0.2, cost: 6, price: 12 },
    { code: "PPE-BOOT-2203", name: "Steel Toe Boot Size 42", category: "PPE", uom: "EA", abc: "B", weight: 1.9, cost: 55, price: 95 },
    { code: "PPE-GOG-2204", name: "Safety Goggles Anti-Fog", category: "PPE", uom: "EA", abc: "C", weight: 0.1, cost: 7, price: 15 },
    { code: "PKG-BOX-3301", name: "Corrugated Box 400x300x200", category: "Packaging", uom: "CASE", abc: "A", weight: 11, cost: 34, price: 55 },
    { code: "PKG-BOX-3302", name: "Corrugated Box 600x400x400", category: "Packaging", uom: "CASE", abc: "A", weight: 16, cost: 48, price: 79 },
    { code: "PKG-VFL-3303", name: "Void Fill Paper Roll", category: "Packaging", uom: "CASE", abc: "B", weight: 8, cost: 21, price: 34 },
    { code: "PKG-BAG-3304", name: "Poly Mailer Bag Pack/250", category: "Packaging", uom: "CASE", abc: "B", weight: 6.5, cost: 27, price: 45 },
    { code: "PKG-PLT-3305", name: "Euro Pallet 1200x800", category: "Packaging", uom: "PLT", abc: "A", weight: 24, cost: 19, price: 32 },
    { code: "TLS-DRD-4401", name: "Cordless Drill 18V", category: "Tools", uom: "EA", abc: "B", weight: 1.8, cost: 130, price: 219 },
    { code: "TLS-TRO-4402", name: "Hand Pallet Truck 2.5T", category: "Tools", uom: "EA", abc: "C", weight: 68, cost: 410, price: 689 },
    { code: "TLS-STR-4403", name: "Strapping Tool Kit", category: "Tools", uom: "EA", abc: "C", weight: 3.4, cost: 165, price: 275 },
    { code: "HLD-DET-5501", name: "Industrial Degreaser 20L", category: "Household", uom: "EA", abc: "B", weight: 21, hazardous: true, cost: 62, price: 105 },
    { code: "HLD-SAN-5502", name: "Hand Sanitiser 5L", category: "Household", uom: "EA", abc: "B", weight: 5.2, cost: 24, price: 42 },
    { code: "HLD-TWL-5503", name: "Paper Towel Roll Pack/6", category: "Household", uom: "CASE", abc: "A", weight: 4.8, cost: 15, price: 26 },
    { code: "BEV-WTR-6601", name: "Bottled Water 500ml Case/24", category: "Beverages", uom: "CASE", abc: "A", weight: 12.5, expiry: true, lot: true, cost: 9, price: 16 },
    { code: "BEV-COF-6602", name: "Ground Coffee 1kg", category: "Beverages", uom: "EA", abc: "B", weight: 1.05, expiry: true, lot: true, cost: 28, price: 49 },
    { code: "BEV-TEA-6603", name: "Assorted Tea Box/100", category: "Beverages", uom: "BOX", abc: "C", weight: 0.8, expiry: true, lot: true, cost: 17, price: 31 },
    { code: "BEV-DRK-6604", name: "Electrolyte Drink Case/12", category: "Beverages", uom: "CASE", abc: "B", weight: 7.4, expiry: true, lot: true, cost: 21, price: 38 },
    { code: "MED-FAD-7701", name: "First Aid Kit Refill", category: "Safety", uom: "EA", abc: "C", weight: 1.2, expiry: true, lot: true, cost: 33, price: 59 },
    { code: "MED-EXT-7702", name: "Fire Extinguisher 6kg", category: "Safety", uom: "EA", abc: "C", weight: 9.5, hazardous: true, cost: 78, price: 129 },
  ]

  snapshot.skus = skuSpecs.map((spec) => {
    const reorderPoint = spec.abc === "A" ? 240 : spec.abc === "B" ? 120 : 50
    return {
      id: `sku_${spec.code.toLowerCase().replace(/-/g, "")}`,
      code: spec.code,
      name: spec.name,
      description: `${spec.name} — ${spec.category.toLowerCase()} item, stocked in ${spec.uom}.`,
      category: spec.category,
      uom: spec.uom,
      barcode: `890${String(Math.abs(hashCode(spec.code)) % 1_000_000_000).padStart(9, "0")}`,
      dimensions: {
        lengthCm: Math.round(10 + rnd() * 50),
        widthCm: Math.round(8 + rnd() * 40),
        heightCm: Math.round(5 + rnd() * 35),
        weightKg: spec.weight,
      },
      abcClass: spec.abc,
      lotControlled: spec.lot ?? false,
      serialControlled: spec.category === "Electronics" && spec.abc === "A",
      expiryControlled: spec.expiry ?? false,
      hazardous: spec.hazardous ?? false,
      reorderPoint,
      minStock: Math.round(reorderPoint * 0.5),
      maxStock: reorderPoint * 4,
      leadTimeDays: between(7, 30),
      cost: spec.cost,
      price: spec.price,
      active: true,
      createdAt,
      updatedAt: createdAt,
    }
  })

  // --- Suppliers ----------------------------------------------------------
  const supplierSpecs: Array<[string, string, string, string, number, number]> = [
    ["SUP-001", "Gulf Logistics Supplies FZE", "Nadia Haddad", "nadia@gulfsupplies.ae", 4.6, 14],
    ["SUP-002", "Emirates Packaging Industries", "Omar Farouk", "omar@emiratespack.ae", 4.2, 10],
    ["SUP-003", "Delta Safety Equipment LLC", "Sarah Whitfield", "sarah@deltasafety.com", 4.8, 21],
    ["SUP-004", "Shenzhen Metro Electronics", "Li Wei", "li.wei@metroelec.cn", 3.9, 30],
    ["SUP-005", "Al Noor Beverages Trading", "Khalid Bin Salem", "khalid@alnoorbev.ae", 4.4, 7],
  ]

  snapshot.suppliers = supplierSpecs.map(([code, name, contactName, email, rating, leadTimeDays]) => ({
    id: `sup_${code.toLowerCase()}`,
    code,
    name,
    contactName,
    email,
    phone: `+971 4 ${between(200, 899)} ${between(1000, 9999)}`,
    rating,
    leadTimeDays,
    active: true,
    createdAt,
    updatedAt: createdAt,
  }))

  // --- Customers ----------------------------------------------------------
  const customerSpecs: Array<[string, string, string, Customer["priority"], string]> = [
    ["CUS-1001", "Carrefour UAE — Distribution", "Layla Mansour", "vip", "Al Quoz Industrial Area 3, Dubai"],
    ["CUS-1002", "Noon Logistics", "Ahmed Shaker", "vip", "Dubai South, Logistics Corridor"],
    ["CUS-1003", "Aramex Express", "Dina Farid", "express", "Dubai Airport Freezone"],
    ["CUS-1004", "LuLu Hypermarket", "Ravi Menon", "standard", "Mussafah Industrial Area, Abu Dhabi"],
    ["CUS-1005", "Alshaya Group", "Hessa Al-Kuwaiti", "standard", "Jebel Ali Free Zone, Dubai"],
    ["CUS-1006", "Talabat Grocery", "Yousef Barakat", "express", "Dubai Internet City"],
    ["CUS-1007", "Sharjah Retail Co-op", "Fatima Al-Suwaidi", "standard", "Industrial Area 15, Sharjah"],
    ["CUS-1008", "Oman Trading House", "Sultan Al-Balushi", "standard", "Rusayl Industrial Estate, Muscat"],
  ]

  snapshot.customers = customerSpecs.map(([code, name, contactName, priority, shipToAddress]) => ({
    id: `cus_${code.toLowerCase()}`,
    code,
    name,
    contactName,
    email: `${contactName.split(" ")[0]!.toLowerCase()}@${code.toLowerCase()}.example`,
    shipToAddress,
    priority,
    active: true,
    createdAt,
    updatedAt: createdAt,
  }))
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function buildUsers(): User[] {
  const createdAt = daysAgo(90)
  return DEMO_USERS.map((demo) => ({
    id: `usr_${demo.username}`,
    username: demo.username,
    email: demo.email,
    name: demo.name,
    role: demo.role,
    // Replaced with a real scrypt hash by buildSeedSnapshot().
    passwordHash: "pending",
    passwordSalt: "pending",
    mustChangePassword: false,
    failedAttempts: 0,
    lockedUntil: null,
    lastLoginAt: daysAgo(between(0, 3), between(0, 8)),
    mfaEnabled: demo.role === "admin",
    active: true,
    createdAt,
    updatedAt: createdAt,
  }))
}

// ---------------------------------------------------------------------------
// Operational history
// ---------------------------------------------------------------------------

export function buildOperations(snapshot: DatabaseSnapshot): void {
  const skus = snapshot.skus
  const dxb = snapshot.warehouses[0]!
  const jea = snapshot.warehouses[1]!
  const movements: Movement[] = []

  // Zone ids look like `zone_wh_dxb_main_sa` — the trailing segment is the zone
  // code in lowercase, so compare against lowercase literals.
  const storageZoneIds = new Set(
    snapshot.zones.filter((z) => z.warehouseId === dxb.id && ["SA", "SB", "CH", "PK"].includes(z.code)).map((z) => z.id),
  )
  const storageLocations = snapshot.locations.filter((l) => storageZoneIds.has(l.zoneId))
  const pickFaces = storageLocations.filter((l) => l.pickFace)
  const reserveLocations = storageLocations.filter((l) => !l.pickFace)

  // --- Inventory ----------------------------------------------------------
  // Spread SKUs across pick faces with a reserve pallet behind them.
  const inventory: InventoryRecord[] = []
  let invSeq = 0

  for (const sku of skus) {
    const pickFace = pickFaces[invSeq % pickFaces.length]!
    const reserve = reserveLocations[invSeq % reserveLocations.length]!

    const onHandPick = between(40, 400)
    const onHandReserve = between(200, 1200)
    const lot = sku.lotControlled ? `LOT-${2026}${String(between(1, 52)).padStart(2, "0")}` : null

    inventory.push(makeInventory(snapshot, sku.id, pickFace.id, lot, onHandPick, between(0, 30)))
    inventory.push(makeInventory(snapshot, sku.id, reserve.id, lot, onHandReserve, 0))

    // Flag a handful of SKUs as below their reorder point for the dashboard.
    if (invSeq % 7 === 3) {
      const low = inventory[inventory.length - 2]!
      low.quantityOnHand = Math.max(2, Math.round(sku.reorderPoint * 0.35))
    }

    invSeq++
  }

  // A few damaged / QC-held records so the exception views have content.
  inventory.push({
    ...makeInventory(snapshot, skus[3]!.id, pickFaces[3]!.id, null, 24, 0),
    quantityDamaged: 6,
  })
  inventory.push({
    ...makeInventory(snapshot, skus[24]!.id, pickFaces[4]!.id, "LOT-202611", 120, 0),
    quantityReserved: 40,
    expiresAt: daysAhead(9),
  })

  snapshot.inventory = inventory

  // Mark occupied locations and roll up weight.
  for (const record of inventory) {
    const location = snapshot.locations.find((l) => l.id === record.locationId)
    if (!location) continue
    location.status = record.quantityOnHand > 0 ? "occupied" : "empty"
    const sku = skus.find((s) => s.id === record.skuId)
    location.currentWeightKg = Math.round((location.currentWeightKg + record.quantityOnHand * (sku?.dimensions.weightKg ?? 0)) * 10) / 10
  }

  for (const record of inventory) {
    movements.push(
      makeMovement(snapshot, {
        type: "receipt",
        skuId: record.skuId,
        fromLocationId: null,
        toLocationId: record.locationId,
        quantity: record.quantityOnHand,
        lot: record.lot,
        reference: "SEED-OPENING-BALANCE",
        referenceType: "inventory",
        performedBy: "system",
        performedAt: daysAgo(between(20, 90)),
        note: "Opening balance loaded during seeding",
      }),
    )
  }

  // --- Purchase orders ----------------------------------------------------
  const poStatuses: PurchaseOrder["status"][] = ["submitted", "partially_received", "received", "draft", "closed", "submitted"]
  snapshot.purchaseOrders = poStatuses.map((status, index) => {
    const supplier = snapshot.suppliers[index % snapshot.suppliers.length]!
    const lines = Array.from({ length: between(2, 4) }, (_, lineIndex) => {
      const sku = skus[(index * 5 + lineIndex) % skus.length]!
      const quantityOrdered = between(100, 800)
      const quantityReceived =
        status === "received" || status === "closed"
          ? quantityOrdered
          : status === "partially_received"
            ? Math.round(quantityOrdered * 0.6)
            : 0
      return {
        id: generateId("pol"),
        skuId: sku.id,
        quantityOrdered,
        quantityReceived,
        unitCost: sku.cost,
      }
    })
    return {
      id: `po_seed_${index + 1}`,
      number: nextNumber(snapshot, "PO"),
      supplierId: supplier.id,
      warehouseId: index === 5 ? jea.id : dxb.id,
      status,
      expectedDate: status === "draft" ? daysAhead(between(10, 30)) : daysAgo(between(0, 20)),
      lines,
      createdBy: "manager",
      createdAt: daysAgo(between(5, 40)),
      updatedAt: daysAgo(between(0, 5)),
      closedAt: status === "closed" ? daysAgo(between(0, 4)) : null,
    }
  })

  // --- Inbound shipments (ASNs) -------------------------------------------
  const inboundStatuses: InboundShipment["status"][] = ["expected", "arrived", "receiving", "qc", "putaway", "complete"]
  snapshot.inboundShipments = inboundStatuses.map((status, index) => {
    const po = snapshot.purchaseOrders[index]!
    const supplier = snapshot.suppliers.find((s) => s.id === po.supplierId)!
    const done = status === "complete"
    return {
      id: `asn_seed_${index + 1}`,
      number: nextNumber(snapshot, "ASN"),
      purchaseOrderId: po.id,
      supplierId: supplier.id,
      warehouseId: po.warehouseId,
      carrier: pick(["Aramex Logistics", "Gulf Transport", "DHL Freight", "Emirates SkyCargo", "FedEx Trade"]),
      trackingNumber: `TRK${between(100000000, 999999999)}`,
      status,
      eta: status === "expected" ? daysAhead(between(1, 6)) : daysAgo(between(0, 8)),
      dockDoor: `RCV-DOCK-0${(index % 3) + 1}`,
      lines: po.lines.map((line) => ({
        id: generateId("rl"),
        skuId: line.skuId,
        quantityExpected: line.quantityOrdered,
        quantityReceived: done ? line.quantityOrdered : status === "qc" || status === "putaway" ? line.quantityReceived : 0,
        quantityRejected: done && chance(0.25) ? between(1, 8) : 0,
        lot: skus.find((s) => s.id === line.skuId)?.lotControlled ? `LOT-2026${String(between(40, 52)).padStart(2, "0")}` : null,
        expiresAt: skus.find((s) => s.id === line.skuId)?.expiryControlled ? daysAhead(between(60, 400)) : null,
        condition: "good" as const,
      })),
      receivedBy: status === "expected" ? null : "operator",
      createdAt: daysAgo(between(3, 20)),
      updatedAt: daysAgo(between(0, 3)),
      completedAt: done ? daysAgo(between(0, 2)) : null,
    }
  })

  // --- Putaway tasks ------------------------------------------------------
  const putawayStates: PutawayTask["status"][] = ["pending", "pending", "in_progress", "complete", "complete", "pending", "in_progress", "complete"]
  snapshot.putawayTasks = putawayStates.map((status, index) => {
    const asn = snapshot.inboundShipments[index % snapshot.inboundShipments.length]!
    const line = asn.lines[index % asn.lines.length]!
    const sku = skus.find((s) => s.id === line.skuId)!
    const target = reserveLocations[index % reserveLocations.length]!
    return {
      id: `pt_seed_${index + 1}`,
      number: nextNumber(snapshot, "PUT"),
      inboundShipmentId: asn.id,
      skuId: sku!.id,
      quantity: line.quantityReceived || between(20, 120),
      lot: line.lot,
      fromLocationId: `loc_wh_dxb_main_rcvdock0${(index % 3) + 1}`,
      suggestedLocationId: target.id,
      actualLocationId: status === "complete" ? target.id : null,
      assignedTo: status === "pending" ? null : "operator",
      status,
      priority: sku!.abcClass === "A" ? 1 : sku!.abcClass === "B" ? 2 : 3,
      createdAt: daysAgo(between(0, 6), index),
      updatedAt: daysAgo(between(0, 4)),
      completedAt: status === "complete" ? daysAgo(between(0, 3)) : null,
    }
  })

  // --- Sales orders -------------------------------------------------------
  const orderStatuses: SalesOrder["status"][] = [
    "new", "new", "allocated", "allocated", "picking", "picking", "packed", "packed",
    "shipped", "shipped", "shipped", "backordered", "shipped", "cancelled",
  ]

  snapshot.salesOrders = orderStatuses.map((status, index) => {
    const customer = snapshot.customers[index % snapshot.customers.length]!
    const lines = Array.from({ length: between(1, 4) }, (_, lineIndex) => {
      const sku = skus[(index * 3 + lineIndex * 7) % skus.length]!
      const quantityOrdered = between(5, 120)
      const allocated = ["allocated", "picking", "packed", "shipped"].includes(status) ? quantityOrdered : 0
      const picked = ["picking", "packed", "shipped"].includes(status)
        ? status === "picking"
          ? Math.round(quantityOrdered * 0.6)
          : quantityOrdered
        : 0
      const packed = ["packed", "shipped"].includes(status) ? quantityOrdered : 0
      return {
        id: generateId("sol"),
        skuId: sku.id,
        quantityOrdered,
        quantityAllocated: allocated,
        quantityPicked: picked,
        quantityPacked: packed,
      }
    })

    return {
      id: `so_seed_${index + 1}`,
      number: nextNumber(snapshot, "SO"),
      customerId: customer.id,
      warehouseId: dxb.id,
      status,
      priority: customer.priority,
      requiredDate: daysAhead(between(-2, 7)),
      waveId: null,
      carrier: pick(["Aramex", "DHL", "FedEx", "Emirates Post", "Self Collection"]),
      trackingNumber: status === "shipped" ? `1Z${between(100000, 999999)}${between(10, 99)}` : null,
      lines,
      cancelledReason: status === "cancelled" ? "Customer cancelled before allocation" : null,
      createdAt: daysAgo(between(0, 12), index),
      updatedAt: daysAgo(between(0, 4)),
    }
  })

  // --- Waves --------------------------------------------------------------
  const waveOrderGroups = [
    snapshot.salesOrders.slice(4, 6).map((o) => o.id),
    snapshot.salesOrders.slice(6, 8).map((o) => o.id),
    snapshot.salesOrders.slice(8, 11).map((o) => o.id),
    snapshot.salesOrders.slice(2, 4).map((o) => o.id),
  ]
  const waveStatuses: Wave["status"][] = ["complete", "complete", "picking", "released"]

  snapshot.waves = waveOrderGroups.map((orderIds, index) => ({
    id: `wave_seed_${index + 1}`,
    number: nextNumber(snapshot, "WAV"),
    warehouseId: dxb.id,
    orderIds,
    status: waveStatuses[index]!,
    strategy: index % 2 === 0 ? "zone" : "priority",
    releasedAt: daysAgo(between(0, 5), index),
    completedAt: waveStatuses[index] === "complete" ? daysAgo(between(0, 4)) : null,
    releasedBy: "supervisor",
    createdAt: daysAgo(between(1, 6)),
    updatedAt: daysAgo(between(0, 3)),
  }))

  // Link orders back to their wave.
  for (const wave of snapshot.waves) {
    for (const orderId of wave.orderIds) {
      const order = snapshot.salesOrders.find((o) => o.id === orderId)
      if (order) order.waveId = wave.id
    }
  }

  // --- Pick tasks ---------------------------------------------------------
  const pickTasks: PickTask[] = []
  let pickSeq = 0
  for (const wave of snapshot.waves) {
    for (const orderId of wave.orderIds) {
      const order = snapshot.salesOrders.find((o) => o.id === orderId)
      if (!order) continue
      for (const line of order.lines) {
        const sku = skus.find((s) => s.id === line.skuId)!
        const face = inventory.find((r) => r.skuId === line.skuId && snapshot.locations.find((l) => l.id === r.locationId)?.pickFace)
        const complete = wave.status === "complete"
        pickTasks.push({
          id: `pk_seed_${pickSeq + 1}`,
          number: nextNumber(snapshot, "PICK"),
          waveId: wave.id,
          orderId: order.id,
          skuId: line.skuId,
          quantity: line.quantityOrdered,
          quantityPicked: complete ? line.quantityOrdered : wave.status === "picking" && pickSeq % 2 === 0 ? line.quantityOrdered : 0,
          fromLocationId: face?.locationId ?? pickFaces[pickSeq % pickFaces.length]!.id,
          lot: sku!.lotControlled ? `LOT-2026${String(between(40, 52)).padStart(2, "0")}` : null,
          assignedTo: wave.status === "released" ? null : "operator",
          status: complete ? "complete" : wave.status === "picking" ? (pickSeq % 2 === 0 ? "complete" : "in_progress") : "pending",
          // Sequence walks aisle → bay → level so the picker never doubles back.
          sequence: pickSeq + 1,
          createdAt: daysAgo(between(0, 4), pickSeq),
          updatedAt: daysAgo(between(0, 3)),
          completedAt: complete ? daysAgo(between(0, 2)) : null,
        })
        pickSeq++
      }
    }
  }
  snapshot.pickTasks = pickTasks

  // --- Pack records & shipments -------------------------------------------
  const packedOrders = snapshot.salesOrders.filter((o) => o.status === "packed" || o.status === "shipped")
  snapshot.packRecords = packedOrders.slice(0, 7).map((order, index) => ({
    id: `pack_seed_${index + 1}`,
    number: nextNumber(snapshot, "PACK"),
    orderId: order.id,
    packedBy: "operator",
    items: order.lines.map((l) => ({ skuId: l.skuId, quantity: l.quantityPacked })),
    weightKg: Math.round((5 + rnd() * 40) * 10) / 10,
    cartonCount: between(1, 6),
    status: "complete" as const,
    createdAt: daysAgo(between(0, 4), index),
    updatedAt: daysAgo(between(0, 3)),
    completedAt: daysAgo(between(0, 3)),
  }))

  snapshot.shipments = snapshot.salesOrders
    .filter((o) => o.status === "shipped")
    .map((order, index) => ({
      id: `ship_seed_${index + 1}`,
      number: nextNumber(snapshot, "SHP"),
      orderId: order.id,
      carrier: order.carrier,
      serviceLevel: order.priority === "vip" ? "Next Day" : order.priority === "express" ? "Express 48h" : "Ground",
      trackingNumber: order.trackingNumber ?? `1Z${between(100000, 999999)}`,
      weightKg: Math.round((8 + rnd() * 45) * 10) / 10,
      cartonCount: between(1, 6),
      status: index < 2 ? ("delivered" as const) : index < 4 ? ("in_transit" as const) : ("manifested" as const),
      shippedAt: daysAgo(between(0, 6), index),
      createdAt: daysAgo(between(0, 6), index),
      updatedAt: daysAgo(between(0, 2)),
    }))

  // --- Cycle counts -------------------------------------------------------
  const ccStatuses: CycleCount["status"][] = ["complete", "variance_review", "in_progress", "scheduled"]
  snapshot.cycleCounts = ccStatuses.map((status, index) => {
    const storageZones = snapshot.zones.filter((z) => z.type === "storage")
    const zone = storageZones[index % storageZones.length]!
    const zoneLocations = snapshot.locations.filter((l) => l.zoneId === zone.id).slice(0, 8)
    const counted = status === "complete" || status === "variance_review"
    return {
      id: `cc_seed_${index + 1}`,
      number: nextNumber(snapshot, "CC"),
      warehouseId: dxb.id,
      zoneId: zone.id,
      status,
      scheduledDate: status === "scheduled" ? daysAhead(between(1, 10)) : daysAgo(between(0, 12)),
      counter: status === "scheduled" ? null : "operator",
      lines: zoneLocations.map((location) => {
        const record = inventory.find((r) => r.locationId === location.id)
        const systemQuantity = record?.quantityOnHand ?? 0
        // ~20% of counted lines carry a variance, so the review queue is real.
        const hasVariance = counted && chance(0.2)
        const countedQuantity = counted ? (hasVariance ? Math.max(0, systemQuantity + between(-8, 5)) : systemQuantity) : null
        const variance = countedQuantity === null ? 0 : countedQuantity - systemQuantity
        return {
          id: generateId("ccl"),
          locationId: location.id,
          skuId: record?.skuId ?? skus[0]!.id,
          lot: record?.lot ?? null,
          systemQuantity,
          countedQuantity,
          variance,
          recountRequired: Math.abs(variance) > 3,
        }
      }),
      createdAt: daysAgo(between(1, 14)),
      updatedAt: daysAgo(between(0, 3)),
      completedAt: status === "complete" ? daysAgo(between(0, 2)) : null,
    }
  })

  // --- Adjustments --------------------------------------------------------
  const adjustReasons: InventoryAdjustment["reason"][] = ["cycle_count", "damage", "expiry", "theft", "correction", "sample"]
  snapshot.adjustments = adjustReasons.map((reason, index) => {
    const record = inventory[index * 2]!
    const sku = skus.find((s) => s.id === record.skuId)!
    const delta = reason === "sample" ? -2 : -between(1, 20)
    return {
      id: `adj_seed_${index + 1}`,
      number: nextNumber(snapshot, "ADJ"),
      skuId: record.skuId,
      locationId: record.locationId,
      lot: record.lot,
      quantityBefore: record.quantityOnHand,
      quantityAfter: Math.max(0, record.quantityOnHand + delta),
      reason,
      reference: reason === "cycle_count" ? snapshot.cycleCounts[0]!.number : nextNumber(snapshot, "REF"),
      note: adjustmentNote(reason, sku!.name),
      requestedBy: "operator",
      approvedBy: reason === "theft" ? null : "supervisor",
      status: reason === "theft" ? "pending_approval" : "approved",
      createdAt: daysAgo(between(0, 18), index),
      updatedAt: daysAgo(between(0, 8)),
    }
  })

  // --- Replenishment ------------------------------------------------------
  const replenStatuses: ReplenishmentTask["status"][] = ["pending", "pending", "in_progress", "complete", "complete"]
  snapshot.replenishmentTasks = replenStatuses.map((status, index) => {
    const sku = skus.filter((s) => s.abcClass === "A")[index % 8]!
    const face = inventory.find((r) => r.skuId === sku.id && snapshot.locations.find((l) => l.id === r.locationId)?.pickFace)
    const reserve = inventory.find((r) => r.skuId === sku.id && !snapshot.locations.find((l) => l.id === r.locationId)?.pickFace)
    return {
      id: `rep_seed_${index + 1}`,
      number: nextNumber(snapshot, "REP"),
      skuId: sku.id,
      fromLocationId: reserve?.locationId ?? reserveLocations[index]!.id,
      toLocationId: face?.locationId ?? pickFaces[index]!.id,
      quantity: between(40, 200),
      trigger: index % 3 === 0 ? ("wave_demand" as const) : ("min_stock" as const),
      status,
      assignedTo: status === "pending" ? null : "operator",
      createdAt: daysAgo(between(0, 5), index),
      updatedAt: daysAgo(between(0, 3)),
      completedAt: status === "complete" ? daysAgo(between(0, 2)) : null,
    }
  })

  // --- Returns ------------------------------------------------------------
  const returnStates: ReturnAuthorization["status"][] = ["requested", "approved", "received", "processed", "requested"]
  snapshot.returns = returnStates.map((status, index) => {
    const order = snapshot.salesOrders[index + 8]!
    const customer = snapshot.customers.find((c) => c.id === order.customerId)!
    const line = order.lines[0]!
    return {
      id: `rma_seed_${index + 1}`,
      number: nextNumber(snapshot, "RMA"),
      orderId: order.id,
      customerId: customer!.id,
      warehouseId: dxb.id,
      skuId: line.skuId,
      quantity: Math.max(1, Math.round(line.quantityOrdered * 0.3)),
      reason: pick(["damaged", "wrong_item", "not_needed", "late_delivery", "quality"] as const),
      disposition: status === "processed" ? ("restock" as const) : status === "requested" ? null : ("restock" as const),
      status,
      lot: null,
      reviewedBy: status === "requested" ? null : "supervisor",
      receivedAt: status === "received" || status === "processed" ? daysAgo(between(0, 4)) : null,
      createdAt: daysAgo(between(1, 10), index),
      updatedAt: daysAgo(between(0, 4)),
    }
  })

  // --- Movement ledger ----------------------------------------------------
  for (const task of snapshot.pickTasks.filter((t) => t.status === "complete")) {
    movements.push(
      makeMovement(snapshot, {
        type: "pick",
        skuId: task.skuId,
        fromLocationId: task.fromLocationId,
        toLocationId: `loc_wh_dxb_main_pack0${(task.sequence % 3) + 1}`,
        quantity: task.quantityPicked,
        lot: task.lot,
        reference: task.number,
        referenceType: "pick_task",
        performedBy: task.assignedTo ?? "operator",
        performedAt: task.completedAt ?? daysAgo(1),
      }),
    )
  }

  for (const task of snapshot.putawayTasks.filter((t) => t.status === "complete")) {
    movements.push(
      makeMovement(snapshot, {
        type: "putaway",
        skuId: task.skuId,
        fromLocationId: task.fromLocationId,
        toLocationId: task.actualLocationId,
        quantity: task.quantity,
        lot: task.lot,
        reference: task.number,
        referenceType: "putaway_task",
        performedBy: task.assignedTo ?? "operator",
        performedAt: task.completedAt ?? daysAgo(1),
      }),
    )
  }

  for (const shipment of snapshot.shipments) {
    const order = snapshot.salesOrders.find((o) => o.id === shipment.orderId)!
    for (const line of order.lines) {
      movements.push(
        makeMovement(snapshot, {
          type: "ship",
          skuId: line.skuId,
          fromLocationId: `loc_wh_dxb_main_pack01`,
          toLocationId: null,
          quantity: line.quantityPacked,
          lot: null,
          reference: shipment.number,
          referenceType: "shipment",
          performedBy: "operator",
          performedAt: shipment.shippedAt,
        }),
      )
    }
  }

  snapshot.movements = movements.sort((a, b) => Date.parse(b.performedAt) - Date.parse(a.performedAt))

  // --- Seed audit entries -------------------------------------------------
  snapshot.auditLog = buildSeedAuditLog(snapshot)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let inventorySequence = 0
function makeInventory(
  snapshot: DatabaseSnapshot,
  skuId: string,
  locationId: string,
  lot: string | null,
  quantityOnHand: number,
  quantityAllocated: number,
): InventoryRecord {
  inventorySequence++
  const warehouseId = snapshot.locations.find((l) => l.id === locationId)?.warehouseId ?? "wh_dxb_main"
  const now = new Date().toISOString()
  return {
    id: `inv_seed_${inventorySequence}`,
    warehouseId,
    skuId,
    locationId,
    lot,
    quantityOnHand,
    quantityAllocated,
    quantityReserved: 0,
    quantityDamaged: 0,
    receivedAt: daysAgo(between(10, 90)),
    expiresAt: null,
    lastCountedAt: chance(0.6) ? daysAgo(between(1, 30)) : null,
    createdAt: now,
    updatedAt: now,
  }
}

function makeMovement(snapshot: DatabaseSnapshot, input: Omit<Movement, "id" | "createdAt" | "updatedAt">): Movement {
  const now = new Date().toISOString()
  return { ...input, id: generateId("mov"), createdAt: now, updatedAt: now }
}

function adjustmentNote(reason: string, skuName: string): string {
  switch (reason) {
    case "cycle_count":
      return "Counted quantity differed from system balance during scheduled cycle count."
    case "damage":
      return `Unit(s) of ${skuName} crushed during handling; moved to damage hold.`
    case "expiry":
      return `${skuName} passed its best-before date and was pulled from saleable stock.`
    case "theft":
      return "Shrinkage identified during investigation — awaiting supervisor sign-off."
    case "correction":
      return "Manual correction after a receipt was keyed against the wrong SKU."
    case "sample":
      return `${skuName} issued as a customer sample.`
    default:
      return "Stock adjustment."
  }
}

interface SeedAuditRow {
  actor: string
  actorRole: AuditEntry["actorRole"]
  action: string
  resource: string
  resourceId?: string | null
  outcome: AuditEntry["outcome"]
  meta?: Record<string, unknown>
}

function buildSeedAuditLog(snapshot: DatabaseSnapshot): AuditEntry[] {
  const entries: SeedAuditRow[] = [
    { actor: "admin", actorRole: "admin", action: "auth.login", resource: "session", outcome: "success", meta: { method: "password" } },
    { actor: "supervisor", actorRole: "supervisor", action: "wave.release", resource: "wave", resourceId: snapshot.waves[3]?.number ?? null, outcome: "success" },
    { actor: "operator", actorRole: "operator", action: "inbound.receive", resource: "inbound_shipment", resourceId: snapshot.inboundShipments[2]?.number ?? null, outcome: "success" },
    { actor: "operator", actorRole: "operator", action: "outbound.pick.confirm", resource: "pick_task", resourceId: snapshot.pickTasks[0]?.number ?? null, outcome: "success" },
    { actor: "viewer", actorRole: "viewer", action: "inventory.adjust", resource: "inventory", outcome: "denied", meta: { requiredPermission: "inventory:adjust" } },
    { actor: "anonymous", actorRole: "anonymous", action: "auth.login", resource: "session", outcome: "failure", meta: { username: "admin", reason: "invalid_password" } },
    { actor: "manager", actorRole: "warehouse_manager", action: "inbound.create", resource: "purchase_order", resourceId: snapshot.purchaseOrders[0]?.number ?? null, outcome: "success" },
    { actor: "supervisor", actorRole: "supervisor", action: "cyclecount.approve", resource: "cycle_count", resourceId: snapshot.cycleCounts[0]?.number ?? null, outcome: "success" },
  ]

  return entries.map((entry, index) => ({
    id: `aud_seed_${index + 1}`,
    timestamp: daysAgo(Math.floor(index / 3), (index * 5) % 24),
    actor: entry.actor,
    actorRole: entry.actorRole,
    action: entry.action,
    resource: entry.resource,
    resourceId: entry.resourceId ?? null,
    outcome: entry.outcome,
    ip: entry.actor === "anonymous" ? "203.0.113.44" : `10.20.${between(1, 40)}.${between(2, 250)}`,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WMS-Web",
    metadata: entry.meta ?? {},
  }))
}

/** Stable string hash for generating plausible barcodes. */
function hashCode(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i)
    hash |= 0
  }
  return hash
}
