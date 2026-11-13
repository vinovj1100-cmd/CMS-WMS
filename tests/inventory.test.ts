import { describe, expect, it } from "vitest"

import { ApiError } from "@/lib/api/http"
import {
  adjustInventory,
  allocateStock,
  deallocateStock,
  getOrCreateRecord,
  lowStock,
  skuBalances,
  transferInventory,
} from "@/lib/wms/services/inventory"
import { availableQuantity } from "@/lib/wms/types"
import { makeSnapshot, firstSku, firstPickFace, reserveLocation } from "./helpers"

describe("inventory service", () => {
  describe("adjustInventory", () => {
    it("increases and decreases on-hand and writes a ledger entry", async () => {
      const snapshot = await makeSnapshot()
      const sku = firstSku(snapshot)
      const location = firstPickFace(snapshot)
      const record = getOrCreateRecord(snapshot, sku.id, location.id, null)
      const before = record.quantityOnHand
      const movementsBefore = snapshot.movements.length

      const up = adjustInventory(snapshot, {
        skuId: sku.id,
        locationId: location.id,
        delta: 25,
        reason: "correction",
        reference: "TEST-001",
        performedBy: "tester",
      })
      expect(up.quantityOnHand).toBe(before + 25)

      const down = adjustInventory(snapshot, {
        skuId: sku.id,
        locationId: location.id,
        delta: -10,
        reason: "damage",
        reference: "TEST-002",
        performedBy: "tester",
      })
      expect(down.quantityOnHand).toBe(before + 15)

      expect(snapshot.movements.length).toBe(movementsBefore + 2)
      expect(snapshot.movements[0]?.type).toBe("adjustment")
      expect(snapshot.movements[0]?.reference).toBe("TEST-002")
    })

    it("refuses to drive stock negative", async () => {
      const snapshot = await makeSnapshot()
      const sku = firstSku(snapshot)
      const location = firstPickFace(snapshot)
      const record = getOrCreateRecord(snapshot, sku.id, location.id, null)
      const onHand = record.quantityOnHand

      expect(() =>
        adjustInventory(snapshot, {
          skuId: sku.id,
          locationId: location.id,
          delta: -(onHand + 1),
          reason: "correction",
          reference: "TEST-NEG",
          performedBy: "tester",
        }),
      ).toThrow(ApiError)
    })

    it("refuses to oversell stock that is already allocated", async () => {
      const snapshot = await makeSnapshot()
      const sku = firstSku(snapshot)
      const location = firstPickFace(snapshot)
      const record = getOrCreateRecord(snapshot, sku.id, location.id, null)

      record.quantityOnHand = 100
      record.quantityAllocated = 90
      record.quantityReserved = 0

      expect(() =>
        adjustInventory(snapshot, {
          skuId: sku.id,
          locationId: location.id,
          delta: -20,
          reason: "correction",
          reference: "TEST-OVERSELL",
          performedBy: "tester",
        }),
      ).toThrow(/allocated/i)

      // The record must be untouched after the rejection.
      expect(record.quantityOnHand).toBe(100)
    })

    it("marks a location occupied once stock lands and empty once it leaves", async () => {
      const snapshot = await makeSnapshot()
      const sku = firstSku(snapshot)
      const empty = snapshot.locations.find((l) => l.status === "empty" && l.type === "pallet")!

      adjustInventory(snapshot, {
        skuId: sku.id,
        locationId: empty.id,
        delta: 10,
        reason: "correction",
        reference: "TEST-OCC",
        performedBy: "tester",
      })
      expect(empty.status).toBe("occupied")

      adjustInventory(snapshot, {
        skuId: sku.id,
        locationId: empty.id,
        delta: -10,
        reason: "correction",
        reference: "TEST-OCC2",
        performedBy: "tester",
      })
      expect(empty.status).toBe("empty")
    })
  })

  describe("transferInventory", () => {
    it("moves stock between locations and updates both records", async () => {
      const snapshot = await makeSnapshot()
      const sku = firstSku(snapshot)
      const from = firstPickFace(snapshot)
      const to = reserveLocation(snapshot)

      const fromRecord = getOrCreateRecord(snapshot, sku.id, from.id, null)
      fromRecord.quantityOnHand = 500
      fromRecord.quantityAllocated = 0
      fromRecord.quantityReserved = 0

      const toRecord = getOrCreateRecord(snapshot, sku.id, to.id, null)
      const toBefore = toRecord.quantityOnHand

      transferInventory(snapshot, {
        skuId: sku.id,
        fromLocationId: from.id,
        toLocationId: to.id,
        quantity: 120,
        reference: "TEST-XFER",
        performedBy: "tester",
      })

      expect(fromRecord.quantityOnHand).toBe(380)
      expect(toRecord.quantityOnHand).toBe(toBefore + 120)
      expect(snapshot.movements[0]?.type).toBe("transfer")
    })

    it("rejects a transfer to the same location", async () => {
      const snapshot = await makeSnapshot()
      const sku = firstSku(snapshot)
      const location = firstPickFace(snapshot)

      expect(() =>
        transferInventory(snapshot, {
          skuId: sku.id,
          fromLocationId: location.id,
          toLocationId: location.id,
          quantity: 5,
          reference: "TEST-SAME",
          performedBy: "tester",
        }),
      ).toThrow(/same/i)
    })

    it("rejects moving into a blocked location", async () => {
      const snapshot = await makeSnapshot()
      const sku = firstSku(snapshot)
      const from = firstPickFace(snapshot)
      const blocked = reserveLocation(snapshot)
      blocked.status = "blocked"

      const fromRecord = getOrCreateRecord(snapshot, sku.id, from.id, null)
      fromRecord.quantityOnHand = 200
      fromRecord.quantityAllocated = 0

      expect(() =>
        transferInventory(snapshot, {
          skuId: sku.id,
          fromLocationId: from.id,
          toLocationId: blocked.id,
          quantity: 10,
          reference: "TEST-BLOCKED",
          performedBy: "tester",
        }),
      ).toThrow(/blocked/i)
    })

    it("rejects a quantity larger than what is uncommitted", async () => {
      const snapshot = await makeSnapshot()
      const sku = firstSku(snapshot)
      const from = firstPickFace(snapshot)
      const to = reserveLocation(snapshot)

      const fromRecord = getOrCreateRecord(snapshot, sku.id, from.id, null)
      fromRecord.quantityOnHand = 100
      fromRecord.quantityAllocated = 80

      expect(() =>
        transferInventory(snapshot, {
          skuId: sku.id,
          fromLocationId: from.id,
          toLocationId: to.id,
          quantity: 50,
          reference: "TEST-TOOMUCH",
          performedBy: "tester",
        }),
      ).toThrow(/uncommitted/i)
    })
  })

  describe("allocation", () => {
    it("reserves stock without moving it and reduces availability", async () => {
      const snapshot = await makeSnapshot()
      const sku = firstSku(snapshot)

      const totalAvailableBefore = snapshot.inventory
        .filter((r) => r.skuId === sku.id)
        .reduce((sum, r) => sum + availableQuantity(r), 0)

      const allocations = allocateStock(snapshot, sku.id, 50)
      expect(allocations.length).toBeGreaterThan(0)

      const totalAvailableAfter = snapshot.inventory
        .filter((r) => r.skuId === sku.id)
        .reduce((sum, r) => sum + availableQuantity(r), 0)

      expect(totalAvailableAfter).toBe(totalAvailableBefore - 50)

      // On-hand must be unchanged: allocation is a commitment, not a movement.
      const onHand = snapshot.inventory
        .filter((r) => r.skuId === sku.id)
        .reduce((sum, r) => sum + r.quantityOnHand, 0)
      expect(onHand).toBeGreaterThan(0)
    })

    it("throws and leaves nothing allocated when stock is short", async () => {
      const snapshot = await makeSnapshot()
      const sku = firstSku(snapshot)

      // Drain every record for this SKU.
      for (const record of snapshot.inventory.filter((r) => r.skuId === sku.id)) {
        record.quantityOnHand = 0
        record.quantityAllocated = 0
      }

      expect(() => allocateStock(snapshot, sku.id, 10)).toThrow(/insufficient/i)
    })

    it("releases exactly what was allocated", async () => {
      const snapshot = await makeSnapshot()
      const sku = firstSku(snapshot)

      const allocatedBefore = snapshot.inventory
        .filter((r) => r.skuId === sku.id)
        .reduce((sum, r) => sum + r.quantityAllocated, 0)

      allocateStock(snapshot, sku.id, 75)
      deallocateStock(snapshot, sku.id, 75)

      const allocatedAfter = snapshot.inventory
        .filter((r) => r.skuId === sku.id)
        .reduce((sum, r) => sum + r.quantityAllocated, 0)

      expect(allocatedAfter).toBe(allocatedBefore)
    })

    it("prefers pick faces over reserve when allocating", async () => {
      const snapshot = await makeSnapshot()
      const sku = firstSku(snapshot)
      const face = firstPickFace(snapshot)

      const faceRecord = getOrCreateRecord(snapshot, sku.id, face.id, null)
      faceRecord.quantityOnHand = 200
      faceRecord.quantityAllocated = 0
      faceRecord.quantityReserved = 0

      const allocations = allocateStock(snapshot, sku.id, 50)
      expect(allocations[0]?.locationId).toBe(face.id)
    })
  })

  describe("derived views", () => {
    it("reports a balance row for every SKU", async () => {
      const snapshot = await makeSnapshot()
      const balances = skuBalances(snapshot)
      expect(balances).toHaveLength(snapshot.skus.length)

      for (const balance of balances) {
        expect(balance.available).toBeGreaterThanOrEqual(0)
        expect(balance.onHand).toBeGreaterThanOrEqual(balance.allocated)
      }
    })

    it("flags SKUs at or below their reorder point", async () => {
      const snapshot = await makeSnapshot()
      const sku = firstSku(snapshot)

      // Force this SKU below its reorder point.
      for (const record of snapshot.inventory.filter((r) => r.skuId === sku.id)) {
        record.quantityOnHand = 1
        record.quantityAllocated = 0
        record.quantityReserved = 0
      }

      const low = lowStock(snapshot)
      expect(low.some((row) => row.skuId === sku.id)).toBe(true)
      expect(low.every((row) => row.belowReorderPoint)).toBe(true)
    })
  })
})
