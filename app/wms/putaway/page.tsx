"use client"

import * as React from "react"
import { Archive, CheckCircle2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { api } from "@/lib/api/client"
import { useApi, describeError } from "@/hooks/use-wms"
import {
  DataTable,
  ErrorState,
  LoadingState,
  PageHeader,
  ScanInput,
  StatCard,
  StatusBadge,
  formatNumber,
} from "@/components/wms/primitives"
import type { Column } from "@/components/wms/primitives"

/**
 * Putaway queue.
 *
 * The workflow is two scans: the task is already selected by priority, the
 * operator scans the destination bin and the server checks it against the
 * suggestion. A deviation is accepted and flagged rather than blocked, because
 * a hard stop at the scanner just gets worked around and the system loses the
 * information.
 */

interface PutawayTask {
  id: string
  number: string
  skuCode: string
  skuName: string
  uom: string
  quantity: number
  lot: string | null
  fromLocationCode: string
  suggestedLocationCode: string | null
  inboundNumber: string
  status: string
  priority: number
  createdAt: string
}

export default function PutawayPage() {
  const { toast } = useToast()
  const tasks = useApi<{ tasks: PutawayTask[] }>("/api/wms/putaway")
  const [active, setActive] = React.useState<PutawayTask | null>(null)
  const [busy, setBusy] = React.useState(false)

  // Follow the refreshed list so a completed task drops off automatically.
  React.useEffect(() => {
    if (!active) return
    const fresh = tasks.data?.tasks.find((t) => t.id === active.id)
    setActive(fresh ?? null)
  }, [tasks.data, active])

  const complete = async (location: string) => {
    if (!active || busy) return
    setBusy(true)
    try {
      const result = await tasks.mutate(() =>
        api.post<{ deviatedFromSuggestion: boolean; locationCode: string }>("/api/wms/putaway", {
          taskId: active.id,
          location,
        }),
      )

      toast({
        title: result.deviatedFromSuggestion ? "Put away (deviated)" : "Put away",
        description: result.deviatedFromSuggestion
          ? `${active.skuCode} went to ${result.locationCode} instead of the suggested ${active.suggestedLocationCode}.`
          : `${formatNumber(active.quantity)} × ${active.skuCode} → ${result.locationCode}`,
        variant: result.deviatedFromSuggestion ? "warning" : "success",
      })
      setActive(null)
    } catch (error) {
      toast({ variant: "destructive", title: "Putaway rejected", description: describeError(error) })
    } finally {
      setBusy(false)
    }
  }

  if (tasks.initialising) return <LoadingState label="Loading putaway queue…" />

  const queue = tasks.data?.tasks ?? []

  const columns: Column<PutawayTask>[] = [
    { key: "priority", header: "Pri", render: (row) => <PriorityChip priority={row.priority} /> },
    { key: "sku", header: "SKU", render: (row) => <span className="font-mono text-xs font-medium">{row.skuCode}</span> },
    { key: "name", header: "Item", className: "max-w-[16rem] truncate", render: (row) => row.skuName },
    { key: "qty", header: "Qty", align: "right", render: (row) => formatNumber(row.quantity) },
    { key: "lot", header: "Lot", render: (row) => (row.lot ? <span className="font-mono text-xs">{row.lot}</span> : <span className="text-gray-400">—</span>) },
    { key: "from", header: "From", render: (row) => <span className="font-mono text-xs">{row.fromLocationCode}</span> },
    {
      key: "suggested",
      header: "Suggested bin",
      render: (row) =>
        row.suggestedLocationCode ? (
          <span className="font-mono text-xs font-medium text-blue-600 dark:text-blue-400">{row.suggestedLocationCode}</span>
        ) : (
          <span className="text-xs text-gray-400">No space found</span>
        ),
    },
    { key: "source", header: "From ASN", render: (row) => <span className="font-mono text-xs">{row.inboundNumber}</span> },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (row) => (
        <Button variant="outline" size="sm" onClick={(event) => { event.stopPropagation(); setActive(row) }}>
          Start
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Putaway"
        description="Move received stock from the dock into storage. Scan the destination bin to complete each task."
        actions={
          <Button variant="outline" size="sm" onClick={tasks.refetch} disabled={tasks.loading}>
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Open tasks" value={formatNumber(queue.length)} icon={Archive} />
        <StatCard label="Priority 1 (A stock)" value={formatNumber(queue.filter((t) => t.priority === 1).length)} tone="bad" />
        <StatCard label="No space found" value={formatNumber(queue.filter((t) => !t.suggestedLocationCode).length)} tone="warn" />
        <StatCard label="Completed this view" value={formatNumber(0)} icon={CheckCircle2} tone="good" />
      </div>

      {tasks.error && <ErrorState message={describeError(tasks.error)} onRetry={tasks.refetch} />}

      {active && (
        <Card className="border-blue-200 bg-blue-50/50 dark:border-blue-900/40 dark:bg-blue-900/10">
          <CardHeader>
            <CardTitle className="text-base">
              {active.number} — {formatNumber(active.quantity)} × {active.skuCode}
            </CardTitle>
            <p className="text-xs text-gray-600 dark:text-gray-300">
              {active.skuName}
              {active.lot ? ` · lot ${active.lot}` : ""} · from <span className="font-mono">{active.fromLocationCode}</span>
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border border-dashed border-blue-300 bg-white p-3 dark:border-blue-800 dark:bg-[#131317]">
              <p className="text-xs text-gray-500 dark:text-gray-400">Suggested destination</p>
              <p className="font-mono text-lg font-semibold text-blue-700 dark:text-blue-300">
                {active.suggestedLocationCode ?? "Choose any suitable bin"}
              </p>
            </div>

            <ScanInput label="Scan destination bin" onScan={complete} autoFocus disabled={busy} />

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setActive(null)}>
                Cancel
              </Button>
              {active.suggestedLocationCode && (
                <Button size="sm" onClick={() => complete(active.suggestedLocationCode!)} disabled={busy}>
                  Confirm suggested bin
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="bg-white dark:bg-[#131317]">
        <CardHeader>
          <CardTitle className="text-base">Putaway queue</CardTitle>
          <p className="text-xs text-gray-500 dark:text-gray-400">Ordered by ABC priority, then age</p>
        </CardHeader>
        <CardContent>
          <DataTable columns={columns} rows={queue} emptyMessage="No open putaway tasks. The dock is clear." />
        </CardContent>
      </Card>
    </div>
  )
}

function PriorityChip({ priority }: { priority: number }) {
  const tone =
    priority === 1
      ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
      : priority === 2
        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
        : "bg-gray-100 text-gray-600 dark:bg-[#1F1F23] dark:text-gray-400"
  return <span className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-semibold ${tone}`}>P{priority}</span>
}
