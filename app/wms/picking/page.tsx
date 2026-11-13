"use client"

import * as React from "react"
import { CheckCircle2, MapPin, ScanLine } from "lucide-react"

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
  ScanInput,
  StatCard,
  StatusBadge,
  formatNumber,
} from "@/components/wms/primitives"
import type { Column } from "@/components/wms/primitives"

/**
 * Handheld picking screen.
 *
 * Built for a scanner, not a mouse. The wave's tasks arrive already sorted into
 * the travel-optimised walk path, so the operator works straight down the list:
 * scan the bin, scan the SKU, enter the quantity, next.
 *
 * Location-first scanning is the control that matters — scanning the bin proves
 * the picker is standing in the right aisle before the system accepts a pick.
 */

interface PickTask {
  id: string
  number: string
  waveId: string
  orderId: string
  waveNumber: string
  orderNumber: string
  skuCode: string
  skuName: string
  barcode: string
  uom: string
  quantity: number
  quantityPicked: number
  fromLocationId: string
  locationCode: string
  aisle: string
  lot: string | null
  status: string
  sequence: number
}

interface Wave {
  id: string
  number: string
  status: string
  orderCount: number
  pickTasksTotal: number
  pickTasksComplete: number
}

export default function PickingPage() {
  const { toast } = useToast()
  const waves = useApi<{ waves: Wave[] }>("/api/wms/waves")
  const [waveId, setWaveId] = React.useState("all")
  const [confirmedLocation, setConfirmedLocation] = React.useState<string | null>(null)
  const [task, setTask] = React.useState<PickTask | null>(null)
  const [quantity, setQuantity] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const tasks = useApi<{ tasks: PickTask[] }>(
    `/api/wms/picks?status=open${waveId === "all" ? "" : `&waveId=${encodeURIComponent(waveId)}`}`,
    { refreshKey: waveId },
  )

  // Memoised so the auto-advance effect below has a stable dependency. A fresh
  // array on every render would re-run the effect on every render, which is what
  // made the scan inputs feel like they were resetting.
  const queue = React.useMemo(() => tasks.data?.tasks ?? [], [tasks.data])
  const current = task ?? queue[0] ?? null

  // Auto-advance to the next task when the current one completes.
  React.useEffect(() => {
    if (task && !queue.some((t) => t.id === task.id)) {
      setTask(null)
      setConfirmedLocation(null)
      setQuantity("")
    }
  }, [queue, task])

  React.useEffect(() => {
    if (current) setQuantity(String(current.quantity))
  }, [current])

  const verifyLocation = (scanned: string) => {
    if (!current) return
    if (scanned.toUpperCase() === current.locationCode.toUpperCase()) {
      setConfirmedLocation(scanned.toUpperCase())
    } else {
      toast({
        variant: "destructive",
        title: "Wrong location",
        description: `This task is at ${current.locationCode}, but ${scanned} was scanned.`,
      })
    }
  }

  const verifySku = (scanned: string) => {
    if (!current || !confirmedLocation) return
    const matches = scanned === current.barcode || scanned.toUpperCase() === current.skuCode.toUpperCase()
    if (!matches) {
      toast({
        variant: "destructive",
        title: "Wrong item",
        description: `Expected ${current.skuCode}. Scan the item barcode to confirm.`,
      })
    }
  }

  const confirmPick = async () => {
    if (!current || !confirmedLocation || busy) return
    const picked = Number(quantity)
    if (!Number.isFinite(picked) || picked < 0) {
      toast({ variant: "destructive", title: "Invalid quantity", description: "Enter the number of units picked." })
      return
    }

    setBusy(true)
    try {
      const result = await tasks.mutate(() =>
        api.post<{ short: boolean; remainingInWave: number; waveStatus: string | null }>("/api/wms/picks", {
          taskId: current.id,
          quantityPicked: picked,
        }),
      )

      toast({
        variant: result.short ? "warning" : "success",
        title: result.short ? "Short pick recorded" : "Pick confirmed",
        description: result.short
          ? `${picked} of ${current.quantity} picked. A supervisor will need to resolve the shortfall.`
          : `${formatNumber(picked)} × ${current.skuCode} picked. ${result.remainingInWave} task(s) left in this wave.`,
      })

      setTask(null)
      setConfirmedLocation(null)
      setQuantity("")
    } catch (error) {
      toast({ variant: "destructive", title: "Pick rejected", description: describeError(error) })
    } finally {
      setBusy(false)
    }
  }

  if (tasks.initialising || waves.initialising) return <LoadingState label="Loading pick queue…" />

  const columns: Column<PickTask>[] = [
    { key: "sequence", header: "#", align: "right", render: (row) => row.sequence },
    { key: "location", header: "Bin", render: (row) => <span className="font-mono text-xs font-medium">{row.locationCode}</span> },
    { key: "sku", header: "SKU", render: (row) => <span className="font-mono text-xs">{row.skuCode}</span> },
    { key: "name", header: "Item", className: "max-w-[14rem] truncate", render: (row) => row.skuName },
    { key: "qty", header: "Qty", align: "right", render: (row) => formatNumber(row.quantity) },
    { key: "order", header: "Order", render: (row) => <span className="font-mono text-xs">{row.orderNumber}</span> },
    { key: "wave", header: "Wave", render: (row) => <span className="font-mono text-xs">{row.waveNumber}</span> },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (row) => (
        <Button variant="outline" size="sm" onClick={(event) => { event.stopPropagation(); setTask(row) }}>
          Pick
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Picking"
        description="Tasks are sequenced by aisle, bay, level and position so you never walk an aisle twice."
        actions={
          <>
            <Select value={waveId} onValueChange={setWaveId}>
              <SelectTrigger className="w-48"><SelectValue placeholder="All open waves" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All open waves</SelectItem>
                {(waves.data?.waves ?? [])
                  .filter((wave) => wave.status === "released" || wave.status === "picking")
                  .map((wave) => (
                    <SelectItem key={wave.id} value={wave.id}>
                      {wave.number} ({wave.pickTasksComplete}/{wave.pickTasksTotal})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={tasks.refetch} disabled={tasks.loading}>
              Refresh
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Tasks in queue" value={formatNumber(queue.length)} icon={ScanLine} />
        <StatCard label="Next bin" value={current?.locationCode ?? "—"} icon={MapPin} />
        <StatCard label="Completed" value={formatNumber((tasks.data?.tasks ?? []).filter((t) => t.status === "complete").length)} icon={CheckCircle2} tone="good" />
        <StatCard label="Open waves" value={formatNumber((waves.data?.waves ?? []).filter((w) => w.status !== "complete").length)} />
      </div>

      {tasks.error && <ErrorState message={describeError(tasks.error)} onRetry={tasks.refetch} />}

      {current ? (
        <Card className="border-blue-200 bg-blue-50/40 dark:border-blue-900/40 dark:bg-blue-900/10">
          <CardHeader>
            <CardTitle className="text-base">
              Task {current.sequence} — {current.waveNumber}
            </CardTitle>
            <p className="text-xs text-gray-600 dark:text-gray-300">
              Order <span className="font-mono">{current.orderNumber}</span>
              {current.lot ? ` · lot ${current.lot}` : ""}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-md bg-white p-3 dark:bg-[#131317]">
                <p className="text-xs text-gray-500 dark:text-gray-400">Go to bin</p>
                <p className="font-mono text-xl font-semibold text-blue-700 dark:text-blue-300">{current.locationCode}</p>
                <p className="text-[11px] text-gray-500 dark:text-gray-400">Aisle {current.aisle}</p>
              </div>
              <div className="rounded-md bg-white p-3 dark:bg-[#131317]">
                <p className="text-xs text-gray-500 dark:text-gray-400">Item</p>
                <p className="font-mono text-sm font-semibold text-gray-900 dark:text-white">{current.skuCode}</p>
                <p className="truncate text-[11px] text-gray-500 dark:text-gray-400">{current.skuName}</p>
              </div>
              <div className="rounded-md bg-white p-3 dark:bg-[#131317]">
                <p className="text-xs text-gray-500 dark:text-gray-400">Pick quantity</p>
                <p className="text-xl font-semibold text-gray-900 dark:text-white">
                  {formatNumber(current.quantity)} <span className="text-sm font-normal text-gray-500">{current.uom}</span>
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <ScanInput
                label={confirmedLocation ? "Location verified" : "1. Scan bin to confirm location"}
                onScan={verifyLocation}
                disabled={Boolean(confirmedLocation)}
                autoFocus
              />
              <ScanInput
                label="2. Scan item barcode"
                onScan={verifySku}
                disabled={!confirmedLocation}
                placeholder={confirmedLocation ? "Scan the item" : "Confirm the bin first"}
              />
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="w-32">
                <Label htmlFor="qty">3. Units picked</Label>
                <Input
                  id="qty"
                  type="number"
                  min="0"
                  max={current.quantity}
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  disabled={!confirmedLocation}
                />
              </div>
              <div className="flex gap-2">
                <Button onClick={confirmPick} disabled={!confirmedLocation || busy}>
                  {busy ? "Confirming…" : "Confirm pick"}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setQuantity("0")
                    void confirmPick()
                  }}
                  title="Record nothing picked — flags the task short"
                >
                  Report short
                </Button>
                {task && (
                  <Button variant="ghost" onClick={() => { setTask(null); setConfirmedLocation(null) }}>
                    Back to queue
                  </Button>
                )}
              </div>
            </div>

            {!confirmedLocation && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Scan the bin first. Location-first scanning is what proves the pick happened in the right aisle.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card className="bg-white dark:bg-[#131317]">
          <CardContent className="p-10 text-center text-sm text-gray-500 dark:text-gray-400">
            Pick queue is clear. Release a wave to generate new tasks.
          </CardContent>
        </Card>
      )}

      <Card className="bg-white dark:bg-[#131317]">
        <CardHeader>
          <CardTitle className="text-base">Pick queue</CardTitle>
          <p className="text-xs text-gray-500 dark:text-gray-400">Sorted into walk order</p>
        </CardHeader>
        <CardContent>
          <DataTable columns={columns} rows={queue} emptyMessage="No open pick tasks." />
        </CardContent>
      </Card>
    </div>
  )
}
