"use client"

import * as React from "react"
import { ChevronRight, Truck } from "lucide-react"

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
  formatDate,
  formatNumber,
} from "@/components/wms/primitives"
import type { Column } from "@/components/wms/primitives"

/**
 * Receiving desk.
 *
 * The ASN state machine is shown as a stepper so the operator can see which step
 * the truck is on, and each line is received by scanning the SKU barcode — which
 * is how a 40-line inbound gets cleared without typing a single code.
 */

type InboundStatus = "expected" | "arrived" | "unloading" | "receiving" | "qc" | "putaway" | "complete" | "cancelled"

interface ReceiptLine {
  id: string
  skuId: string
  skuCode: string
  skuName: string
  uom: string
  quantityExpected: number
  quantityReceived: number
  quantityRejected: number
  lot: string | null
  expiresAt: string | null
  condition: string
}

interface InboundShipment {
  id: string
  number: string
  supplierId: string
  supplierName: string
  warehouseCode: string
  carrier: string
  trackingNumber: string
  status: InboundStatus
  eta: string
  dockDoor: string
  lines: ReceiptLine[]
  createdAt: string
}

interface InboundResponse {
  shipments: InboundShipment[]
  purchaseOrders: Array<{
    id: string
    number: string
    supplierName: string
    status: string
    expectedDate: string
    lines: Array<{ skuCode: string; skuName: string; quantityOrdered: number; quantityReceived: number }>
  }>
}

interface MasterData {
  skus: Array<{ id: string; code: string; name: string; barcode: string; lotControlled: boolean; expiryControlled: boolean }>
}

const FLOW: InboundStatus[] = ["arrived", "unloading", "receiving", "qc", "putaway"]

export default function InboundPage() {
  const { toast } = useToast()
  const inbound = useApi<InboundResponse>("/api/wms/inbound")
  const master = useApi<MasterData>("/api/wms/master-data")
  const [selected, setSelected] = React.useState<InboundShipment | null>(null)
  const [busy, setBusy] = React.useState(false)

  // Keep the open shipment in sync with refreshed data.
  React.useEffect(() => {
    if (!selected) return
    const fresh = inbound.data?.shipments.find((s) => s.id === selected.id)
    if (fresh) setSelected(fresh)
  }, [inbound.data, selected])

  const advance = async (to: InboundStatus) => {
    if (!selected || busy) return
    setBusy(true)
    try {
      await inbound.mutate(() => api.post(`/api/wms/inbound/${selected.id}/receive`, { action: "advance", to }))
      toast({ title: "Status advanced", description: `${selected.number} is now "${to}".` })
    } catch (error) {
      toast({ variant: "destructive", title: "Cannot advance", description: describeError(error) })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Barcode scan handler: finds the matching open line and receives one unit at
   * a time. Receiving unit-by-unit is what makes the counter on screen match the
   * pallet, and it is fast enough because a scanner types in milliseconds.
   */
  const handleScan = async (value: string) => {
    if (!selected || busy) return

    const sku = master.data?.skus.find(
      (s) => s.barcode === value || s.code.toUpperCase() === value.toUpperCase(),
    )
    if (!sku) {
      toast({ variant: "destructive", title: "Unknown code", description: `No SKU matches "${value}".` })
      return
    }

    const line = selected.lines.find(
      (l) => l.skuId === sku.id && l.quantityReceived < l.quantityExpected,
    )
    if (!line) {
      toast({
        variant: "warning",
        title: "Nothing open for this SKU",
        description: `${sku.code} is fully received or not on ${selected.number}.`,
      })
      return
    }

    if (sku.lotControlled && !line.lot) {
      toast({
        variant: "warning",
        title: "Lot required",
        description: `${sku.code} is lot-controlled. Enter the lot number on the line first.`,
      })
      return
    }

    setBusy(true)
    try {
      await inbound.mutate(() =>
        api.post(`/api/wms/inbound/${selected.id}/receive`, {
          lineId: line.id,
          quantityReceived: 1,
          lot: line.lot,
          expiresAt: line.expiresAt,
        }),
      )
    } catch (error) {
      toast({ variant: "destructive", title: "Receipt rejected", description: describeError(error) })
    } finally {
      setBusy(false)
    }
  }

  const receiveBulk = async (line: ReceiptLine, quantity: number) => {
    if (!selected || busy) return
    setBusy(true)
    try {
      await inbound.mutate(() =>
        api.post(`/api/wms/inbound/${selected.id}/receive`, {
          lineId: line.id,
          quantityReceived: quantity,
          lot: line.lot,
          expiresAt: line.expiresAt,
        }),
      )
      toast({ title: "Received", description: `${quantity} × ${line.skuCode} on ${selected.number}.` })
    } catch (error) {
      toast({ variant: "destructive", title: "Receipt rejected", description: describeError(error) })
    } finally {
      setBusy(false)
    }
  }

  const openLines = selected?.lines.filter((l) => l.quantityReceived < l.quantityExpected) ?? []
  const nextStatus = selected ? FLOW.find((s) => FLOW.indexOf(s) > FLOW.indexOf(selected.status)) : undefined

  if (inbound.initialising) return <LoadingState label="Loading inbound…" />

  const shipmentColumns: Column<InboundShipment>[] = [
    { key: "number", header: "ASN", render: (row) => <span className="font-mono text-xs font-medium">{row.number}</span> },
    { key: "supplier", header: "Supplier", render: (row) => row.supplierName },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    { key: "eta", header: "ETA", render: (row) => formatDate(row.eta) },
    { key: "dock", header: "Dock", render: (row) => <span className="font-mono text-xs">{row.dockDoor}</span> },
    {
      key: "progress",
      header: "Lines",
      align: "right",
      render: (row) => {
        const received = row.lines.reduce((sum, l) => sum + l.quantityReceived, 0)
        const expected = row.lines.reduce((sum, l) => sum + l.quantityExpected, 0)
        return `${formatNumber(received)}/${formatNumber(expected)}`
      },
    },
    {
      key: "open",
      header: "",
      align: "right",
      render: (row) => (
        <Button variant="ghost" size="sm" onClick={(event) => { event.stopPropagation(); setSelected(row) }}>
          Open <ChevronRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      ),
    },
  ]

  const lineColumns: Column<ReceiptLine>[] = [
    { key: "sku", header: "SKU", render: (row) => <span className="font-mono text-xs">{row.skuCode}</span> },
    { key: "name", header: "Item", className: "max-w-[16rem] truncate", render: (row) => row.skuName },
    { key: "lot", header: "Lot", render: (row) => (row.lot ? <span className="font-mono text-xs">{row.lot}</span> : <span className="text-gray-400">—</span>) },
    { key: "expected", header: "Expected", align: "right", render: (row) => formatNumber(row.quantityExpected) },
    {
      key: "received",
      header: "Received",
      align: "right",
      render: (row) => (
        <span className={row.quantityReceived >= row.quantityExpected ? "font-medium text-green-600 dark:text-green-400" : ""}>
          {formatNumber(row.quantityReceived)}
        </span>
      ),
    },
    { key: "rejected", header: "Rejected", align: "right", render: (row) => (row.quantityRejected ? <span className="text-red-600 dark:text-red-400">{formatNumber(row.quantityRejected)}</span> : "—") },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (row) => {
        const remaining = row.quantityExpected - row.quantityReceived
        return (
          <div className="flex justify-end gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={remaining <= 0 || busy}
              onClick={() => receiveBulk(row, remaining)}
            >
              Receive all
            </Button>
          </div>
        )
      },
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Receiving"
        description="Advance inbound shipments through the dock and record what physically arrived."
        actions={
          <Button variant="outline" size="sm" onClick={inbound.refetch} disabled={inbound.loading}>
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Inbound shipments" value={formatNumber(inbound.data?.shipments.length ?? 0)} icon={Truck} />
        <StatCard
          label="At the dock"
          value={formatNumber(inbound.data?.shipments.filter((s) => ["arrived", "unloading"].includes(s.status)).length ?? 0)}
          tone="warn"
        />
        <StatCard
          label="Being received"
          value={formatNumber(inbound.data?.shipments.filter((s) => s.status === "receiving").length ?? 0)}
          tone="good"
        />
        <StatCard label="Purchase orders" value={formatNumber(inbound.data?.purchaseOrders.length ?? 0)} />
      </div>

      {inbound.error && <ErrorState message={describeError(inbound.error)} onRetry={inbound.refetch} />}

      {selected ? (
        <Card className="bg-white dark:bg-[#131317]">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">
                  {selected.number} — {selected.supplierName}
                </CardTitle>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {selected.carrier} · {selected.trackingNumber || "no tracking"} · dock {selected.dockDoor} · ETA{" "}
                  {formatDate(selected.eta)}
                </p>
              </div>
              <div className="flex gap-2">
                {nextStatus && (
                  <Button size="sm" onClick={() => advance(nextStatus)} disabled={busy}>
                    Mark as {nextStatus}
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => setSelected(null)}>
                  Back to list
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <Flow status={selected.status} />

            <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
              <div className="space-y-3">
                <ScanInput
                  label="Scan SKU barcode"
                  onScan={handleScan}
                  disabled={busy || openLines.length === 0}
                  placeholder={openLines.length === 0 ? "All lines received" : "Scan to receive one unit"}
                />
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {openLines.length} line{openLines.length === 1 ? "" : "s"} still open. Scanning receives one unit at a
                  time so the count matches the pallet.
                </p>
              </div>

              <DataTable columns={lineColumns} rows={selected.lines} emptyMessage="No lines on this shipment." />
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className="bg-white dark:bg-[#131317]">
            <CardHeader>
              <CardTitle className="text-base">Inbound shipments</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={shipmentColumns}
                rows={inbound.data?.shipments ?? []}
                emptyMessage="No inbound shipments yet."
                onRowClick={setSelected}
              />
            </CardContent>
          </Card>

          <Card className="bg-white dark:bg-[#131317]">
            <CardHeader>
              <CardTitle className="text-base">Purchase orders</CardTitle>
              <p className="text-xs text-gray-500 dark:text-gray-400">Receipt progress against what was ordered</p>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={poColumns}
                rows={inbound.data?.purchaseOrders ?? []}
                rowKey={(row) => row.id}
                emptyMessage="No purchase orders yet."
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

/** Visual state stepper for the inbound flow. */
function Flow({ status }: { status: InboundStatus }) {
  const steps: InboundStatus[] = ["expected", ...FLOW, "complete"]
  const currentIndex = steps.indexOf(status)

  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label="Inbound progress">
      {steps.map((step, index) => {
        const done = index < currentIndex
        const current = index === currentIndex
        return (
          <li key={step} className="flex items-center gap-1.5">
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium capitalize ${
                current
                  ? "bg-blue-600 text-white"
                  : done
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                    : "bg-gray-100 text-gray-500 dark:bg-[#1F1F23] dark:text-gray-400"
              }`}
              aria-current={current ? "step" : undefined}
            >
              {step}
            </span>
            {index < steps.length - 1 && <ChevronRight className="h-3 w-3 text-gray-300 dark:text-gray-600" />}
          </li>
        )
      })}
    </ol>
  )
}

const poColumns: Column<{
  id: string
  number: string
  supplierName: string
  status: string
  expectedDate: string
  lines: Array<{ skuCode: string; skuName: string; quantityOrdered: number; quantityReceived: number }>
}>[] = [
  { key: "number", header: "PO", render: (row) => <span className="font-mono text-xs font-medium">{row.number}</span> },
  { key: "supplier", header: "Supplier", render: (row) => row.supplierName },
  { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
  { key: "expected", header: "Expected", render: (row) => formatDate(row.expectedDate) },
  {
    key: "lines",
    header: "Lines",
    align: "right",
    render: (row) => {
      const ordered = row.lines.reduce((sum, l) => sum + l.quantityOrdered, 0)
      const received = row.lines.reduce((sum, l) => sum + l.quantityReceived, 0)
      return `${formatNumber(received)}/${formatNumber(ordered)}`
    },
  },
]
