"use client"

import * as React from "react"
import { ClipboardCheck, ShieldCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { api } from "@/lib/api/client"
import { useApi, describeError } from "@/hooks/use-wms"
import {
  DataTable,
  ErrorState,
  LoadingState,
  PageHeader,
  StatCard,
  StatusBadge,
  formatDate,
  formatNumber,
} from "@/components/wms/primitives"
import type { Column } from "@/components/wms/primitives"

/**
 * Cycle counting.
 *
 * The count is blind: the sheet shows the system quantity only *after* the
 * counter has entered a figure, and a variance cannot become a stock adjustment
 * without a separate approval from someone holding `cyclecount:approve`.
 * That separation is the control that makes the count auditable.
 */

interface CountLine {
  id: string
  skuCode: string
  skuName: string
  locationCode: string
  lot: string | null
  systemQuantity: number
  countedQuantity: number | null
  variance: number
  recountRequired: boolean
}

interface CycleCount {
  id: string
  number: string
  warehouseCode: string
  zoneCode: string | null
  status: string
  scheduledDate: string
  counter: string | null
  lines: CountLine[]
  totalVariance: number
  linesWithVariance: number
  createdAt: string
}

interface MasterData {
  warehouses: Array<{ id: string; code: string; name: string }>
  zones: Array<{ id: string; warehouseId: string; code: string; name: string }>
}

export default function CycleCountPage() {
  const { toast } = useToast()
  const counts = useApi<{ counts: CycleCount[] }>("/api/wms/cycle-counts")
  const master = useApi<MasterData>("/api/wms/master-data")

  const [open, setOpen] = React.useState<CycleCount | null>(null)
  const [entries, setEntries] = React.useState<Record<string, string>>({})
  const [busy, setBusy] = React.useState(false)
  const [creating, setCreating] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    const fresh = counts.data?.counts.find((c) => c.id === open.id)
    if (fresh) setOpen(fresh)
  }, [counts.data, open])

  const act = async (label: string, fn: () => Promise<unknown>, description?: string) => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
      await counts.refetch()
      toast({ variant: "success", title: label, description })
    } catch (error) {
      toast({ variant: "destructive", title: `${label} failed`, description: describeError(error) })
    } finally {
      setBusy(false)
    }
  }

  const start = (count: CycleCount) =>
    act("Count started", () => counts.mutate(() => api.post("/api/wms/cycle-counts", { action: "start", countId: count.id })), `${count.number} is open for counting.`)

  const submit = (count: CycleCount) => {
    const payload = Object.entries(entries)
      .filter(([, value]) => value.trim() !== "")
      .map(([lineId, value]) => ({ lineId, countedQuantity: Number(value) }))

    if (payload.length === 0) {
      toast({ variant: "warning", title: "Nothing entered", description: "Enter at least one counted quantity." })
      return
    }

    return act(
      "Count submitted",
      () => counts.mutate(() => api.post("/api/wms/cycle-counts", { action: "submit", countId: count.id, entries: payload })),
      `${payload.length} line(s) recorded.`,
    ).then(() => setEntries({}))
  }

  const approve = (count: CycleCount) =>
    act("Variances approved", () => counts.mutate(() => api.post("/api/wms/cycle-counts", { action: "approve", countId: count.id })), "Stock adjustments posted from the count.")

  const reject = (count: CycleCount) => {
    const reason = window.prompt("Reason for rejecting this count sheet:", "Count sheet misread")
    if (!reason) return
    return act("Count rejected", () => counts.mutate(() => api.post("/api/wms/cycle-counts", { action: "reject", countId: count.id, reason })))
  }

  if (counts.initialising) return <LoadingState label="Loading cycle counts…" />

  const all = counts.data?.counts ?? []

  const summaryColumns: Column<CycleCount>[] = [
    { key: "number", header: "Sheet", render: (row) => <span className="font-mono text-xs font-medium">{row.number}</span> },
    { key: "zone", header: "Zone", render: (row) => `${row.warehouseCode}${row.zoneCode ? `/${row.zoneCode}` : ""}` },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    { key: "scheduled", header: "Scheduled", render: (row) => formatDate(row.scheduledDate) },
    { key: "counter", header: "Counter", render: (row) => row.counter ?? <span className="text-gray-400">Unassigned</span> },
    { key: "lines", header: "Lines", align: "right", render: (row) => formatNumber(row.lines.length) },
    {
      key: "variance",
      header: "Variance",
      align: "right",
      render: (row) =>
        row.linesWithVariance > 0 ? (
          <span className={row.totalVariance < 0 ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}>
            {row.totalVariance > 0 ? "+" : ""}
            {formatNumber(row.totalVariance)}
          </span>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (row) => (
        <Button variant="outline" size="sm" onClick={(event) => { event.stopPropagation(); setOpen(row) }}>
          Open
        </Button>
      ),
    },
  ]

  const lineColumns: Column<CountLine>[] = [
    { key: "location", header: "Location", render: (row) => <span className="font-mono text-xs">{row.locationCode}</span> },
    { key: "sku", header: "SKU", render: (row) => <span className="font-mono text-xs">{row.skuCode}</span> },
    { key: "name", header: "Item", className: "max-w-[14rem] truncate", render: (row) => row.skuName },
    { key: "lot", header: "Lot", render: (row) => (row.lot ? <span className="font-mono text-xs">{row.lot}</span> : <span className="text-gray-400">—</span>) },
    {
      key: "system",
      header: "System",
      align: "right",
      // Hidden while counting — a blind count is the only kind worth doing.
      render: (row) => (open?.status === "in_progress" && row.countedQuantity === null ? <span className="text-gray-400">hidden</span> : formatNumber(row.systemQuantity)),
    },
    {
      key: "counted",
      header: "Counted",
      align: "right",
      render: (row) =>
        open?.status === "in_progress" ? (
          <Input
            type="number"
            min="0"
            value={entries[row.id] ?? ""}
            onChange={(event) => setEntries((prev) => ({ ...prev, [row.id]: event.target.value }))}
            className="h-8 w-24 text-right"
            disabled={busy}
            aria-label={`Counted quantity for ${row.skuCode} at ${row.locationCode}`}
          />
        ) : row.countedQuantity === null ? (
          <span className="text-gray-400">—</span>
        ) : (
          formatNumber(row.countedQuantity)
        ),
    },
    {
      key: "variance",
      header: "Variance",
      align: "right",
      render: (row) =>
        row.countedQuantity === null ? (
          <span className="text-gray-400">—</span>
        ) : row.variance === 0 ? (
          <span className="text-green-600 dark:text-green-400">0</span>
        ) : (
          <span className="font-medium text-red-600 dark:text-red-400">
            {row.variance > 0 ? "+" : ""}
            {row.variance}
          </span>
        ),
    },
    {
      key: "recount",
      header: "Recount",
      render: (row) => (row.recountRequired ? <StatusBadge status="short" /> : <span className="text-gray-400">—</span>),
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cycle Counts"
        description="Scheduled counts with blind entry and supervised variance approval."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={counts.refetch} disabled={counts.loading}>Refresh</Button>
            <Button size="sm" onClick={() => setCreating(true)}>New count sheet</Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Count sheets" value={formatNumber(all.length)} icon={ClipboardCheck} />
        <StatCard label="In progress" value={formatNumber(all.filter((c) => c.status === "in_progress").length)} tone="warn" />
        <StatCard label="Awaiting approval" value={formatNumber(all.filter((c) => c.status === "variance_review").length)} tone="bad" />
        <StatCard
          label="Total variance"
          value={formatNumber(all.reduce((sum, c) => sum + c.totalVariance, 0))}
          hint="Across all sheets"
          icon={ShieldCheck}
        />
      </div>

      {counts.error && <ErrorState message={describeError(counts.error)} onRetry={counts.refetch} />}

      {open ? (
        <Card className="bg-white dark:bg-[#131317]">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">
                  {open.number} — {open.warehouseCode}
                  {open.zoneCode ? `/${open.zoneCode}` : ""}
                </CardTitle>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {open.lines.length} lines · scheduled {formatDate(open.scheduledDate)}
                  {open.counter ? ` · counter ${open.counter}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {open.status === "scheduled" && <Button size="sm" onClick={() => start(open)} disabled={busy}>Start counting</Button>}
                {open.status === "in_progress" && <Button size="sm" onClick={() => submit(open)} disabled={busy}>Submit counts</Button>}
                {open.status === "variance_review" && (
                  <>
                    <Button size="sm" onClick={() => approve(open)} disabled={busy}>Approve variances</Button>
                    <Button variant="outline" size="sm" onClick={() => reject(open)} disabled={busy}>Reject sheet</Button>
                  </>
                )}
                <Button variant="ghost" size="sm" onClick={() => { setOpen(null); setEntries({}) }}>Back</Button>
              </div>
            </div>
            {open.status === "variance_review" && (
              <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
                {open.linesWithVariance} line(s) differ from system. Approving posts stock adjustments and writes them to
                the audit log — this needs a supervisor.
              </p>
            )}
          </CardHeader>
          <CardContent>
            <DataTable columns={lineColumns} rows={open.lines} emptyMessage="This sheet has no lines." />
          </CardContent>
        </Card>
      ) : (
        <Card className="bg-white dark:bg-[#131317]">
          <CardHeader>
            <CardTitle className="text-base">Count sheets</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable columns={summaryColumns} rows={all} emptyMessage="No count sheets yet." onRowClick={setOpen} />
          </CardContent>
        </Card>
      )}

      {creating && (
        <CreateDialog
          warehouses={master.data?.warehouses ?? []}
          zones={master.data?.zones ?? []}
          onClose={() => setCreating(false)}
          onCreate={async (payload) => {
            await act("Count sheet created", () => counts.mutate(() => api.post("/api/wms/cycle-counts", payload)))
            setCreating(false)
          }}
        />
      )}
    </div>
  )
}

function CreateDialog({
  warehouses,
  zones,
  onClose,
  onCreate,
}: {
  warehouses: Array<{ id: string; code: string; name: string }>
  zones: Array<{ id: string; warehouseId: string; code: string; name: string }>
  onClose: () => void
  onCreate: (payload: { warehouseId: string; zoneId: string | null; scheduledDate: string }) => Promise<void>
}) {
  const [warehouseId, setWarehouseId] = React.useState(warehouses[0]?.id ?? "")
  const [zoneId, setZoneId] = React.useState("all")
  const [scheduledDate, setScheduledDate] = React.useState(new Date().toISOString().slice(0, 10))
  const [submitting, setSubmitting] = React.useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    try {
      await onCreate({
        warehouseId,
        zoneId: zoneId === "all" ? null : zoneId,
        scheduledDate: new Date(scheduledDate).toISOString(),
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-lg bg-white p-5 shadow-xl dark:bg-[#131317]">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">New count sheet</h2>

        <div>
          <Label htmlFor="cc-warehouse">Warehouse</Label>
          <Select value={warehouseId} onValueChange={setWarehouseId}>
            <SelectTrigger id="cc-warehouse"><SelectValue /></SelectTrigger>
            <SelectContent>
              {warehouses.map((warehouse) => (
                <SelectItem key={warehouse.id} value={warehouse.id}>{warehouse.code} — {warehouse.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="cc-zone">Zone</Label>
          <Select value={zoneId} onValueChange={setZoneId}>
            <SelectTrigger id="cc-zone"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stocked locations</SelectItem>
              {zones.filter((zone) => zone.warehouseId === warehouseId).map((zone) => (
                <SelectItem key={zone.id} value={zone.id}>{zone.code} — {zone.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            Only locations holding stock are added to the sheet.
          </p>
        </div>

        <div>
          <Label htmlFor="cc-date">Scheduled date</Label>
          <Input id="cc-date" type="date" value={scheduledDate} onChange={(event) => setScheduledDate(event.target.value)} required />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={submitting || !warehouseId}>Create sheet</Button>
        </div>
      </form>
    </div>
  )
}
