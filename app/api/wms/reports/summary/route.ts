import type { NextRequest } from "next/server"

import { withAuth } from "@/lib/api/guard"
import { ok } from "@/lib/api/http"
import { expiringSoon, lowStock, skuBalances } from "@/lib/wms/services/inventory"
import {
  carrierPerformance,
  inventoryAccuracy,
  kpiSummary,
  orderPipeline,
  productivityByOperator,
  stockByCategory,
  throughputSeries,
  waveAgeing,
  zoneUtilisation,
} from "@/lib/wms/services/reports"
import { getStore } from "@/lib/wms/store"

/**
 * GET /api/wms/reports/summary
 *
 * One call returns everything the operations dashboard renders. Aggregating
 * server-side keeps the client from pulling the whole ledger just to count it,
 * and means every figure on screen comes from the same consistent snapshot.
 */
export const GET = withAuth({ permission: "reports:read" }, async (request: NextRequest) => {
  const store = await getStore()
  const snapshot = await store.read()

  const days = Number(new URL(request.url).searchParams.get("days") ?? 14)
  const window = Number.isFinite(days) && days >= 1 && days <= 90 ? Math.round(days) : 14

  return ok({
    kpis: kpiSummary(snapshot),
    throughput: throughputSeries(snapshot, window),
    stockByCategory: stockByCategory(snapshot),
    zoneUtilisation: zoneUtilisation(snapshot),
    orderPipeline: orderPipeline(snapshot),
    waveAgeing: waveAgeing(snapshot).map((row) => ({
      waveNumber: row.wave.number,
      status: row.wave.status,
      strategy: row.wave.strategy,
      openHours: row.openHours,
      pickTasksOpen: row.pickTasksOpen,
    })),
    carrierPerformance: carrierPerformance(snapshot, 30),
    inventoryAccuracy: inventoryAccuracy(snapshot),
    productivity: productivityByOperator(snapshot, window),
    lowStock: lowStock(snapshot).slice(0, 10),
    expiringSoon: expiringSoon(snapshot, 30).slice(0, 10).map((r) => ({
      skuCode: r.skuCode,
      lot: r.lot,
      quantity: r.quantityOnHand,
      daysToExpiry: r.daysToExpiry,
      expiresAt: r.expiresAt,
    })),
    skuCount: skuBalances(snapshot).length,
    generatedAt: new Date().toISOString(),
  })
})

export const dynamic = "force-dynamic"
