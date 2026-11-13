"use client"

import * as React from "react"
import { Grid3X3, Lock } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { api, qs } from "@/lib/api/client"
import { useApi, describeError } from "@/hooks/use-wms"
import {
  DataTable,
  DebouncedSearch,
  ErrorState,
  LoadingState,
  PageHeader,
  StatCard,
  StatusBadge,
  formatNumber,
} from "@/components/wms/primitives"
import type { Column } from "@/components/wms/primitives"

/**
 * Location master.
 *
 * Shows the rack map and lets a supervisor block a location. Blocking is
 * reversible and never deletes history — a damaged rack stays on the books so
 * past movements against it still reconcile.
 */

interface LocationRow {
  id: string
  code: string
  aisle: string
  bay: string
  level: number
  type: string
  status: string
  pickFace: boolean
  capacityKg: number
  currentWeightKg: number
  fillPercent: number
  skuCount: number
  zoneCode: string
  warehouseCode: string
}

interface LocationsResponse {
  data: LocationRow[]
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
}

interface MasterData {
  warehouses: Array<{ id: string; code: string; name: string }>
  zones: Array<{ id: string; warehouseId: string; code: string; name: string }>
}

export default function LocationsPage() {
  const { toast } = useToast()
  const [search, setSearch] = React.useState("")
  const [warehouseId, setWarehouseId] = React.useState("all")
  const [zoneId, setZoneId] = React.useState("all")
  const [status, setStatus] = React.useState("all")
  const [page, setPage] = React.useState(1)

  const master = useApi<MasterData>("/api/wms/master-data")

  const path = React.useMemo(
    () =>
      `/api/wms/locations${qs({
        search,
        warehouseId: warehouseId === "all" ? undefined : warehouseId,
        zoneId: zoneId === "all" ? undefined : zoneId,
        status: status === "all" ? undefined : status,
        page,
        pageSize: 40,
      })}`,
    [search, warehouseId, zoneId, status, page],
  )

  const locations = useApi<LocationsResponse>(path)

  const zonesForWarehouse = React.useMemo(
    () =>
      (master.data?.zones ?? []).filter(
        (zone) => warehouseId === "all" || zone.warehouseId === warehouseId,
      ),
    [master.data, warehouseId],
  )

  const blockLocation = async (row: LocationRow) => {
    try {
      await locations.mutate(() => api.patch("/api/wms/locations", { locationId: row.id, status: "blocked" }))
      toast({ title: "Location blocked", description: `${row.code} is out of service.` })
    } catch (error) {
      toast({ variant: "destructive", title: "Could not block location", description: describeError(error) })
    }
  }

  const unblockLocation = async (row: LocationRow) => {
    try {
      await locations.mutate(() => api.patch("/api/wms/locations", { locationId: row.id, status: "empty" }))
      toast({ title: "Location returned to service", description: `${row.code} can be used again.` })
    } catch (error) {
      toast({ variant: "destructive", title: "Could not update location", description: describeError(error) })
    }
  }

  const columns: Column<LocationRow>[] = [
    { key: "code", header: "Location", render: (row) => <span className="font-mono text-xs font-medium">{row.code}</span> },
    { key: "zone", header: "Zone", render: (row) => `${row.warehouseCode}/${row.zoneCode}` },
    { key: "type", header: "Type", render: (row) => <span className="capitalize">{row.type}</span> },
    {
      key: "pickFace",
      header: "Pick face",
      render: (row) =>
        row.pickFace ? (
          <span className="text-xs font-medium text-blue-600 dark:text-blue-400">Yes</span>
        ) : (
          <span className="text-xs text-gray-400">Reserve</span>
        ),
    },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    { key: "skus", header: "SKUs", align: "right", render: (row) => formatNumber(row.skuCount) },
    {
      key: "fill",
      header: "Fill",
      align: "right",
      render: (row) =>
        row.capacityKg === 0 ? (
          <span className="text-gray-400">n/a</span>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-100 dark:bg-[#1F1F23]">
              <div
                className={`h-full rounded-full ${row.fillPercent > 90 ? "bg-red-500" : row.fillPercent > 70 ? "bg-amber-500" : "bg-blue-500"}`}
                style={{ width: `${Math.min(100, row.fillPercent)}%` }}
              />
            </div>
            <span className="w-10 tabular-nums">{row.fillPercent}%</span>
          </div>
        ),
    },
    {
      key: "weight",
      header: "Weight",
      align: "right",
      render: (row) => (row.capacityKg === 0 ? "—" : `${row.currentWeightKg}/${row.capacityKg} kg`),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (row) =>
        row.status === "blocked" ? (
          <Button variant="outline" size="sm" onClick={() => unblockLocation(row)}>
            Unblock
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => blockLocation(row)} title="Take out of service">
            <Lock className="h-3.5 w-3.5" />
          </Button>
        ),
    },
  ]

  if (locations.initialising) return <LoadingState label="Loading locations…" />

  const rows = locations.data?.data ?? []
  const occupancy = rows.length === 0 ? 0 : Math.round((rows.filter((r) => r.status === "occupied").length / rows.length) * 100)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Locations"
        description="Rack map, capacity and service status. Blocked locations are skipped by putaway and replenishment."
        actions={
          <Button variant="outline" size="sm" onClick={locations.refetch} disabled={locations.loading}>
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Locations" value={formatNumber(locations.data?.pagination.total ?? 0)} icon={Grid3X3} />
        <StatCard label="Occupied on page" value={`${occupancy}%`} tone={occupancy > 90 ? "warn" : "good"} />
        <StatCard label="Blocked on page" value={formatNumber(rows.filter((r) => r.status === "blocked").length)} tone="bad" />
        <StatCard label="Pick faces on page" value={formatNumber(rows.filter((r) => r.pickFace).length)} />
      </div>

      {locations.error && <ErrorState message={describeError(locations.error)} onRetry={locations.refetch} />}

      <Card className="bg-white dark:bg-[#131317]">
        <CardHeader>
          <CardTitle className="text-base">Rack map</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <DebouncedSearch value={search} onChange={(next) => { setSearch(next); setPage(1) }} placeholder="Search location code…" />

            <div className="w-full sm:w-48">
              <Label className="mb-1.5 text-xs">Warehouse</Label>
              <Select
                value={warehouseId}
                onValueChange={(value) => { setWarehouseId(value); setZoneId("all"); setPage(1) }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {master.data?.warehouses.map((warehouse) => (
                    <SelectItem key={warehouse.id} value={warehouse.id}>{warehouse.code}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-full sm:w-48">
              <Label className="mb-1.5 text-xs">Zone</Label>
              <Select value={zoneId} onValueChange={(value) => { setZoneId(value); setPage(1) }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All zones</SelectItem>
                  {zonesForWarehouse.map((zone) => (
                    <SelectItem key={zone.id} value={zone.id}>{zone.code}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-full sm:w-40">
              <Label className="mb-1.5 text-xs">Status</Label>
              <Select value={status} onValueChange={(value) => { setStatus(value); setPage(1) }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any</SelectItem>
                  <SelectItem value="empty">Empty</SelectItem>
                  <SelectItem value="occupied">Occupied</SelectItem>
                  <SelectItem value="reserved">Reserved</SelectItem>
                  <SelectItem value="blocked">Blocked</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DataTable columns={columns} rows={rows} emptyMessage="No locations match these filters." />

          {locations.data && locations.data.pagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Page {locations.data.pagination.page} of {locations.data.pagination.totalPages}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= locations.data.pagination.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
