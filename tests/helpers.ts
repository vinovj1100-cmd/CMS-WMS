import { buildSeedSnapshot } from "@/lib/wms/store/seed"
import { clone, EMPTY_SNAPSHOT } from "@/lib/wms/store"
import type { DatabaseSnapshot } from "@/lib/wms/types"

/**
 * Builds a fresh, fully seeded warehouse for each test.
 *
 * Password hashing is the slow part (scrypt), so the snapshot is built once and
 * deep-cloned per test — that keeps the suite fast without letting tests share
 * mutable state.
 */
let template: DatabaseSnapshot | null = null

export async function makeSnapshot(): Promise<DatabaseSnapshot> {
  if (!template) template = await buildSeedSnapshot()
  return clone(template)
}

export function emptySnapshot(): DatabaseSnapshot {
  return clone(EMPTY_SNAPSHOT)
}

/** Convenience accessors used across the service tests. */
export function firstSku(snapshot: DatabaseSnapshot) {
  const sku = snapshot.skus[0]
  if (!sku) throw new Error("seed snapshot has no SKUs")
  return sku
}

export function firstPickFace(snapshot: DatabaseSnapshot) {
  const location = snapshot.locations.find((l) => l.pickFace && l.status === "occupied")
  if (!location) throw new Error("seed snapshot has no occupied pick face")
  return location
}

export function reserveLocation(snapshot: DatabaseSnapshot) {
  const location = snapshot.locations.find((l) => !l.pickFace && l.type === "pallet")
  if (!location) throw new Error("seed snapshot has no reserve pallet location")
  return location
}

export function dxbWarehouse(snapshot: DatabaseSnapshot) {
  const warehouse = snapshot.warehouses[0]
  if (!warehouse) throw new Error("seed snapshot has no warehouses")
  return warehouse
}

/** Resets the seeded state so a mutation test starts from a known balance. */
export function zeroInventory(snapshot: DatabaseSnapshot, skuId: string): void {
  for (const record of snapshot.inventory.filter((r) => r.skuId === skuId)) {
    record.quantityOnHand = 0
    record.quantityAllocated = 0
    record.quantityReserved = 0
    record.quantityDamaged = 0
  }
}
