"use client"

import * as React from "react"
import { ShieldAlert, ShieldCheck, XCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { qs } from "@/lib/api/client"
import { useApi, describeError } from "@/hooks/use-wms"
import {
  DataTable,
  DebouncedSearch,
  ErrorState,
  LoadingState,
  PageHeader,
  StatCard,
  StatusBadge,
  formatDateTime,
  formatNumber,
} from "@/components/wms/primitives"
import type { Column } from "@/components/wms/primitives"

/**
 * Audit trail.
 *
 * Read-only by design — there is no delete endpoint anywhere in this app. The
 * most useful filter in practice is `outcome: denied`, which shows every attempt
 * to do something the user was not entitled to do.
 */

interface AuditEntry {
  id: string
  timestamp: string
  actor: string
  actorRole: string
  action: string
  resource: string
  resourceId: string | null
  outcome: string
  ip: string
  userAgent: string
  metadata: Record<string, unknown>
}

interface AuditResponse {
  data: AuditEntry[]
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
  totals: { entries: number; denied: number; failed: number }
}

export default function AuditPage() {
  const [outcome, setOutcome] = React.useState("all")
  const [action, setAction] = React.useState("")
  const [page, setPage] = React.useState(1)
  const [expanded, setExpanded] = React.useState<string | null>(null)

  const path = React.useMemo(
    () =>
      `/api/wms/audit${qs({
        outcome: outcome === "all" ? undefined : outcome,
        action: action || undefined,
        page,
        pageSize: 30,
      })}`,
    [outcome, action, page],
  )

  const audit = useApi<AuditResponse>(path)

  if (audit.initialising) return <LoadingState label="Loading audit trail…" />

  const columns: Column<AuditEntry>[] = [
    { key: "timestamp", header: "When", render: (row) => <span className="whitespace-nowrap text-xs">{formatDateTime(row.timestamp)}</span> },
    { key: "actor", header: "Actor", render: (row) => <span className="font-medium">{row.actor}</span> },
    { key: "role", header: "Role", render: (row) => <span className="text-xs capitalize text-gray-500 dark:text-gray-400">{row.actorRole.replace(/_/g, " ")}</span> },
    { key: "action", header: "Action", render: (row) => <span className="font-mono text-xs">{row.action}</span> },
    { key: "resource", header: "Resource", render: (row) => <span className="text-xs">{row.resource}{row.resourceId ? ` · ${row.resourceId}` : ""}</span> },
    { key: "outcome", header: "Outcome", render: (row) => <StatusBadge status={row.outcome} /> },
    { key: "ip", header: "IP", render: (row) => <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{row.ip}</span> },
    {
      key: "detail",
      header: "",
      align: "right",
      render: (row) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={(event) => {
            event.stopPropagation()
            setExpanded(expanded === row.id ? null : row.id)
          }}
        >
          {expanded === row.id ? "Hide" : "Detail"}
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Log"
        description="Append-only record of every authenticated action, permission denial and failed sign-in."
        actions={
          <Button variant="outline" size="sm" onClick={audit.refetch} disabled={audit.loading}>Refresh</Button>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Entries" value={formatNumber(audit.data?.totals.entries ?? 0)} icon={ShieldCheck} />
        <StatCard
          label="Denied"
          value={formatNumber(audit.data?.totals.denied ?? 0)}
          hint="Permission refusals"
          icon={ShieldAlert}
          tone={(audit.data?.totals.denied ?? 0) > 0 ? "warn" : "good"}
        />
        <StatCard
          label="Failed"
          value={formatNumber(audit.data?.totals.failed ?? 0)}
          hint="Rejected operations"
          icon={XCircle}
          tone={(audit.data?.totals.failed ?? 0) > 0 ? "bad" : "good"}
        />
        <StatCard label="Shown" value={formatNumber(audit.data?.pagination.total ?? 0)} />
      </div>

      {audit.error && <ErrorState message={describeError(audit.error)} onRetry={audit.refetch} />}

      <Card className="bg-white dark:bg-[#131317]">
        <CardHeader>
          <CardTitle className="text-base">Entries</CardTitle>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            This log has no delete path. Retention is handled by archiving externally.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <DebouncedSearch value={action} onChange={(next) => { setAction(next); setPage(1) }} placeholder="Filter by action…" />

            <div className="w-full sm:w-44">
              <Label className="mb-1.5 text-xs">Outcome</Label>
              <Select value={outcome} onValueChange={(value) => { setOutcome(value); setPage(1) }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All outcomes</SelectItem>
                  <SelectItem value="success">Success</SelectItem>
                  <SelectItem value="denied">Denied</SelectItem>
                  <SelectItem value="failure">Failure</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DataTable
            columns={columns}
            rows={audit.data?.data ?? []}
            emptyMessage="No audit entries match these filters."
            rowKey={(row) => row.id}
          />

          {expanded && (
            <div className="rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-[#1F1F23] dark:bg-[#1F1F23]">
              <p className="mb-2 text-xs font-medium text-gray-700 dark:text-gray-300">Entry detail</p>
              <pre className="overflow-x-auto text-[11px] leading-relaxed text-gray-600 dark:text-gray-400">
                {JSON.stringify(audit.data?.data.find((entry) => entry.id === expanded) ?? {}, null, 2)}
              </pre>
            </div>
          )}

          {audit.data && audit.data.pagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Page {audit.data.pagination.page} of {audit.data.pagination.totalPages}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= audit.data.pagination.totalPages}
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
