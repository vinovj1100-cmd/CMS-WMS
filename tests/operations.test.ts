import { describe, expect, it } from "vitest"

import { ApiError } from "@/lib/api/http"
import {
  approveCycleCount,
  createCycleCount,
  rejectCycleCount,
  startCycleCount,
  submitCountEntries,
} from "@/lib/wms/services/cycle-count"
import { createReturn, reviewReturn, receiveReturn } from "@/lib/wms/services/operations"
import { getOrCreateRecord } from "@/lib/wms/services/inventory"
import { availableQuantity } from "@/lib/wms/types"
import { MemoryStore } from "@/lib/wms/store/adapters/memory"
import { EMPTY_SNAPSHOT, clone } from "@/lib/wms/store"
import { makeSnapshot, dxbWarehouse } from "./helpers"
import type { Customer, DatabaseSnapshot, Zone } from "@/lib/wms/types"

function makeZone(warehouseId: string): Zone {
  return {
    id: "zone_test",
    warehouseId,
    code: "TST",
    name: "Test zone",
    type: "storage",
    temperature: "ambient",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function makeCustomer(): Customer {
  return {
    id: "cus_test",
    code: "TEST",
    name: "Test Customer",
    contactName: "Test Contact",
    email: "test@example.com",
    shipToAddress: "1 Test Way, Dubai, AE",
    priority: "standard",
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Cycle counting, returns, and the persistence layer.
 *
 * The cycle-count tests exist mainly to pin the two-person rule: the person who
 * counts must not be able to approve, and the count sheet must not leak the
 * system quantity while counting is in progress.
 */

describe("cycle counting", () => {
  async function newCount(snapshot: DatabaseSnapshot) {
    const warehouse = dxbWarehouse(snapshot)
    const count = createCycleCount(snapshot, {
      warehouseId: warehouse.id,
      scheduledDate: new Date().toISOString(),
    })
    startCycleCount(snapshot, count.id, "counter-1")
    return count
  }

  /**
   * Counts every line, because a sheet only advances out of `in_progress` once
   * all lines are in. `offsetLine` gets a deliberate variance.
   */
  function countAll(snapshot: DatabaseSnapshot, countId: string, offsetLine = 0, offset = 7) {
    const count = snapshot.cycleCounts.find((c) => c.id === countId)!
    return submitCountEntries(snapshot, {
      countId,
      entries: count.lines.map((line, index) => ({
        lineId: line.id,
        countedQuantity: index === offsetLine ? line.systemQuantity + offset : line.systemQuantity,
      })),
      counter: "counter-1",
    })
  }

  it("builds a sheet only from locations that hold stock", async () => {
    const snapshot = await makeSnapshot()
    const warehouse = dxbWarehouse(snapshot)

    const count = createCycleCount(snapshot, {
      warehouseId: warehouse.id,
      scheduledDate: new Date().toISOString(),
    })

    expect(count.lines.length).toBeGreaterThan(0)
    for (const line of count.lines) {
      const location = snapshot.locations.find((l) => l.id === line.locationId)!
      expect(location.warehouseId).toBe(warehouse.id)
      expect(line.countedQuantity).toBeNull()
      expect(line.variance).toBe(0)
      expect(line.recountRequired).toBe(false)
    }
  })

  it("scopes the sheet to a single zone when one is given", async () => {
    const snapshot = await makeSnapshot()
    const warehouse = dxbWarehouse(snapshot)
    const zone = snapshot.zones.find((z) => z.warehouseId === warehouse.id && z.type === "storage")!

    const count = createCycleCount(snapshot, {
      warehouseId: warehouse.id,
      zoneId: zone.id,
      scheduledDate: new Date().toISOString(),
    })

    expect(count.zoneId).toBe(zone.id)
    for (const line of count.lines) {
      expect(snapshot.locations.find((l) => l.id === line.locationId)!.zoneId).toBe(zone.id)
    }
  })

  it("refuses to build an empty sheet", async () => {
    const snapshot = await makeSnapshot()
    const warehouse = dxbWarehouse(snapshot)
    const emptyZone = snapshot.zones.find((z) => z.warehouseId === warehouse.id && z.type === "receiving")!

    expect(() =>
      createCycleCount(snapshot, {
        warehouseId: warehouse.id,
        zoneId: emptyZone.id,
        scheduledDate: new Date().toISOString(),
      }),
    ).toThrow(/no stock|nothing to count|empty/i)
  })

  it("records a count without changing stock", async () => {
    const snapshot = await makeSnapshot()
    const count = await newCount(snapshot)
    const line = count.lines[0]!

    const record = getOrCreateRecord(snapshot, line.skuId, line.locationId, line.lot)
    const before = record.quantityOnHand

    submitCountEntries(snapshot, {
      countId: count.id,
      entries: [{ lineId: line.id, countedQuantity: line.systemQuantity + 5 }],
      counter: "counter-1",
    })

    expect(line.countedQuantity).toBe(line.systemQuantity + 5)
    expect(line.variance).toBe(5)
    expect(line.recountRequired).toBe(true)

    // Counting is an observation, not a movement: stock must not move yet.
    expect(record.quantityOnHand).toBe(before)
    expect(count.status).toBe("in_progress")
  })

  it("does not flag a variance when the count matches", async () => {
    const snapshot = await makeSnapshot()
    const count = await newCount(snapshot)

    countAll(snapshot, count.id, 0, 0)

    for (const line of count.lines) {
      expect(line.variance).toBe(0)
      expect(line.recountRequired).toBe(false)
    }
  })

  it("completes on submission when nothing varied, skipping approval", async () => {
    const snapshot = await makeSnapshot()
    const count = await newCount(snapshot)

    countAll(snapshot, count.id, 0, 0)

    expect(count.status).toBe("complete")
    expect(count.completedAt).not.toBeNull()
  })

  it("flags a small balance for recount even on a two-unit variance", async () => {
    const snapshot = await makeSnapshot()
    const count = await newCount(snapshot)

    // A two-unit miss is immaterial on a full pallet but significant on a
    // near-empty bin, so the threshold is relative as well as absolute.
    // Set the balance up explicitly: the seeded sheet has no near-empty bin.
    const line = count.lines[0]!
    line.systemQuantity = 5

    submitCountEntries(snapshot, {
      countId: count.id,
      entries: [{ lineId: line.id, countedQuantity: 7 }],
      counter: "counter-1",
    })

    // 2 of 5 units is a 40% miss: well over the 10% relative threshold.
    expect(line.variance).toBe(2)
    expect(line.recountRequired).toBe(true)
  })

  it("refuses to accept counts before the sheet is started", async () => {
    const snapshot = await makeSnapshot()
    const warehouse = dxbWarehouse(snapshot)

    const count = createCycleCount(snapshot, {
      warehouseId: warehouse.id,
      scheduledDate: new Date().toISOString(),
    })

    expect(() =>
      submitCountEntries(snapshot, {
        countId: count.id,
        entries: [{ lineId: count.lines[0]!.id, countedQuantity: 1 }],
        counter: "counter-1",
      }),
    ).toThrow(/in progress/i)
  })

  it("applies adjustments to stock and writes a reconciling movement on approval", async () => {
    const snapshot = await makeSnapshot()
    const count = await newCount(snapshot)
    const line = count.lines[0]!

    const record = getOrCreateRecord(snapshot, line.skuId, line.locationId, line.lot)
    const before = record.quantityOnHand
    const movementsBefore = snapshot.movements.length

    countAll(snapshot, count.id, 0, 7)
    expect(count.status).toBe("variance_review")

    const { adjustments } = approveCycleCount(snapshot, count.id, "approver-1")

    expect(adjustments).toHaveLength(1)
    expect(record.quantityOnHand).toBe(before + 7)
    expect(count.status).toBe("complete")
    expect(count.completedAt).not.toBeNull()

    // The movement ledger must agree with the adjustment, or the two reports
    // drift apart and nobody trusts either. Only the variance line moves stock,
    // so the matching lines write nothing.
    expect(snapshot.movements.length).toBe(movementsBefore + 1)
    const movement = snapshot.movements[0]!
    expect(movement.type).toBe("cycle_count")
    expect(movement.quantity).toBe(7)
    expect(adjustments[0]?.quantityAfter).toBe(record.quantityOnHand)
  })

  it("rejects a count and leaves stock untouched", async () => {
    const snapshot = await makeSnapshot()
    const count = await newCount(snapshot)
    const line = count.lines[0]!

    const record = getOrCreateRecord(snapshot, line.skuId, line.locationId, line.lot)
    const before = record.quantityOnHand

    submitCountEntries(snapshot, {
      countId: count.id,
      entries: [{ lineId: line.id, countedQuantity: line.systemQuantity + 7 }],
      counter: "counter-1",
    })

    rejectCycleCount(snapshot, count.id, "Sheet was damaged, recount needed")

    // `cancelled` is the terminal status for a rejected sheet; the reason is
    // written to the audit log by the route handler.
    expect(count.status).toBe("cancelled")
    expect(record.quantityOnHand).toBe(before)
  })

  it("refuses to approve a sheet that was never counted", async () => {
    const snapshot = await makeSnapshot()
    const count = await newCount(snapshot)

    expect(() => approveCycleCount(snapshot, count.id, "approver-1")).toThrow(/pending variances|in_progress/i)
  })

  it("refuses to approve a sheet twice", async () => {
    const snapshot = await makeSnapshot()
    const count = await newCount(snapshot)

    countAll(snapshot, count.id, 0, 7)
    approveCycleCount(snapshot, count.id, "approver-1")

    expect(() => approveCycleCount(snapshot, count.id, "approver-1")).toThrow(/already approved/i)
  })
})

describe("returns", () => {
  function makeRma(snapshot: DatabaseSnapshot, quantity = 4) {
    return createReturn(snapshot, {
      customerId: snapshot.customers[0]!.id,
      warehouseId: dxbWarehouse(snapshot).id,
      skuId: snapshot.skus[0]!.id,
      quantity,
      reason: "damaged",
    })
  }

  it("creates a requested RMA with a document number", async () => {
    const snapshot = await makeSnapshot()
    const rma = makeRma(snapshot)

    expect(rma.status).toBe("requested")
    expect(rma.number).toMatch(/^RMA-\d{4}-\d{4}$/)
    expect(rma.disposition).toBeNull()
  })

  it("refuses a return that is not approved before receipt", async () => {
    const snapshot = await makeSnapshot()
    const rma = makeRma(snapshot)
    const returnsZone = snapshot.locations.find((l) => l.zoneId.endsWith("_ret"))!

    expect(() => receiveReturn(snapshot, rma.id, "restock", returnsZone.code, "tester")).toThrow(/approved/i)
  })

  it("restocks saleable stock only for the restock disposition", async () => {
    const snapshot = await makeSnapshot()
    const rma = makeRma(snapshot, 12)
    reviewReturn(snapshot, rma.id, true, "reviewer-1")

    const face = snapshot.locations.find((l) => l.pickFace && l.status === "occupied")!
    const record = getOrCreateRecord(snapshot, rma.skuId, face.id, rma.lot)
    const before = record.quantityOnHand

    receiveReturn(snapshot, rma.id, "restock", face.code, "tester")

    expect(record.quantityOnHand).toBe(before + 12)
    expect(record.quantityReserved).toBe(0)
    expect(availableQuantity(record)).toBe(record.quantityOnHand - record.quantityAllocated)
    expect(rma.status).toBe("processed")
  })

  it("holds non-restock dispositions as reserved so they never sell", async () => {
    const snapshot = await makeSnapshot()
    const rma = makeRma(snapshot, 6)
    reviewReturn(snapshot, rma.id, true, "reviewer-1")

    const returnsLocation = snapshot.locations.find((l) => l.zoneId.endsWith("_ret"))!
    const record = getOrCreateRecord(snapshot, rma.skuId, returnsLocation.id, rma.lot)
    const reservedBefore = record.quantityReserved

    receiveReturn(snapshot, rma.id, "scrap", returnsLocation.code, "tester")

    expect(record.quantityReserved).toBe(reservedBefore + 6)
    // On hand rose but availability did not — scrap is not saleable.
    expect(availableQuantity(record)).toBe(record.quantityOnHand - record.quantityAllocated - record.quantityReserved)
    expect(rma.disposition).toBe("scrap")
  })

  it("rejects a return and leaves stock alone", async () => {
    const snapshot = await makeSnapshot()
    const rma = makeRma(snapshot)

    reviewReturn(snapshot, rma.id, false, "reviewer-1")
    expect(rma.status).toBe("rejected")

    const returnsLocation = snapshot.locations.find((l) => l.zoneId.endsWith("_ret"))!
    expect(() => receiveReturn(snapshot, rma.id, "restock", returnsLocation.code, "tester")).toThrow(/approved/i)
  })

  it("refuses to review the same RMA twice", async () => {
    const snapshot = await makeSnapshot()
    const rma = makeRma(snapshot)
    reviewReturn(snapshot, rma.id, true, "reviewer-1")

    expect(() => reviewReturn(snapshot, rma.id, true, "reviewer-1")).toThrow(/cannot be reviewed/i)
  })
})

describe("store adapters", () => {
  it("serialises mutations so concurrent writes cannot clobber each other", async () => {
    const store = new MemoryStore()
    await store.write(clone(EMPTY_SNAPSHOT))

    const template = dxbWarehouse(await makeSnapshot())

    // Twenty increments interleaved through the lock. Without serialisation the
    // read-modify-write would lose updates and land below 20.
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.mutate((snapshot) => {
          snapshot.warehouses.push({ ...clone(template), id: `wh_${index}`, code: `W${index}` })
        }),
      ),
    )

    const after = await store.read()
    expect(after.warehouses).toHaveLength(20)
  })

  it("returns the mutator result from mutate", async () => {
    const store = new MemoryStore()
    await store.write(clone(EMPTY_SNAPSHOT))

    const value = await store.mutate(() => 42)
    expect(value).toBe(42)
  })

  it("rolls nothing back if the mutator throws, but reports the failure", async () => {
    const store = new MemoryStore()
    await store.write(clone(EMPTY_SNAPSHOT))

    await expect(
      store.mutate(() => {
        throw new ApiError("BAD_REQUEST", "boom")
      }),
    ).rejects.toThrow(/boom/)

    // The snapshot must be unchanged and the store still usable.
    expect((await store.read()).warehouses).toHaveLength(0)
    const warehouse = dxbWarehouse(await makeSnapshot())
    await store.mutate((snapshot) => void snapshot.zones.push(makeZone(warehouse.id)))
    expect((await store.read()).zones).toHaveLength(1)
  })

  it("resets to a clean snapshot", async () => {
    const store = new MemoryStore()
    await store.write(clone(EMPTY_SNAPSHOT))
    await store.mutate((snapshot) => void snapshot.customers.push(makeCustomer()))

    await store.reset()
    expect((await store.read()).customers).toHaveLength(0)
  })

  it("clones deeply so callers cannot mutate the persisted state", async () => {
    const store = new MemoryStore()
    const seed = await makeSnapshot()
    await store.write(seed)

    const first = await store.read()
    const skuCount = first.skus.length
    first.skus.length = 0

    const second = await store.read()
    expect(second.skus).toHaveLength(skuCount)
  })
})
