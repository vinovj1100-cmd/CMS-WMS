"use client"

import * as React from "react"
import { Activity, Percent, Truck } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useApi, describeError } from "@/hooks/use-wms"
import {
  DataTable,
  ErrorState,
  LoadingState,
  PageHeader,
  StatCard,
  formatNumber,
} from "@/components/wms/primitives"
import type { Column } from "@/components/wms/primitives"

/**
 * Reporting.
 *
 * Longer-window analysis than the dashboard: carrier performance, inventory
 * accuracy, operator productivity and zone utilisation over a selectable period.
 */

interface ReportsResponse {
  kpis: {
    totalUnitsOnHand: number
    availableUnits: number
    stockValue: number
    utilisationPercent: number
    lowStockCount: number
    expiringCount: number
  }
  throughput: Array<{ date: string; received: number; shipped: number; picked: number }>
  carrierPerformance: Array<{ carrier: string; shipments: number; delivered: number; inTransit: number; exceptions: number }>
  inventoryAccuracy: { counts: number; linesCounted: number; accurateLines: number; accuracyPercent: number; netVariance: number }
  productivity: Array<{ operator: string; picks: number; putaways: number; replenishments: number; units: number }>
  zoneUtilisation: Array<{ zone: string; warehouse: string; locations: number; occupied: number; percent: number }>
  stockByCategory: Array<{ category: string; units: number; value: number }>
  generatedAt: string
}

export default function ReportsPage() {
  const [days, setDays] = React.useState("14")
  const reports = useApi<ReportsResponse>(`/api/wms/reports/summary?days=${days}`, { refreshKey: days })

  if (reports.initialising) return <LoadingState label="Building report…" />
  if (reports.error) return <ErrorState message={describeError(reports.error)} onRetry={reports.refetch} />
  if (!reports.data) return null

  const { kpis, carrierPerformance, inventoryAccuracy, productivity, zoneUtilisation, stockByCategory, throughput } = reports.data

  const totalReceived = throughput.reduce((sum, day) => sum + day.received, 0)
  const totalShipped = throughput.reduce((sum, day) => sum + day.shipped, 0)
  const totalPicked = throughput.reduce((sum, day) => sum + day.picked, 0)
  const totalValue = stockByCategory.reduce((sum, row) => sum + row.value, 0)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Operational performance across the selected window."
        actions={
          <>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="14">Last 14 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={reports.refetch} disabled={reports.loading}>Refresh</Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Units received" value={formatNumber(totalReceived)} hint={`Over ${days} days`} icon={Truck} />
        <StatCard label="Units picked" value={formatNumber(totalPicked)} tone="warn" hint={`Over ${days} days`} />
        <StatCard label="Units shipped" value={formatNumber(totalShipped)} tone="good" hint={`Over ${days} days`} />
        <StatCard
          label="Inventory accuracy"
          value={`${inventoryAccuracy.accuracyPercent}%`}
          hint={`${formatNumber(inventoryAccuracy.accurateLines)}/${formatNumber(inventoryAccuracy.linesCounted)} exact lines`}
          icon={Percent}
          tone={inventoryAccuracy.accuracyPercent >= 98 ? "good" : inventoryAccuracy.accuracyPercent >= 95 ? "warn" : "bad"}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="bg-white dark:bg-[#131317]">
          <CardHeader>
            <CardTitle className="text-base">Carrier performance</CardTitle>
            <p className="text-xs text-gray-500 dark:text-gray-400">Last 30 days by carrier</p>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={carrierColumns}
              rows={carrierPerformance.map((row, index) => ({ id: `${row.carrier}-${index}`, ...row }))}
              emptyMessage="No shipments in this period."
            />
          </CardContent>
        </Card>

        <Card className="bg-white dark:bg-[#131317]">
          <CardHeader>
            <CardTitle className="text-base">Operator productivity</CardTitle>
            <p className="text-xs text-gray-500 dark:text-gray-400">Units moved over {days} days</p>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={productivityColumns}
              rows={productivity.map((row, index) => ({ id: `${row.operator}-${index}`, ...row }))}
              emptyMessage="No task activity in this period."
            />
          </CardContent>
        </Card>

        <Card className="bg-white dark:bg-[#131317]">
          <CardHeader>
            <CardTitle className="text-base">Stock by category</CardTitle>
            <p className="text-xs text-gray-500 dark:text-gray-400">Where the inventory value sits</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {stockByCategory.map((row) => (
              <div key={row.category}>
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-gray-700 dark:text-gray-300">{row.category}</span>
                  <span className="tabular-nums text-gray-500 dark:text-gray-400">
                    {formatNumber(row.units)} units · {Math.round((row.value / Math.max(1, totalValue)) * 100)}% of value
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-[#1F1F23]">
                  <div
                    className="h-full rounded-full bg-blue-500"
                    style={{ width: `${Math.min(100, (row.value / Math.max(1, totalValue)) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
            {stockByCategory.length === 0 && <p className="text-sm text-gray-500">No stock on hand.</p>}
          </CardContent>
        </Card>

        <Card className="bg-white dark:bg-[#131317]">
          <CardHeader>
            <CardTitle className="text-base">Zone utilisation</CardTitle>
            <p className="text-xs text-gray-500 dark:text-gray-400">Space is usually the binding constraint</p>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={zoneColumns}
              rows={zoneUtilisation.map((row, index) => ({ id: `${row.zone}-${index}`, ...row }))}
              emptyMessage="No zones with locations."
            />
          </CardContent>
        </Card>
      </div>

      <Card className="bg-white dark:bg-[#131317]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" />
            Cycle count accuracy detail
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Metric label="Counts completed" value={formatNumber(inventoryAccuracy.counts)} />
          <Metric label="Lines counted" value={formatNumber(inventoryAccuracy.linesCounted)} />
          <Metric label="Lines exact" value={formatNumber(inventoryAccuracy.accurateLines)} tone="good" />
          <Metric
            label="Net variance"
            value={`${inventoryAccuracy.netVariance > 0 ? "+" : ""}${formatNumber(inventoryAccuracy.netVariance)}`}
            tone={inventoryAccuracy.netVariance === 0 ? "good" : "warn"}
          />
        </CardContent>
      </Card>

      <p className="text-center text-xs text-gray-400 dark:text-gray-500">
        Generated {new Date(reports.data.generatedAt).toLocaleString("en-GB")} · utilisation {kpis.utilisationPercent}% ·{" "}
        {kpis.lowStockCount} SKUs below reorder point · {kpis.expiringCount} expiring within 30 days
      </p>
    </div>
  )
}

function Metric({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "good" | "warn" }) {
  const colour = tone === "good" ? "text-green-600 dark:text-green-400" : tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-gray-900 dark:text-white"
  return (
    <div>
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${colour}`}>{value}</p>
    </div>
  )
}

const carrierColumns: Column<{ carrier: string; shipments: number; delivered: number; inTransit: number; exceptions: number }>[] = [
  { key: "carrier", header: "Carrier", render: (row) => row.carrier },
  { key: "shipments", header: "Shipments", align: "right", render: (row) => formatNumber(row.shipments) },
  { key: "delivered", header: "Delivered", align: "right", render: (row) => formatNumber(row.delivered) },
  { key: "inTransit", header: "In transit", align: "right", render: (row) => formatNumber(row.inTransit) },
  {
    key: "exceptions",
    header: "Exceptions",
    align: "right",
    render: (row) =>
      row.exceptions > 0 ? <span className="font-medium text-red-600 dark:text-red-400">{row.exceptions}</span> : "—",
  },
]

const productivityColumns: Column<{ operator: string; picks: number; putaways: number; replenishments: number; units: number }>[] = [
  { key: "operator", header: "Operator", render: (row) => row.operator },
  { key: "picks", header: "Picks", align: "right", render: (row) => formatNumber(row.picks) },
  { key: "putaways", header: "Putaways", align: "right", render: (row) => formatNumber(row.putaways) },
  { key: "replen", header: "Replen", align: "right", render: (row) => formatNumber(row.replenishments) },
  { key: "units", header: "Units", align: "right", render: (row) => <span className="font-semibold">{formatNumber(row.units)}</span> },
]

const zoneColumns: Column<{ zone: string; locations: number; occupied: number; percent: number }>[] = [
  { key: "zone", header: "Zone", render: (row) => <span className="font-mono text-xs">{row.zone}</span> },
  { key: "locations", header: "Locations", align: "right", render: (row) => formatNumber(row.locations) },
  { key: "occupied", header: "Occupied", align: "right", render: (row) => formatNumber(row.occupied) },
  {
    key: "percent",
    header: "Fill",
    align: "right",
    render: (row) => (
      <span className={row.percent > 90 ? "font-medium text-red-600 dark:text-red-400" : row.percent > 75 ? "text-amber-600 dark:text-amber-400" : ""}>
        {row.percent}%
      </span>
    ),
  },
]
