"use client"

import * as React from "react"
import { Boxes, Download } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { api, qs } from "@/lib/api/client"
import { useApi, describeError } from "@/hooks/use-wms"
import { useWmsUser } from "@/components/wms/wms-shell"
import {
  DataTable,
  DebouncedSearch,
  ErrorState,
  LoadingState,
  PageHeader,
  StatCard,
  formatNumber,
} from "@/components/wms/primitives"
import type { Column } from "@/components/wms/primitives"

/**
 * Inventory ledger.
 *
 * Filters run server-side so the page stays responsive on a warehouse with
 * 100k+ records. Adjustments are posted inline; the permission check happens on
 * the server, and the button is hidden when the user lacks `inventory:adjust`.
 */

interface InventoryRow {
  id: string
  skuId: string
  locationId: string
  skuCode: string
  skuName: string
  uom: string
  locationCode: string
  zoneCode: string
  warehouseCode: string
  lot: string | null
  quantityOnHand: number
  quantityAllocated: number
  quantityReserved: number
  quantityDamaged: number
  available: number
  expiresAt: string | null
  lastCountedAt: string | null
}

interface InventoryResponse {
  data: InventoryRow[]
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
  summary: { balances: number; lowStock: number }
}

interface MasterData {
  warehouses: Array<{ id: string; code: string; name: string }>
  zones: Array<{ id: string; warehouseId: string; code: string; name: string }>
  skus: Array<{ id: string; code: string; name: string; reorderPoint: number }>
}

export default function InventoryPage() {
  const { toast } = useToast()
  const user = useWmsUser()
  const canAdjust = user?.permissions.includes("inventory:adjust") ?? false
  const [search, setSearch] = React.useState("")
  const [warehouseId, setWarehouseId] = React.useState("all")
  const [lowStockOnly, setLowStockOnly] = React.useState(false)
  const [page, setPage] = React.useState(1)
  const [adjusting, setAdjusting] = React.useState<InventoryRow | null>(null)

  const master = useApi<MasterData>("/api/wms/master-data")

  const path = React.useMemo(
    () =>
      `/api/wms/inventory${qs({
        search,
        warehouseId: warehouseId === "all" ? undefined : warehouseId,
        lowStockOnly: lowStockOnly ? "true" : undefined,
        page,
        pageSize: 25,
      })}`,
    [search, warehouseId, lowStockOnly, page],
  )

  const inventory = useApi<InventoryResponse>(path)

  const submitAdjustment = async (payload: { delta: number; reason: string; reference: string; note: string }) => {
    if (!adjusting) return
    try {
      await inventory.mutate(() =>
        api.post("/api/wms/inventory", {
          skuId: adjusting.skuId,
          locationId: adjusting.locationId,
          lot: adjusting.lot,
          delta: payload.delta,
          reason: payload.reason,
          reference: payload.reference,
          note: payload.note || undefined,
        }),
      )
      toast({ title: "Stock adjusted", description: `${adjusting.skuCode} at ${adjusting.locationCode} updated.` })
      setAdjusting(null)
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Adjustment rejected",
        description: describeError(error),
      })
      throw error
    }
  }

  const exportCsv = () => {
    if (!inventory.data) return
    const header = ["sku", "location", "zone", "warehouse", "lot", "onHand", "allocated", "reserved", "damaged", "available"]
    const rows = inventory.data.data.map((row) =>
      [row.skuCode, row.locationCode, row.zoneCode, row.warehouseCode, row.lot ?? "", row.quantityOnHand, row.quantityAllocated, row.quantityReserved, row.quantityDamaged, row.available]
        .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
        .join(","),
    )
    const blob = new Blob([[header.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const columns: Column<InventoryRow>[] = [
    { key: "sku", header: "SKU", render: (row) => <span className="font-mono text-xs">{row.skuCode}</span> },
    { key: "name", header: "Item", className: "max-w-[18rem] truncate", render: (row) => row.skuName },
    { key: "location", header: "Location", render: (row) => <span className="font-mono text-xs">{row.locationCode}</span> },
    { key: "zone", header: "Zone", render: (row) => row.zoneCode },
    { key: "lot", header: "Lot", render: (row) => (row.lot ? <span className="font-mono text-xs">{row.lot}</span> : <span className="text-gray-400">—</span>) },
    { key: "onHand", header: "On hand", align: "right", render: (row) => formatNumber(row.quantityOnHand) },
    { key: "allocated", header: "Allocated", align: "right", render: (row) => (row.quantityAllocated ? formatNumber(row.quantityAllocated) : "—") },
    { key: "reserved", header: "Held", align: "right", render: (row) => (row.quantityReserved ? formatNumber(row.quantityReserved) : "—") },
    { key: "damaged", header: "Damaged", align: "right", render: (row) => (row.quantityDamaged ? <span className="text-red-600 dark:text-red-400">{formatNumber(row.quantityDamaged)}</span> : "—") },
    {
      key: "available",
      header: "Available",
      align: "right",
      render: (row) => <span className="font-semibold">{formatNumber(row.available)}</span>,
    },
    ...(canAdjust
      ? [{
          key: "actions",
          header: "",
          align: "right" as const,
          render: (row: InventoryRow) => (
            <Button variant="ghost" size="sm" onClick={(event) => { event.stopPropagation(); setAdjusting(row) }}>
              Adjust
            </Button>
          ),
        }]
      : []),
  ]

  if (inventory.initialising) return <LoadingState label="Loading inventory…" />

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inventory"
        description="Per-location stock balances with allocation and hold breakdown."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!inventory.data}>
              <Download className="mr-2 h-4 w-4" />
              Export CSV
            </Button>
            <Button variant="outline" size="sm" onClick={inventory.refetch} disabled={inventory.loading}>
              Refresh
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Records shown" value={formatNumber(inventory.data?.pagination.total ?? 0)} icon={Boxes} />
        <StatCard label="SKUs tracked" value={formatNumber(inventory.data?.summary.balances ?? 0)} />
        <StatCard
          label="Low stock"
          value={formatNumber(inventory.data?.summary.lowStock ?? 0)}
          tone={(inventory.data?.summary.lowStock ?? 0) > 0 ? "warn" : "good"}
        />
        <StatCard label="Page" value={`${inventory.data?.pagination.page ?? 1} / ${inventory.data?.pagination.totalPages ?? 1}`} />
      </div>

      {inventory.error && <ErrorState message={describeError(inventory.error)} onRetry={inventory.refetch} />}

      <Card className="bg-white dark:bg-[#131317]">
        <CardHeader>
          <CardTitle className="text-base">Stock ledger</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <DebouncedSearch value={search} onChange={(next) => { setSearch(next); setPage(1) }} placeholder="Search SKU, location or lot…" />

            <div className="w-full sm:w-52">
              <Label className="mb-1.5 text-xs">Warehouse</Label>
              <Select value={warehouseId} onValueChange={(value) => { setWarehouseId(value); setPage(1) }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All warehouses</SelectItem>
                  {master.data?.warehouses.map((warehouse) => (
                    <SelectItem key={warehouse.id} value={warehouse.id}>
                      {warehouse.code} — {warehouse.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              variant={lowStockOnly ? "default" : "outline"}
              size="sm"
              onClick={() => { setLowStockOnly((v) => !v); setPage(1) }}
            >
              Low stock only
            </Button>
          </div>

          <DataTable
            columns={columns}
            rows={inventory.data?.data ?? []}
            emptyMessage="No inventory matches these filters."
          />

          {inventory.data && inventory.data.pagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Page {inventory.data.pagination.page} of {inventory.data.pagination.totalPages}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= inventory.data.pagination.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {adjusting && <AdjustDialog row={adjusting} onClose={() => setAdjusting(null)} onSubmit={submitAdjustment} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Adjustment dialog
// ---------------------------------------------------------------------------

const REASONS = [
  { value: "damage", label: "Damage" },
  { value: "expiry", label: "Expired" },
  { value: "theft", label: "Shrinkage / theft" },
  { value: "correction", label: "Data correction" },
  { value: "sample", label: "Sample issued" },
  { value: "return", label: "Return write-off" },
] as const

function AdjustDialog({
  row,
  onClose,
  onSubmit,
}: {
  row: InventoryRow
  onClose: () => void
  onSubmit: (payload: { delta: number; reason: string; reference: string; note: string }) => Promise<void>
}) {
  const [delta, setDelta] = React.useState("")
  const [reason, setReason] = React.useState<string>("damage")
  const [reference, setReference] = React.useState(`MANUAL-${Date.now().toString().slice(-6)}`)
  const [note, setNote] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const parsed = Number(delta)
  const valid = Number.isFinite(parsed) && parsed !== 0 && reference.trim().length > 0

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!valid || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({ delta: parsed, reason, reference: reference.trim(), note })
    } catch (err) {
      setError(describeError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <form
        onSubmit={submit}
        className="w-full max-w-md space-y-4 rounded-lg bg-white p-5 shadow-xl dark:bg-[#131317]"
      >
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Adjust stock</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            <span className="font-mono">{row.skuCode}</span> at <span className="font-mono">{row.locationCode}</span> —{" "}
            {formatNumber(row.quantityOnHand)} on hand
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="delta">Delta (± units)</Label>
            <Input
              id="delta"
              type="number"
              value={delta}
              onChange={(event) => setDelta(event.target.value)}
              placeholder="-12"
              required
            />
          </div>
          <div>
            <Label htmlFor="reason">Reason</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger id="reason"><SelectValue /></SelectTrigger>
              <SelectContent>
                {REASONS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <Label htmlFor="reference">Reference</Label>
          <Input id="reference" value={reference} onChange={(event) => setReference(event.target.value)} required />
          <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            Incident, ticket or document number. Required — every movement must be traceable.
          </p>
        </div>

        <div>
          <Label htmlFor="note">Note (optional)</Label>
          <Input id="note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
        </div>

        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">{error}</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={!valid || submitting}>
            {submitting ? "Posting…" : "Post adjustment"}
          </Button>
        </div>
      </form>
    </div>
  )
}
