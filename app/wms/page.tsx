"use client"

import * as React from "react"
import {
  AlertTriangle,
  Boxes,
  ClipboardList,
  PackageCheck,
  Percent,
  Timer,
  TrendingUp,
  Truck,
  Warehouse,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DataTable,
  ErrorState,
  LoadingState,
  PageHeader,
  StatCard,
  StatusBadge,
  formatCurrency,
  formatDateTime,
  formatNumber,
} from "@/components/wms/primitives"
import { useApi, describeError } from "@/hooks/use-wms"
import type { Column } from "@/components/wms/primitives"

/**
 * Operations dashboard.
 *
 * Built to answer the four questions a warehouse manager asks at the start of a
 * shift: how much stock do I have, what is late, what is short, and where is the
 * work backed up.
 */

interface SummaryResponse {
  kpis: {
    totalUnitsOnHand: number
    availableUnits: number
    allocatedUnits: number
    stockValue: number
    locations: number
    occupiedLocations: number
    utilisationPercent: number
    lowStockCount: number
    expiringCount: number
    pendingPutaway: number
    openPickTasks: number
    ordersAwaitingShip: number
    ordersShippedToday: number
    cycleCountsPending: number
    pendingAdjustments: number
    openReturns: number
    openReplenishments: number
  }
  throughput: Array<{ date: string; received: number; shipped: number; picked: number }>
  orderPipeline: Array<{ status: string; count: number }>
  waveAgeing: Array<{ waveNumber: string; status: string; strategy: string; openHours: number; pickTasksOpen: number }>
  inventoryAccuracy: { counts: number; linesCounted: number; accurateLines: number; accuracyPercent: number; netVariance: number }
  productivity: Array<{ operator: string; picks: number; putaways: number; replenishments: number; units: number }>
  lowStock: Array<{ code: string; name: string; available: number; reorderPoint: number; uom: string }>
  expiringSoon: Array<{ skuCode: string; lot: string | null; quantity: number; daysToExpiry: number }>
  zoneUtilisation: Array<{ zone: string; locations: number; occupied: number; percent: number }>
  generatedAt: string
}

export default function WmsDashboardPage() {
  const { data, error, loading, refetch, initialising } = useApi<SummaryResponse>("/api/wms/reports/summary")

  if (initialising) return <LoadingState label="Loading warehouse metrics…" />
  if (error) return <ErrorState message={describeError(error)} onRetry={refetch} />
  if (!data) return null

  const { kpis, throughput, orderPipeline, waveAgeing, inventoryAccuracy, productivity, lowStock, expiringSoon, zoneUtilisation } = data

  const peakThroughput = Math.max(1, ...throughput.flatMap((t) => [t.received, t.shipped, t.picked]))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operations Dashboard"
        description={`Live warehouse position · generated ${formatDateTime(data.generatedAt)}`}
        actions={
          <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Units on hand"
          value={formatNumber(kpis.totalUnitsOnHand)}
          hint={`${formatCurrency(kpis.stockValue)} stock value`}
          icon={Boxes}
        />
        <StatCard
          label="Available"
          value={formatNumber(kpis.availableUnits)}
          hint={`${formatNumber(kpis.allocatedUnits)} allocated`}
          icon={TrendingUp}
          tone="good"
        />
        <StatCard
          label="Open pick tasks"
          value={formatNumber(kpis.openPickTasks)}
          hint={`${kpis.ordersAwaitingShip} orders awaiting ship`}
          icon={ClipboardList}
          tone={kpis.openPickTasks > 40 ? "warn" : "default"}
        />
        <StatCard
          label="Putaway queue"
          value={formatNumber(kpis.pendingPutaway)}
          hint={`${kpis.openReplenishments} replenishments open`}
          icon={Truck}
          tone={kpis.pendingPutaway > 5 ? "warn" : "default"}
        />
        <StatCard
          label="Space utilisation"
          value={`${kpis.utilisationPercent}%`}
          hint={`${formatNumber(kpis.occupiedLocations)} of ${formatNumber(kpis.locations)} locations`}
          icon={Warehouse}
          tone={kpis.utilisationPercent > 90 ? "bad" : kpis.utilisationPercent > 75 ? "warn" : "good"}
        />
        <StatCard
          label="Low stock SKUs"
          value={formatNumber(kpis.lowStockCount)}
          hint="At or below reorder point"
          icon={AlertTriangle}
          tone={kpis.lowStockCount > 0 ? "warn" : "good"}
        />
        <StatCard
          label="Inventory accuracy"
          value={`${inventoryAccuracy.accuracyPercent}%`}
          hint={`${formatNumber(inventoryAccuracy.accurateLines)}/${formatNumber(inventoryAccuracy.linesCounted)} lines exact`}
          icon={Percent}
          tone={inventoryAccuracy.accuracyPercent >= 98 ? "good" : inventoryAccuracy.accuracyPercent >= 95 ? "warn" : "bad"}
        />
        <StatCard
          label="Shipped today"
          value={formatNumber(kpis.ordersShippedToday)}
          hint={`${kpis.cycleCountsPending} counts pending`}
          icon={PackageCheck}
          tone="good"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="bg-white dark:bg-[#131317] lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Throughput — last {throughput.length} days</CardTitle>
            <p className="text-xs text-gray-500 dark:text-gray-400">Units received, picked and shipped per day</p>
          </CardHeader>
          <CardContent>
            {/*
              Rendered as inline bars rather than a chart library: the dashboard
              already ships recharts, but this widget needs no axes, ticks or
              tooltips, and a 30-line SVG costs ~2 kB less than a chart instance.
            */}
            <div className="flex h-48 items-end gap-1.5" role="img" aria-label="Daily units received, picked and shipped">
              {throughput.map((day) => (
                <div key={day.date} className="group flex flex-1 flex-col items-center justify-end gap-1">
                  <div className="flex h-full w-full items-end justify-center gap-0.5">
                    <Bar value={day.received} max={peakThroughput} className="bg-blue-500" title={`${day.date} received ${day.received}`} />
                    <Bar value={day.picked} max={peakThroughput} className="bg-amber-500" title={`${day.date} picked ${day.picked}`} />
                    <Bar value={day.shipped} max={peakThroughput} className="bg-green-500" title={`${day.date} shipped ${day.shipped}`} />
                  </div>
                  <span className="text-[9px] text-gray-400 dark:text-gray-500">{day.date.slice(5)}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-4 text-xs text-gray-500 dark:text-gray-400">
              <Legend className="bg-blue-500" label="Received" />
              <Legend className="bg-amber-500" label="Picked" />
              <Legend className="bg-green-500" label="Shipped" />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-white dark:bg-[#131317]">
          <CardHeader>
            <CardTitle className="text-base">Order pipeline</CardTitle>
            <p className="text-xs text-gray-500 dark:text-gray-400">Where every open order sits</p>
          </CardHeader>
          <CardContent className="space-y-2">
            {orderPipeline.length === 0 && <p className="text-sm text-gray-500">No orders yet.</p>}
            {orderPipeline.map((row) => (
              <div key={row.status} className="flex items-center justify-between gap-3">
                <StatusBadge status={row.status} />
                <span className="text-sm font-medium tabular-nums text-gray-900 dark:text-white">{row.count}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="bg-white dark:bg-[#131317]">
          <CardHeader>
            <CardTitle className="text-base">Low stock</CardTitle>
            <p className="text-xs text-gray-500 dark:text-gray-400">At or below reorder point — replenish or reorder</p>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={lowStockColumns}
              rows={lowStock.map((row, index) => ({ id: `${row.code}-${index}`, ...row }))}
              emptyMessage="Every SKU is above its reorder point."
            />
          </CardContent>
        </Card>

        <Card className="bg-white dark:bg-[#131317]">
          <CardHeader>
            <CardTitle className="text-base">Ageing waves</CardTitle>
            <p className="text-xs text-gray-500 dark:text-gray-400">Released waves, oldest first</p>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={waveColumns}
              rows={waveAgeing.map((row, index) => ({ id: `${row.waveNumber}-${index}`, ...row }))}
              emptyMessage="No open waves."
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="bg-white dark:bg-[#131317]">
          <CardHeader>
            <CardTitle className="text-base">Zone utilisation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {zoneUtilisation.slice(0, 8).map((zone) => (
              <div key={zone.zone}>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono text-gray-700 dark:text-gray-300">{zone.zone}</span>
                  <span className="tabular-nums text-gray-500 dark:text-gray-400">{zone.percent}%</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-[#1F1F23]">
                  <div
                    className={`h-full rounded-full ${zone.percent > 90 ? "bg-red-500" : zone.percent > 75 ? "bg-amber-500" : "bg-blue-500"}`}
                    style={{ width: `${Math.min(100, zone.percent)}%` }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="bg-white dark:bg-[#131317]">
          <CardHeader>
            <CardTitle className="text-base">Operator productivity</CardTitle>
            <p className="text-xs text-gray-500 dark:text-gray-400">Units moved over the visible window</p>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={productivityColumns}
              rows={productivity.map((row, index) => ({ id: `${row.operator}-${index}`, ...row }))}
              emptyMessage="No task activity recorded yet."
            />
          </CardContent>
        </Card>

        <Card className="bg-white dark:bg-[#131317]">
          <CardHeader>
            <CardTitle className="text-base">Expiring soon</CardTitle>
            <p className="text-xs text-gray-500 dark:text-gray-400">Best-before within 30 days</p>
          </CardHeader>
          <CardContent>
            {expiringSoon.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">Nothing expires in the next 30 days.</p>
            ) : (
              <ul className="space-y-2.5">
                {expiringSoon.map((row, index) => (
                  <li
                    key={`${row.skuCode}-${row.lot ?? index}`}
                    className="flex items-center justify-between gap-3 rounded-md bg-gray-50 px-3 py-2 dark:bg-[#1F1F23]"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs text-gray-900 dark:text-white">{row.skuCode}</p>
                      <p className="text-[11px] text-gray-500 dark:text-gray-400">
                        {row.lot ?? "no lot"} · {formatNumber(row.quantity)} units
                      </p>
                    </div>
                    <span
                      className={`flex items-center gap-1 whitespace-nowrap text-xs font-medium ${
                        row.daysToExpiry <= 7 ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"
                      }`}
                    >
                      <Timer className="h-3 w-3" />
                      {row.daysToExpiry}d
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Bar({ value, max, className, title }: { value: number; max: number; className: string; title: string }) {
  const height = max === 0 ? 0 : Math.max(value > 0 ? 4 : 1, (value / max) * 100)
  return <div title={title} aria-label={title} className={`w-1.5 rounded-t-sm ${className} opacity-80 transition-opacity group-hover:opacity-100`} style={{ height: `${height}%` }} />
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${className}`} />
      {label}
    </span>
  )
}

const lowStockColumns: Column<{ code: string; name: string; available: number; reorderPoint: number; uom: string }>[] = [
  { key: "code", header: "SKU", render: (row) => <span className="font-mono text-xs">{row.code}</span> },
  { key: "name", header: "Item", className: "max-w-[16rem] truncate", render: (row) => row.name },
  { key: "available", header: "Available", align: "right", render: (row) => formatNumber(row.available) },
  { key: "reorderPoint", header: "Reorder", align: "right", render: (row) => formatNumber(row.reorderPoint) },
]

const waveColumns: Column<{ waveNumber: string; status: string; openHours: number; pickTasksOpen: number }>[] = [
  { key: "wave", header: "Wave", render: (row) => <span className="font-mono text-xs">{row.waveNumber}</span> },
  { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
  { key: "open", header: "Open", align: "right", render: (row) => `${row.openHours}h` },
  { key: "tasks", header: "Tasks", align: "right", render: (row) => formatNumber(row.pickTasksOpen) },
]

const productivityColumns: Column<{ operator: string; picks: number; putaways: number; units: number }>[] = [
  { key: "operator", header: "Operator", render: (row) => <span className="text-xs">{row.operator}</span> },
  { key: "picks", header: "Picks", align: "right", render: (row) => formatNumber(row.picks) },
  { key: "putaways", header: "Putaways", align: "right", render: (row) => formatNumber(row.putaways) },
  { key: "units", header: "Units", align: "right", render: (row) => <span className="font-medium">{formatNumber(row.units)}</span> },
]
