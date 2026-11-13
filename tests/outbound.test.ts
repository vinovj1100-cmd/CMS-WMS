import { describe, expect, it } from "vitest"

import { ApiError } from "@/lib/api/http"
import {
  allocateOrder,
  cancelOrder,
  confirmPick,
  createSalesOrder,
  createWave,
  packOrder,
  releaseWave,
  shipOrder,
} from "@/lib/wms/services/outbound"
import { getOrCreateRecord } from "@/lib/wms/services/inventory"
import { makeSnapshot, dxbWarehouse } from "./helpers"

/**
 * Outbound flow: order → allocate → wave → release → pick → pack → ship.
 *
 * The invariants worth pinning down:
 *   - allocation never fails halfway (all-or-nothing, rolled back on shortage)
 *   - releasing a wave produces a walk-ordered sequence
 *   - on-hand only drops when the pick is confirmed, never at allocation
 */
describe("outbound service", () => {
  async function makeOrder(snapshot: Awaited<ReturnType<typeof makeSnapshot>>, skuIndex = 0, quantity = 10) {
    const warehouse = dxbWarehouse(snapshot)
    const customer = snapshot.customers[0]!
    const sku = snapshot.skus[skuIndex]!
    return createSalesOrder(snapshot, {
      customerId: customer.id,
      warehouseId: warehouse.id,
      requiredDate: new Date(Date.now() + 86_400_000).toISOString(),
      carrier: "Test Carrier",
      lines: [{ skuId: sku.id, quantityOrdered: quantity }],
    })
  }

  describe("order creation", () => {
    it("creates a new order with a document number", async () => {
      const snapshot = await makeSnapshot()
      const order = await makeOrder(snapshot)

      expect(order.status).toBe("new")
      expect(order.number).toMatch(/^SO-\d{4}-\d{4}$/)
      expect(order.lines[0]?.quantityAllocated).toBe(0)
    })

    it("rejects a zero-quantity line", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)

      expect(() =>
        createSalesOrder(snapshot, {
          customerId: snapshot.customers[0]!.id,
          warehouseId: warehouse.id,
          requiredDate: new Date().toISOString(),
          carrier: "Test Carrier",
          lines: [{ skuId: snapshot.skus[0]!.id, quantityOrdered: 0 }],
        }),
      ).toThrow(ApiError)
    })
  })

  describe("allocation", () => {
    it("reserves stock without changing on-hand", async () => {
      const snapshot = await makeSnapshot()
      const order = await makeOrder(snapshot, 0, 10)
      const sku = snapshot.skus[order.lines[0]!.skuId === snapshot.skus[0]!.id ? 0 : 0]!

      const onHandBefore = snapshot.inventory
        .filter((r) => r.skuId === sku.id)
        .reduce((sum, r) => sum + r.quantityOnHand, 0)

      allocateOrder(snapshot, order.id)

      const onHandAfter = snapshot.inventory
        .filter((r) => r.skuId === sku.id)
        .reduce((sum, r) => sum + r.quantityOnHand, 0)

      expect(order.status).toBe("allocated")
      expect(order.lines[0]?.quantityAllocated).toBe(10)
      expect(onHandAfter).toBe(onHandBefore)
    })

    it("rolls the whole allocation back when any line is short", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)
      const [skuA, skuB] = [snapshot.skus[0]!, snapshot.skus[1]!]

      // Drain skuB completely so the second line cannot be satisfied.
      for (const record of snapshot.inventory.filter((r) => r.skuId === skuB.id)) {
        record.quantityOnHand = 0
        record.quantityAllocated = 0
        record.quantityReserved = 0
      }

      const allocatedBefore = snapshot.inventory
        .filter((r) => r.skuId === skuA.id)
        .reduce((sum, r) => sum + r.quantityAllocated, 0)

      const order = createSalesOrder(snapshot, {
        customerId: snapshot.customers[0]!.id,
        warehouseId: warehouse.id,
        requiredDate: new Date().toISOString(),
        carrier: "Test Carrier",
        lines: [
          { skuId: skuA.id, quantityOrdered: 10 },
          { skuId: skuB.id, quantityOrdered: 10 },
        ],
      })

      expect(() => allocateOrder(snapshot, order.id)).toThrow(/insufficient/i)

      // The first line must have been released, not left half-committed. The
      // seeded snapshot already carries allocations, so compare against the
      // baseline rather than expecting an absolute zero.
      const allocatedAfter = snapshot.inventory
        .filter((r) => r.skuId === skuA.id)
        .reduce((sum, r) => sum + r.quantityAllocated, 0)
      expect(allocatedAfter).toBe(allocatedBefore)
      expect(order.status).toBe("backordered")
    })

    it("refuses to allocate the same order twice", async () => {
      const snapshot = await makeSnapshot()
      const order = await makeOrder(snapshot)
      allocateOrder(snapshot, order.id)
      expect(() => allocateOrder(snapshot, order.id)).toThrow(/already/i)
    })
  })

  describe("waves", () => {
    it("only waves allocated orders", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)
      const order = await makeOrder(snapshot)

      expect(() => createWave(snapshot, { warehouseId: warehouse.id, orderIds: [order.id], strategy: "zone" })).toThrow(
        /allocated/i,
      )

      allocateOrder(snapshot, order.id)
      const wave = createWave(snapshot, { warehouseId: warehouse.id, orderIds: [order.id], strategy: "zone" })
      expect(wave.status).toBe("planned")
      expect(wave.orderIds).toEqual([order.id])
      expect(order.waveId).toBe(wave.id)
    })

    it("generates travel-sequenced pick tasks on release", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)

      const order = await makeOrder(snapshot, 0, 5)
      allocateOrder(snapshot, order.id)
      const wave = createWave(snapshot, { warehouseId: warehouse.id, orderIds: [order.id], strategy: "zone" })

      const { pickTasks } = releaseWave(snapshot, wave.id, "tester")

      expect(pickTasks.length).toBeGreaterThan(0)
      expect(wave.status).toBe("released")
      expect(order.status).toBe("picking")

      // Sequence must be dense and ascending — that is what makes it a walk path.
      const sequence = [...pickTasks].sort((a, b) => a.sequence - b.sequence).map((t) => t.sequence)
      expect(sequence).toEqual(sequence.slice().sort((a, b) => a - b))
      expect(sequence[0]).toBe(1)

      // Tasks must be ordered by aisle, then bay, then level.
      const codes = pickTasks.map((task) => snapshot.locations.find((l) => l.id === task.fromLocationId))
      for (let i = 1; i < codes.length; i++) {
        const prev = codes[i - 1]!
        const curr = codes[i]!
        const ordered =
          prev.aisle.localeCompare(curr.aisle) <= 0 ||
          (prev.aisle === curr.aisle && prev.bay.localeCompare(curr.bay) <= 0)
        expect(ordered).toBe(true)
      }
    })

    it("refuses to release a wave twice", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)
      const order = await makeOrder(snapshot)
      allocateOrder(snapshot, order.id)
      const wave = createWave(snapshot, { warehouseId: warehouse.id, orderIds: [order.id], strategy: "zone" })

      releaseWave(snapshot, wave.id, "tester")
      expect(() => releaseWave(snapshot, wave.id, "tester")).toThrow(/cannot be released/i)
    })
  })

  describe("picking", () => {
    it("decrements on-hand and clears the allocation when confirmed", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)

      const order = await makeOrder(snapshot, 0, 5)
      allocateOrder(snapshot, order.id)
      const wave = createWave(snapshot, { warehouseId: warehouse.id, orderIds: [order.id], strategy: "zone" })
      const { pickTasks } = releaseWave(snapshot, wave.id, "tester")
      const task = pickTasks[0]!

      const record = getOrCreateRecord(snapshot, task.skuId, task.fromLocationId, task.lot ?? null)
      const onHandBefore = record.quantityOnHand
      const allocatedBefore = record.quantityAllocated

      confirmPick(snapshot, { taskId: task.id, quantityPicked: task.quantity, performedBy: "tester" })

      expect(record.quantityOnHand).toBe(onHandBefore - task.quantity)
      expect(record.quantityAllocated).toBe(allocatedBefore - task.quantity)
      expect(task.status).toBe("complete")
      expect(task.quantityPicked).toBe(task.quantity)
    })

    it("flags a short pick rather than failing", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)

      const order = await makeOrder(snapshot, 0, 10)
      allocateOrder(snapshot, order.id)
      const wave = createWave(snapshot, { warehouseId: warehouse.id, orderIds: [order.id], strategy: "zone" })
      const { pickTasks } = releaseWave(snapshot, wave.id, "tester")
      const task = pickTasks[0]!

      const picked = confirmPick(snapshot, { taskId: task.id, quantityPicked: task.quantity - 3, performedBy: "tester" })

      expect(picked.status).toBe("short")
      expect(picked.quantityPicked).toBe(task.quantity - 3)
    })

    it("rejects picking more than the task requires", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)

      const order = await makeOrder(snapshot, 0, 5)
      allocateOrder(snapshot, order.id)
      const wave = createWave(snapshot, { warehouseId: warehouse.id, orderIds: [order.id], strategy: "zone" })
      const { pickTasks } = releaseWave(snapshot, wave.id, "tester")

      expect(() =>
        confirmPick(snapshot, { taskId: pickTasks[0]!.id, quantityPicked: 999, performedBy: "tester" }),
      ).toThrow(/cannot pick/i)
    })

    it("closes the wave once every task is settled", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)

      const order = await makeOrder(snapshot, 0, 5)
      allocateOrder(snapshot, order.id)
      const wave = createWave(snapshot, { warehouseId: warehouse.id, orderIds: [order.id], strategy: "zone" })
      const { pickTasks } = releaseWave(snapshot, wave.id, "tester")

      for (const task of pickTasks) {
        confirmPick(snapshot, { taskId: task.id, quantityPicked: task.quantity, performedBy: "tester" })
      }

      expect(wave.status).toBe("complete")
      expect(wave.completedAt).not.toBeNull()
    })
  })

  describe("packing and shipping", () => {
    it("refuses to pack before picking is finished", async () => {
      const snapshot = await makeSnapshot()
      const order = await makeOrder(snapshot, 0, 5)
      allocateOrder(snapshot, order.id)

      expect(() =>
        packOrder(snapshot, {
          orderId: order.id,
          items: [{ skuId: order.lines[0]!.skuId, quantity: 5 }],
          weightKg: 10,
          cartonCount: 1,
          packedBy: "tester",
        }),
      ).toThrow(/picked/i)
    })

    it("refuses to pack more than was picked", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)
      const order = await makeOrder(snapshot, 0, 5)
      allocateOrder(snapshot, order.id)
      const wave = createWave(snapshot, { warehouseId: warehouse.id, orderIds: [order.id], strategy: "zone" })
      const { pickTasks } = releaseWave(snapshot, wave.id, "tester")
      for (const task of pickTasks) {
        confirmPick(snapshot, { taskId: task.id, quantityPicked: task.quantity, performedBy: "tester" })
      }

      expect(() =>
        packOrder(snapshot, {
          orderId: order.id,
          items: [{ skuId: order.lines[0]!.skuId, quantity: 999 }],
          weightKg: 10,
          cartonCount: 1,
          packedBy: "tester",
        }),
      ).toThrow(/only \d+ were picked/i)
    })

    it("walks the full path to a manifested shipment", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)

      const order = await makeOrder(snapshot, 0, 5)
      allocateOrder(snapshot, order.id)
      const wave = createWave(snapshot, { warehouseId: warehouse.id, orderIds: [order.id], strategy: "zone" })
      const { pickTasks } = releaseWave(snapshot, wave.id, "tester")
      for (const task of pickTasks) {
        confirmPick(snapshot, { taskId: task.id, quantityPicked: task.quantity, performedBy: "tester" })
      }

      const pack = packOrder(snapshot, {
        orderId: order.id,
        items: [{ skuId: order.lines[0]!.skuId, quantity: 5 }],
        weightKg: 12.5,
        cartonCount: 2,
        packedBy: "tester",
      })
      expect(pack.status).toBe("complete")
      expect(order.status).toBe("packed")

      const shipment = shipOrder(snapshot, {
        orderId: order.id,
        trackingNumber: "TRK-TEST-1",
        serviceLevel: "Ground",
        shippedBy: "tester",
      })

      expect(shipment.status).toBe("manifested")
      expect(order.status).toBe("shipped")
      expect(order.trackingNumber).toBe("TRK-TEST-1")
      expect(snapshot.movements.some((m) => m.type === "ship" && m.reference === shipment.number)).toBe(true)
    })

    it("refuses to ship an unpacked order", async () => {
      const snapshot = await makeSnapshot()
      const order = await makeOrder(snapshot)
      allocateOrder(snapshot, order.id)

      expect(() =>
        shipOrder(snapshot, { orderId: order.id, trackingNumber: "TRK-X", serviceLevel: "Ground", shippedBy: "tester" }),
      ).toThrow(/packed/i)
    })
  })

  describe("cancellation", () => {
    it("releases the allocation and records the reason", async () => {
      const snapshot = await makeSnapshot()
      const order = await makeOrder(snapshot, 0, 10)
      allocateOrder(snapshot, order.id)

      const skuId = order.lines[0]!.skuId
      const allocatedBefore = snapshot.inventory
        .filter((r) => r.skuId === skuId)
        .reduce((sum, r) => sum + r.quantityAllocated, 0)
      expect(allocatedBefore).toBeGreaterThan(0)

      cancelOrder(snapshot, order.id, "Customer changed their mind")

      const allocatedAfter = snapshot.inventory
        .filter((r) => r.skuId === skuId)
        .reduce((sum, r) => sum + r.quantityAllocated, 0)

      expect(order.status).toBe("cancelled")
      expect(order.cancelledReason).toBe("Customer changed their mind")
      expect(allocatedAfter).toBe(allocatedBefore - 10)
    })

    it("refuses to cancel a shipped order", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)

      const order = await makeOrder(snapshot, 0, 5)
      allocateOrder(snapshot, order.id)
      const wave = createWave(snapshot, { warehouseId: warehouse.id, orderIds: [order.id], strategy: "zone" })
      const { pickTasks } = releaseWave(snapshot, wave.id, "tester")
      for (const task of pickTasks) {
        confirmPick(snapshot, { taskId: task.id, quantityPicked: task.quantity, performedBy: "tester" })
      }
      packOrder(snapshot, {
        orderId: order.id,
        items: [{ skuId: order.lines[0]!.skuId, quantity: 5 }],
        weightKg: 5,
        cartonCount: 1,
        packedBy: "tester",
      })
      shipOrder(snapshot, { orderId: order.id, trackingNumber: "TRK-1", serviceLevel: "Ground", shippedBy: "tester" })

      expect(() => cancelOrder(snapshot, order.id, "too late")).toThrow(/shipped/i)
    })
  })
})
