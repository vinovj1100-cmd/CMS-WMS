"use client"

import * as React from "react"
import { Undo2 } from "lucide-react"

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
 * Returns (RMA).
 *
 * Two approvals are deliberately separate: reviewing decides *whether* the return
 * is accepted, receiving decides *what happens to the physical item*. Only
 * `restock` puts units back into saleable stock — everything else parks them in
 * the returns area as held, so a damaged item can never quietly reappear as
 * sellable inventory.
 */

interface ReturnRow {
  id: string
  number: string
  orderNumber: string | null
  customerName: string
  skuCode: string
  skuName: string
  quantity: number
  reason: string
  disposition: string | null
  status: string
  lot: string | null
  reviewedBy: string | null
  createdAt: string
  receivedAt: string | null
}

interface MasterData {
  customers: Array<{ id: string; code: string; name: string }>
  skus: Array<{ id: string; code: string; name: string }>
  warehouses: Array<{ id: string; code: string; name: string }>
}

const REASONS = [
  { value: "damaged", label: "Damaged in transit" },
  { value: "wrong_item", label: "Wrong item shipped" },
  { value: "not_needed", label: "No longer needed" },
  { value: "late_delivery", label: "Delivered too late" },
  { value: "quality", label: "Quality issue" },
] as const

const DISPOSITIONS = [
  { value: "restock", label: "Restock as saleable" },
  { value: "refurbish", label: "Send to refurbish" },
  { value: "scrap", label: "Scrap" },
  { value: "vendor_return", label: "Return to vendor" },
] as const

export default function ReturnsPage() {
  const { toast } = useToast()
  const returns = useApi<{ returns: ReturnRow[] }>("/api/wms/returns")
  const master = useApi<MasterData>("/api/wms/master-data")
  const [creating, setCreating] = React.useState(false)
  const [receiving, setReceiving] = React.useState<ReturnRow | null>(null)
  const [busy, setBusy] = React.useState(false)

  const act = async (label: string, fn: () => Promise<unknown>, description?: string) => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
      await returns.refetch()
      toast({ variant: "success", title: label, description })
    } catch (error) {
      toast({ variant: "destructive", title: `${label} failed`, description: describeError(error) })
    } finally {
      setBusy(false)
    }
  }

  const review = (row: ReturnRow, approve: boolean) =>
    act(
      approve ? "Return approved" : "Return rejected",
      () => returns.mutate(() => api.post("/api/wms/returns", { action: "review", rmaId: row.id, approve })),
      `${row.number} ${approve ? "approved" : "rejected"}.`,
    )

  if (returns.initialising) return <LoadingState label="Loading returns…" />

  const all = returns.data?.returns ?? []

  const columns: Column<ReturnRow>[] = [
    { key: "number", header: "RMA", render: (row) => <span className="font-mono text-xs font-medium">{row.number}</span> },
    { key: "order", header: "Order", render: (row) => (row.orderNumber ? <span className="font-mono text-xs">{row.orderNumber}</span> : <span className="text-gray-400">—</span>) },
    { key: "customer", header: "Customer", render: (row) => row.customerName },
    { key: "sku", header: "SKU", render: (row) => <span className="font-mono text-xs">{row.skuCode}</span> },
    { key: "qty", header: "Qty", align: "right", render: (row) => formatNumber(row.quantity) },
    { key: "reason", header: "Reason", render: (row) => <span className="capitalize">{row.reason.replace(/_/g, " ")}</span> },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    {
      key: "disposition",
      header: "Disposition",
      render: (row) => (row.disposition ? <span className="capitalize">{row.disposition.replace(/_/g, " ")}</span> : <span className="text-gray-400">—</span>),
    },
    { key: "created", header: "Raised", render: (row) => formatDate(row.createdAt) },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (row) => (
        <div className="flex justify-end gap-1.5">
          {row.status === "requested" && (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => review(row, true)}>Approve</Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => review(row, false)}>Reject</Button>
            </>
          )}
          {row.status === "approved" && (
            <Button size="sm" disabled={busy} onClick={() => setReceiving(row)}>Receive</Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Returns"
        description="Authorise, receive and disposition returned stock. Only 'restock' returns items to saleable inventory."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={returns.refetch} disabled={returns.loading}>Refresh</Button>
            <Button size="sm" onClick={() => setCreating(true)}>New RMA</Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Returns" value={formatNumber(all.length)} icon={Undo2} />
        <StatCard label="Awaiting review" value={formatNumber(all.filter((r) => r.status === "requested").length)} tone="warn" />
        <StatCard label="Awaiting receipt" value={formatNumber(all.filter((r) => r.status === "approved").length)} tone="bad" />
        <StatCard label="Processed" value={formatNumber(all.filter((r) => r.status === "processed").length)} tone="good" />
      </div>

      {returns.error && <ErrorState message={describeError(returns.error)} onRetry={returns.refetch} />}

      <Card className="bg-white dark:bg-[#131317]">
        <CardHeader>
          <CardTitle className="text-base">Return authorisations</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable columns={columns} rows={all} emptyMessage="No returns recorded." />
        </CardContent>
      </Card>

      {creating && (
        <CreateDialog
          customers={master.data?.customers ?? []}
          skus={master.data?.skus ?? []}
          warehouses={master.data?.warehouses ?? []}
          onClose={() => setCreating(false)}
          onCreate={async (payload) => {
            await act("RMA created", () => returns.mutate(() => api.post("/api/wms/returns", payload)), `${payload.quantity} unit(s) pending review.`)
            setCreating(false)
          }}
        />
      )}

      {receiving && (
        <ReceiveDialog
          rma={receiving}
          onClose={() => setReceiving(null)}
          onSubmit={async (payload) => {
            await act(
              "Return received",
              () => returns.mutate(() => api.post("/api/wms/returns", { action: "receive", rmaId: receiving.id, ...payload })),
              payload.disposition === "restock"
                ? `${receiving.quantity} unit(s) back in saleable stock.`
                : `${receiving.quantity} unit(s) held for ${payload.disposition.replace(/_/g, " ")}.`,
            )
            setReceiving(null)
          }}
        />
      )}
    </div>
  )
}

function CreateDialog({
  customers,
  skus,
  warehouses,
  onClose,
  onCreate,
}: {
  customers: Array<{ id: string; code: string; name: string }>
  skus: Array<{ id: string; code: string; name: string }>
  warehouses: Array<{ id: string; code: string; name: string }>
  onClose: () => void
  onCreate: (payload: { customerId: string; warehouseId: string; skuId: string; quantity: number; reason: string }) => Promise<void>
}) {
  const [customerId, setCustomerId] = React.useState(customers[0]?.id ?? "")
  const [warehouseId, setWarehouseId] = React.useState(warehouses[0]?.id ?? "")
  const [skuId, setSkuId] = React.useState(skus[0]?.id ?? "")
  const [quantity, setQuantity] = React.useState("1")
  const [reason, setReason] = React.useState<string>(REASONS[0]!.value)
  const [submitting, setSubmitting] = React.useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    try {
      await onCreate({ customerId, warehouseId, skuId, quantity: Number(quantity), reason })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal title="New return authorisation" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="rma-customer">Customer</Label>
          <Select value={customerId} onValueChange={setCustomerId}>
            <SelectTrigger id="rma-customer"><SelectValue /></SelectTrigger>
            <SelectContent>
              {customers.map((customer) => (
                <SelectItem key={customer.id} value={customer.id}>{customer.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="rma-warehouse">Receiving warehouse</Label>
          <Select value={warehouseId} onValueChange={setWarehouseId}>
            <SelectTrigger id="rma-warehouse"><SelectValue /></SelectTrigger>
            <SelectContent>
              {warehouses.map((warehouse) => (
                <SelectItem key={warehouse.id} value={warehouse.id}>{warehouse.code}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="rma-sku">SKU</Label>
          <Select value={skuId} onValueChange={setSkuId}>
            <SelectTrigger id="rma-sku"><SelectValue /></SelectTrigger>
            <SelectContent>
              {skus.map((sku) => (
                <SelectItem key={sku.id} value={sku.id}>{sku.code} — {sku.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="rma-qty">Quantity</Label>
            <Input id="rma-qty" type="number" min="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} required />
          </div>
          <div>
            <Label htmlFor="rma-reason">Reason</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger id="rma-reason"><SelectValue /></SelectTrigger>
              <SelectContent>
                {REASONS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={submitting || !customerId || !skuId}>Create RMA</Button>
        </div>
      </form>
    </Modal>
  )
}

function ReceiveDialog({
  rma,
  onClose,
  onSubmit,
}: {
  rma: ReturnRow
  onClose: () => void
  onSubmit: (payload: { disposition: string; location: string }) => Promise<void>
}) {
  const [disposition, setDisposition] = React.useState<string>("restock")
  const [location, setLocation] = React.useState("RET-01")
  const [submitting, setSubmitting] = React.useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    try {
      await onSubmit({ disposition, location: location.trim() })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal title={`Receive ${rma.number}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {formatNumber(rma.quantity)} × <span className="font-mono">{rma.skuCode}</span> — {rma.skuName}
        </p>

        <div>
          <Label htmlFor="rma-disp">Disposition</Label>
          <Select value={disposition} onValueChange={setDisposition}>
            <SelectTrigger id="rma-disp"><SelectValue /></SelectTrigger>
            <SelectContent>
              {DISPOSITIONS.map((item) => (
                <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            Only &ldquo;Restock as saleable&rdquo; returns units to available stock. Everything else is held in the returns
            area until a person decides what to do with it.
          </p>
        </div>

        <div>
          <Label htmlFor="rma-loc">Put-away location</Label>
          <Input
            id="rma-loc"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            required
            className="font-mono"
            autoComplete="off"
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={submitting}>Receive</Button>
        </div>
      </form>
    </Modal>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto space-y-4 rounded-lg bg-white p-5 shadow-xl dark:bg-[#131317]">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h2>
        {children}
      </div>
    </div>
  )
}
