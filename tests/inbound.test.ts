import { describe, expect, it } from "vitest"

import {
  advanceInbound,
  completePutaway,
  createInboundShipment,
  createPurchaseOrder,
  createPutawayTask,
  receiveLine,
  suggestPutawayLocation,
  submitPurchaseOrder,
} from "@/lib/wms/services/inbound"
import { getOrCreateRecord } from "@/lib/wms/services/inventory"
import { ApiError } from "@/lib/api/http"
import { makeSnapshot, dxbWarehouse } from "./helpers"

/**
 * Inbound flow: purchase order → ASN → advance → receive → putaway.
 *
 * The property that matters most here is that stock is *not* saleable until
 * putaway completes. Receiving lands it in a hold; putaway releases it.
 */
describe("inbound service", () => {
  describe("purchase orders", () => {
    it("creates a draft PO with a document number and no receipts", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)
      const supplier = snapshot.suppliers[0]!
      const sku = snapshot.skus[0]!

      const po = createPurchaseOrder(snapshot, {
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        expectedDate: new Date().toISOString(),
        lines: [{ skuId: sku.id, quantityOrdered: 100 }],
        createdBy: "tester",
      })

      expect(po.status).toBe("draft")
      expect(po.number).toMatch(/^PO-\d{4}-\d{4}$/)
      expect(po.lines[0]?.quantityReceived).toBe(0)
    })

    it("rejects a PO with no lines", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)

      expect(() =>
        createPurchaseOrder(snapshot, {
          supplierId: snapshot.suppliers[0]!.id,
          warehouseId: warehouse.id,
          expectedDate: new Date().toISOString(),
          lines: [],
          createdBy: "tester",
        }),
      ).toThrow(ApiError)
    })

    it("only allows a draft PO to be submitted", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)

      const po = createPurchaseOrder(snapshot, {
        supplierId: snapshot.suppliers[0]!.id,
        warehouseId: warehouse.id,
        expectedDate: new Date().toISOString(),
        lines: [{ skuId: snapshot.skus[0]!.id, quantityOrdered: 10 }],
        createdBy: "tester",
      })

      submitPurchaseOrder(snapshot, po.id)
      expect(po.status).toBe("submitted")

      expect(() => submitPurchaseOrder(snapshot, po.id)).toThrow(/draft/i)
    })
  })

  describe("ASN state machine", () => {
    it("advances one step at a time and refuses jumps", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)

      const asn = createInboundShipment(snapshot, {
        supplierId: snapshot.suppliers[0]!.id,
        warehouseId: warehouse.id,
        carrier: "Test Carrier",
        eta: new Date().toISOString(),
        dockDoor: "RCV-DOCK-01",
        lines: [{ skuId: snapshot.skus[0]!.id, quantityExpected: 50 }],
      })

      expect(asn.status).toBe("expected")

      // Cannot skip from expected straight to receiving.
      expect(() => advanceInbound(snapshot, asn.id, "receiving")).toThrow(/cannot move/i)

      advanceInbound(snapshot, asn.id, "arrived")
      advanceInbound(snapshot, asn.id, "unloading")
      advanceInbound(snapshot, asn.id, "receiving")
      expect(asn.status).toBe("receiving")
    })

    it("requires a lot number when receiving a lot-controlled SKU", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)
      const lotSku = snapshot.skus.find((s) => s.lotControlled)!

      const asn = createInboundShipment(snapshot, {
        supplierId: snapshot.suppliers[0]!.id,
        warehouseId: warehouse.id,
        carrier: "Test Carrier",
        eta: new Date().toISOString(),
        dockDoor: "RCV-DOCK-01",
        lines: [{ skuId: lotSku.id, quantityExpected: 100, lot: "LOT-202601" }],
      })
      advanceInbound(snapshot, asn.id, "arrived")
      advanceInbound(snapshot, asn.id, "unloading")
      advanceInbound(snapshot, asn.id, "receiving")

      // Receiving without the lot on the line is refused even though the ASN
      // carried one — the guard re-checks at the point stock actually moves.
      const line = asn.lines[0]!
      line.lot = null

      expect(() =>
        receiveLine(snapshot, {
          asnId: asn.id,
          lineId: line.id,
          quantityReceived: 10,
          receivedBy: "tester",
        }),
      ).toThrow(/lot/i)

      // This SKU is both lot- and expiry-controlled, so receipt needs both.
      // Supplying the lot alone is still refused.
      expect(() =>
        receiveLine(snapshot, {
          asnId: asn.id,
          lineId: line.id,
          quantityReceived: 10,
          lot: "LOT-202601",
          receivedBy: "tester",
        }),
      ).toThrow(/expiry/i)

      const accepted = receiveLine(snapshot, {
        asnId: asn.id,
        lineId: line.id,
        quantityReceived: 10,
        lot: "LOT-202601",
        expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        receivedBy: "tester",
      })
      expect(accepted.line.quantityReceived).toBe(10)
    })

    it("refuses over-receipt beyond the expected quantity", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)
      const sku = snapshot.skus[0]!

      const asn = createInboundShipment(snapshot, {
        supplierId: snapshot.suppliers[0]!.id,
        warehouseId: warehouse.id,
        carrier: "Test Carrier",
        eta: new Date().toISOString(),
        dockDoor: "RCV-DOCK-01",
        lines: [{ skuId: sku.id, quantityExpected: 20 }],
      })
      advanceInbound(snapshot, asn.id, "arrived")
      advanceInbound(snapshot, asn.id, "unloading")
      advanceInbound(snapshot, asn.id, "receiving")

      expect(() =>
        receiveLine(snapshot, {
          asnId: asn.id,
          lineId: asn.lines[0]!.id,
          quantityReceived: 21,
          receivedBy: "tester",
        }),
      ).toThrow(/over-receipt/i)
    })
  })

  describe("receiving and putaway", () => {
    it("holds received stock as reserved until putaway completes", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)
      const sku = snapshot.skus[0]!
      const dock = snapshot.locations.find((l) => l.code === "RCV-DOCK-01")!

      const asn = createInboundShipment(snapshot, {
        supplierId: snapshot.suppliers[0]!.id,
        warehouseId: warehouse.id,
        carrier: "Test Carrier",
        eta: new Date().toISOString(),
        dockDoor: "RCV-DOCK-01",
        lines: [{ skuId: sku.id, quantityExpected: 60 }],
      })
      advanceInbound(snapshot, asn.id, "arrived")
      advanceInbound(snapshot, asn.id, "unloading")
      advanceInbound(snapshot, asn.id, "receiving")

      const { putaway } = receiveLine(snapshot, {
        asnId: asn.id,
        lineId: asn.lines[0]!.id,
        quantityReceived: 60,
        receivedBy: "tester",
      })

      // At the dock: on hand, but fully held — not saleable.
      const dockRecord = getOrCreateRecord(snapshot, sku.id, dock.id, null)
      expect(dockRecord.quantityOnHand).toBeGreaterThanOrEqual(60)
      expect(dockRecord.quantityReserved).toBeGreaterThanOrEqual(60)

      // Putaway moves it to a storage location and releases the hold.
      const destination = suggestPutawayLocation(snapshot, sku.id, 60)!
      completePutaway(snapshot, putaway.id, destination, "tester")

      const storageRecord = getOrCreateRecord(snapshot, sku.id, destination, null)
      expect(storageRecord.quantityOnHand).toBeGreaterThanOrEqual(60)
      expect(storageRecord.quantityReserved).toBe(0)

      expect(dockRecord.quantityReserved).toBe(0)
      expect(putaway.status).toBe("complete")
      expect(putaway.actualLocationId).toBe(destination)
    })

    it("refuses to put away into a location that cannot hold the weight", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)
      const heavySku = [...snapshot.skus].sort((a, b) => b.dimensions.weightKg - a.dimensions.weightKg)[0]!

      const asn = createInboundShipment(snapshot, {
        supplierId: snapshot.suppliers[0]!.id,
        warehouseId: warehouse.id,
        carrier: "Test Carrier",
        eta: new Date().toISOString(),
        dockDoor: "RCV-DOCK-01",
        lines: [{ skuId: heavySku.id, quantityExpected: 1000 }],
      })
      advanceInbound(snapshot, asn.id, "arrived")
      advanceInbound(snapshot, asn.id, "unloading")
      advanceInbound(snapshot, asn.id, "receiving")

      const { putaway } = receiveLine(snapshot, {
        asnId: asn.id,
        lineId: asn.lines[0]!.id,
        quantityReceived: 1000,
        receivedBy: "tester",
      })

      // A pick-face shelf is capped at 250 kg; 1000 heavy units cannot fit.
      const shelf = snapshot.locations.find((l) => l.pickFace && l.capacityKg > 0 && l.capacityKg <= 250)!

      expect(() => completePutaway(snapshot, putaway.id, shelf.id, "tester")).toThrow(/exceed/i)
    })

    it("generates a putaway task that suggests a location", async () => {
      const snapshot = await makeSnapshot()
      const warehouse = dxbWarehouse(snapshot)
      const sku = snapshot.skus[0]!

      const asn = createInboundShipment(snapshot, {
        supplierId: snapshot.suppliers[0]!.id,
        warehouseId: warehouse.id,
        carrier: "Test Carrier",
        eta: new Date().toISOString(),
        dockDoor: "RCV-DOCK-01",
        lines: [{ skuId: sku.id, quantityExpected: 30 }],
      })

      const dock = snapshot.locations.find((l) => l.code === "RCV-DOCK-01")!
      const task = createPutawayTask(snapshot, {
        inboundShipmentId: asn.id,
        skuId: sku.id,
        quantity: 30,
        fromLocationId: dock.id,
        createdBy: "tester",
      })

      expect(task.number).toMatch(/^PUT-\d{4}-\d{4}$/)
      expect(task.suggestedLocationId).toBeTruthy()
      expect(task.priority).toBeGreaterThanOrEqual(1)
    })

    it("blocks a location from receiving stock once blocked", async () => {
      const snapshot = await makeSnapshot()
      const shelf = snapshot.locations.find((l) => l.pickFace && l.capacityKg > 0)!
      shelf.status = "blocked"

      const suggestion = suggestPutawayLocation(snapshot, snapshot.skus[0]!.id, 10)
      expect(suggestion).not.toBe(shelf.id)
    })
  })
})
