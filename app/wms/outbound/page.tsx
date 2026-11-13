"use client"

import * as React from "react"
import { Layers, PackageCheck, Zap } from "lucide-react"

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
 * Outbound order management.
 *
 * Covers the desk-side flow: allocate stock, group allocated orders into a wave,
 * release the wave, then pack and ship. Picking itself lives on its own screen
 * because it is done on a handheld, not at a desk.
 */

interface OrderLine {
  id: string
  skuId: string
  skuCode: string
  skuName: string
  quantityOrdered: number
  quantityAllocated: number
  quantityPicked: number
  quantityPacked: number
}

interface SalesOrder {
  id: string
  number: string
  customerName: string
  customerCode: string
  warehouseCode: string
  status: string
  priority: string
  requiredDate: string
  waveId: string | null
  waveNumber: string | null
  carrier: string
  trackingNumber: string | null
  lines: OrderLine[]
  createdAt: string
}

interface Wave {
  id: string
  number: string
  status: string
  strategy: string
  orderCount: number
  orderNumbers: string[]
  pickTasksTotal: number
  pickTasksComplete: number
  openHours: number
}

interface MasterData {
  customers: Array<{ id: string; code: string; name: string }>
  skus: Array<{ id: string; code: string; name: string }>
  warehouses: Array<{ id: string; code: string; name: string }>
}

export default function OutboundPage() {
  const { toast } = useToast()
  const orders = useApi<{ orders: SalesOrder[] }>("/api/wms/outbound")
  const waves = useApi<{ waves: Wave[] }>("/api/wms/waves")
  const master = useApi<MasterData>("/api/wms/master-data")

  const [status, setStatus] = React.useState("all")
  const [selectedOrders, setSelectedOrders] = React.useState<Set<string>>(new Set())
  const [packing, setPacking] = React.useState<SalesOrder | null>(null)
  const [shipping, setShipping] = React.useState<SalesOrder | null>(null)
  const [busy, setBusy] = React.useState(false)

  const refreshAll = async () => {
    await Promise.all([orders.refetch(), waves.refetch()])
  }

  const run = async (label: string, fn: () => Promise<unknown>, successDescription?: string) => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
      await refreshAll()
      toast({ variant: "success", title: label, description: successDescription })
    } catch (error) {
      toast({ variant: "destructive", title: `${label} failed`, description: describeError(error) })
    } finally {
      setBusy(false)
    }
  }

  const allocate = (order: SalesOrder) =>
    run("Order allocated", () => orders.mutate(() => api.post(`/api/wms/outbound/${order.id}`, { action: "allocate" })), `${order.number} now has stock reserved.`)

  const cancel = (order: SalesOrder) => {
    const reason = window.prompt(`Cancellation reason for ${order.number}:`, "Customer request")
    if (!reason) return
    return run("Order cancelled", () =>
      orders.mutate(() => api.post(`/api/wms/outbound/${order.id}`, { action: "cancel", reason })),
    )
  }

  const toggleOrder = (id: string) =>
    setSelectedOrders((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const createWave = () => {
    const warehouseId = orders.data?.orders.find((o) => selectedOrders.has(o.id))?.warehouseCode
    const record = master.data?.warehouses.find((w) => w.code === warehouseId)
    if (!record) {
      toast({ variant: "destructive", title: "Cannot wave", description: "Could not resolve the warehouse for the selected orders." })
      return
    }
    return run("Wave created", () =>
      waves.mutate(() =>
        api.post("/api/wms/waves", {
          warehouseId: record.id,
          orderIds: [...selectedOrders],
          strategy: "zone",
        }),
      ).then(() => setSelectedOrders(new Set())),
      `${selectedOrders.size} order(s) grouped.`,
    )
  }

  const releaseWave = (wave: Wave) =>
    run("Wave released", () => waves.mutate(() => api.post("/api/wms/waves", { waveId: wave.id })), `${wave.number} generated its pick tasks.`)

  if (orders.initialising) return <LoadingState label="Loading orders…" />

  const visible = (orders.data?.orders ?? []).filter((order) => status === "all" || order.status === status)
  const waveable = visible.filter((order) => order.status === "allocated" && !order.waveId)

  const columns: Column<SalesOrder>[] = [
    {
      key: "select",
      header: "",
      render: (row) =>
        row.status === "allocated" && !row.waveId ? (
          <input
            type="checkbox"
            checked={selectedOrders.has(row.id)}
            onChange={() => toggleOrder(row.id)}
            aria-label={`Select ${row.number}`}
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
        ) : null,
    },
    { key: "number", header: "Order", render: (row) => <span className="font-mono text-xs font-medium">{row.number}</span> },
    { key: "customer", header: "Customer", render: (row) => row.customerName },
    { key: "priority", header: "Priority", render: (row) => <StatusBadge status={row.priority} /> },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    {
      key: "lines",
      header: "Ordered / Picked",
      align: "right",
      render: (row) => {
        const ordered = row.lines.reduce((sum, l) => sum + l.quantityOrdered, 0)
        const picked = row.lines.reduce((sum, l) => sum + l.quantityPicked, 0)
        return `${formatNumber(picked)}/${formatNumber(ordered)}`
      },
    },
    { key: "wave", header: "Wave", render: (row) => (row.waveNumber ? <span className="font-mono text-xs">{row.waveNumber}</span> : <span className="text-gray-400">—</span>) },
    { key: "required", header: "Required", render: (row) => formatDate(row.requiredDate) },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (row) => (
        <div className="flex justify-end gap-1.5">
          {row.status === "new" && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => allocate(row)}>
              Allocate
            </Button>
          )}
          {row.status === "picking" && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setPacking(row)}>
              Pack
            </Button>
          )}
          {row.status === "packed" && (
            <Button size="sm" disabled={busy} onClick={() => setShipping(row)}>
              Ship
            </Button>
          )}
          {["new", "allocated", "backordered"].includes(row.status) && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => cancel(row)}>
              Cancel
            </Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Outbound Orders"
        description="Allocate stock, wave, then pack and ship. Picking runs from the handheld screen."
        actions={
          <Button variant="outline" size="sm" onClick={refreshAll} disabled={orders.loading}>
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Orders" value={formatNumber(orders.data?.orders.length ?? 0)} icon={PackageCheck} />
        <StatCard
          label="Ready to wave"
          value={formatNumber((orders.data?.orders ?? []).filter((o) => o.status === "allocated" && !o.waveId).length)}
          tone="warn"
        />
        <StatCard
          label="Awaiting ship"
          value={formatNumber((orders.data?.orders ?? []).filter((o) => o.status === "packed").length)}
          tone="good"
        />
        <StatCard label="Open waves" value={formatNumber((waves.data?.waves ?? []).filter((w) => w.status !== "complete").length)} icon={Layers} />
      </div>

      {orders.error && <ErrorState message={describeError(orders.error)} onRetry={orders.refetch} />}

      <Card className="bg-white dark:bg-[#131317]">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Waves</CardTitle>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Releasing a wave generates travel-sequenced pick tasks
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {["new", "allocated", "picking", "packed", "shipped", "backordered", "cancelled"].map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" onClick={createWave} disabled={selectedOrders.size === 0 || busy}>
                <Zap className="mr-2 h-4 w-4" />
                Wave {selectedOrders.size > 0 ? `(${selectedOrders.size})` : ""}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <DataTable
            columns={waveColumns}
            rows={waves.data?.waves ?? []}
            emptyMessage="No waves created yet."
          />

          <div className="space-y-2">
            <h3 className="text-sm font-medium text-gray-900 dark:text-white">Orders</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {waveable.length} allocated order(s) can be added to a wave.
            </p>
            <DataTable columns={columns} rows={visible} emptyMessage="No orders match this filter." />
          </div>
        </CardContent>
      </Card>

      {packing && (
        <PackDialog
          order={packing}
          onClose={() => setPacking(null)}
          onSubmit={async (payload) => {
            await run("Order packed", () =>
              orders.mutate(() => api.post(`/api/wms/outbound/${packing.id}`, { action: "pack", ...payload })),
              `${packing.number} is ready to ship.`,
            )
            setPacking(null)
          }}
        />
      )}

      {shipping && (
        <ShipDialog
          order={shipping}
          onClose={() => setShipping(null)}
          onSubmit={async (payload) => {
            await run("Order shipped", () =>
              orders.mutate(() => api.post(`/api/wms/outbound/${shipping.id}`, { action: "ship", ...payload })),
              `${shipping.number} shipped on ${shipping.carrier}.`,
            )
            setShipping(null)
          }}
        />
      )}
    </div>
  )
}

const waveColumns: Column<Wave>[] = [
  { key: "number", header: "Wave", render: (row) => <span className="font-mono text-xs font-medium">{row.number}</span> },
  { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
  { key: "strategy", header: "Strategy", render: (row) => <span className="capitalize">{row.strategy.replace(/_/g, " ")}</span> },
  { key: "orders", header: "Orders", align: "right", render: (row) => formatNumber(row.orderCount) },
  {
    key: "picks",
    header: "Picks done",
    align: "right",
    render: (row) => `${formatNumber(row.pickTasksComplete)}/${formatNumber(row.pickTasksTotal)}`,
  },
  { key: "age", header: "Open", align: "right", render: (row) => (row.openHours > 0 ? `${row.openHours}h` : "—") },
  {
    key: "actions",
    header: "",
    align: "right",
    render: (row) =>
      row.status === "planned" ? (
        <Button variant="outline" size="sm">Release</Button>
      ) : null,
  },
]

function PackDialog({
  order,
  onClose,
  onSubmit,
}: {
  order: SalesOrder
  onClose: () => void
  onSubmit: (payload: { items: Array<{ skuId: string; quantity: number }>; weightKg: number; cartonCount: number }) => Promise<void>
}) {
  const [weightKg, setWeightKg] = React.useState("10")
  const [cartonCount, setCartonCount] = React.useState("1")
  const [submitting, setSubmitting] = React.useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    try {
      await onSubmit({
        // Everything that was picked gets packed; short picks are resolved before
        // an order reaches this state.
        items: order.lines.filter((l) => l.quantityPicked > 0).map((l) => ({ skuId: l.skuId, quantity: l.quantityPicked })),
        weightKg: Number(weightKg),
        cartonCount: Number(cartonCount),
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalShell title={`Pack ${order.number}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <ul className="space-y-1.5 text-sm">
          {order.lines.map((line) => (
            <li key={line.id} className="flex justify-between">
              <span className="font-mono text-xs">{line.skuCode}</span>
              <span className="tabular-nums">{formatNumber(line.quantityPicked)} picked</span>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="weight">Total weight (kg)</Label>
            <Input id="weight" type="number" step="0.1" min="0" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="cartons">Cartons</Label>
            <Input id="cartons" type="number" min="1" value={cartonCount} onChange={(e) => setCartonCount(e.target.value)} required />
          </div>
        </div>
        <ModalFooter onClose={onClose} submitting={submitting} submitLabel="Confirm pack" />
      </form>
    </ModalShell>
  )
}

function ShipDialog({
  order,
  onClose,
  onSubmit,
}: {
  order: SalesOrder
  onClose: () => void
  onSubmit: (payload: { trackingNumber: string; serviceLevel: string }) => Promise<void>
}) {
  const [trackingNumber, setTrackingNumber] = React.useState("")
  const [serviceLevel, setServiceLevel] = React.useState(
    order.priority === "vip" ? "Next Day" : order.priority === "express" ? "Express 48h" : "Ground",
  )
  const [submitting, setSubmitting] = React.useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    try {
      await onSubmit({ trackingNumber: trackingNumber.trim(), serviceLevel })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalShell title={`Ship ${order.number}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Carrier: <span className="font-medium text-gray-700 dark:text-gray-300">{order.carrier}</span>
        </p>
        <div>
          <Label htmlFor="tracking">Tracking number</Label>
          <Input
            id="tracking"
            value={trackingNumber}
            onChange={(e) => setTrackingNumber(e.target.value)}
            minLength={4}
            required
            className="font-mono"
            autoComplete="off"
          />
        </div>
        <div>
          <Label htmlFor="service">Service level</Label>
          <Select value={serviceLevel} onValueChange={setServiceLevel}>
            <SelectTrigger id="service"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="Next Day">Next Day</SelectItem>
              <SelectItem value="Express 48h">Express 48h</SelectItem>
              <SelectItem value="Ground">Ground</SelectItem>
              <SelectItem value="Self Collection">Self Collection</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <ModalFooter onClose={onClose} submitting={submitting} submitLabel="Manifest shipment" />
      </form>
    </ModalShell>
  )
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-5 shadow-xl dark:bg-[#131317]">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h2>
        {children}
      </div>
    </div>
  )
}

function ModalFooter({ onClose, submitting, submitLabel }: { onClose: () => void; submitting: boolean; submitLabel: string }) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
      <Button type="submit" size="sm" disabled={submitting}>{submitting ? "Working…" : submitLabel}</Button>
    </div>
  )
}
