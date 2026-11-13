import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ok } from "@/lib/api/http"
import { getStore } from "@/lib/wms/store"

/**
 * GET /api/wms/master-data
 *
 * Reference data the UI needs for every dropdown and label: warehouses, zones,
 * SKUs, suppliers, customers. Served as one payload because these change rarely
 * and almost every form needs most of them.
 *
 * Passwords and hashes are never included — the user list here is deliberately
 * limited to display fields.
 */
export const GET = withAuth({ permission: "inventory:read" }, async () => {
  const store = await getStore()
  const snapshot = await store.read()

  return ok({
    warehouses: snapshot.warehouses.map((w) => ({
      id: w.id,
      code: w.code,
      name: w.name,
      city: w.city,
      country: w.country,
      active: w.active,
    })),
    zones: snapshot.zones.map((z) => ({
      id: z.id,
      warehouseId: z.warehouseId,
      code: z.code,
      name: z.name,
      type: z.type,
      temperature: z.temperature,
    })),
    skus: snapshot.skus.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      category: s.category,
      uom: s.uom,
      barcode: s.barcode,
      abcClass: s.abcClass,
      lotControlled: s.lotControlled,
      expiryControlled: s.expiryControlled,
      hazardous: s.hazardous,
      reorderPoint: s.reorderPoint,
      minStock: s.minStock,
      maxStock: s.maxStock,
      cost: s.cost,
      price: s.price,
      weightKg: s.dimensions.weightKg,
      active: s.active,
    })),
    suppliers: snapshot.suppliers.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      rating: s.rating,
      leadTimeDays: s.leadTimeDays,
      active: s.active,
    })),
    customers: snapshot.customers.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      priority: c.priority,
      active: c.active,
    })),
    users: snapshot.users.map((u) => ({
      id: u.id,
      username: u.username,
      name: u.name,
      role: u.role,
      active: u.active,
      lastLoginAt: u.lastLoginAt,
    })),
  })
})

export const dynamic = "force-dynamic"
