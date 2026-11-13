"use client"

import * as React from "react"
import { AlertTriangle, Loader2, RefreshCcw, ScanLine, Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/**
 * Shared building blocks for the warehouse screens.
 *
 * Keeping these in one place is what makes the pages short enough to read: a
 * screen is a grid of `StatCard`s over a `DataTable`, not 400 lines of div.
 */

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

export interface StatCardProps {
  label: string
  value: string | number
  hint?: string
  icon?: React.ComponentType<{ className?: string }>
  tone?: "default" | "good" | "warn" | "bad"
}

const TONE_STYLES: Record<NonNullable<StatCardProps["tone"]>, string> = {
  default: "text-gray-900 dark:text-white",
  good: "text-green-600 dark:text-green-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-red-600 dark:text-red-400",
}

export function StatCard({ label, value, hint, icon: Icon, tone = "default" }: StatCardProps) {
  return (
    <Card className="bg-white dark:bg-[#131317]">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {label}
            </p>
            <p className={cn("mt-1 text-2xl font-semibold tabular-nums", TONE_STYLES[tone])}>{value}</p>
            {hint && <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
          </div>
          {Icon && (
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-600 dark:bg-[#1F1F23] dark:text-gray-300">
              <Icon className="h-4 w-4" />
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_TONES: Record<string, string> = {
  // Greens — settled / done
  complete: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  completed: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  shipped: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  delivered: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  received: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  approved: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  processed: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  success: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  empty: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  restock: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",

  // Blues — moving
  in_progress: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  in_transit: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  picking: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  receiving: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  released: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  submitted: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  unloading: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  putaway: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  allocated: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  packed: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  occupied: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  manifested: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",

  // Ambers — waiting on a human
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  planned: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  draft: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  expected: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  scheduled: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  requested: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  qc: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  arrived: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  variance_review: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  reserved: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  new: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  pending_approval: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  refurbish: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",

  // Reds — needs attention
  short: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  cancelled: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  backordered: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  blocked: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  exception: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  denied: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  failure: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  scrap: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  damaged: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
        STATUS_TONES[status] ?? "bg-gray-100 text-gray-700 dark:bg-[#1F1F23] dark:text-gray-300",
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Data table
// ---------------------------------------------------------------------------

export interface Column<T> {
  key: string
  header: string
  /** Right-aligns numeric columns so digits line up. */
  align?: "left" | "right"
  className?: string
  render: (row: T) => React.ReactNode
}

export function DataTable<T extends { id?: string }>({
  columns,
  rows,
  emptyMessage = "Nothing to show.",
  rowKey,
  onRowClick,
}: {
  columns: Column<T>[]
  rows: T[]
  emptyMessage?: string
  rowKey?: (row: T, index: number) => string
  onRowClick?: (row: T) => void
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-[#1F1F23] dark:text-gray-400">
        {emptyMessage}
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-[#1F1F23]">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-[#1F1F23] dark:text-gray-400">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  "whitespace-nowrap px-3 py-2.5 font-medium",
                  column.align === "right" ? "text-right" : "text-left",
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white dark:divide-[#1F1F23] dark:bg-[#131317]">
          {rows.map((row, index) => (
            <tr
              key={rowKey ? rowKey(row, index) : row.id ?? index}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                "transition-colors hover:bg-gray-50 dark:hover:bg-[#1F1F23]",
                onRowClick && "cursor-pointer",
              )}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    "whitespace-nowrap px-3 py-2.5 text-gray-700 dark:text-gray-300",
                    column.align === "right" ? "text-right tabular-nums" : "text-left",
                    column.className,
                  )}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-lg border border-gray-200 p-10 text-sm text-gray-500 dark:border-[#1F1F23] dark:text-gray-400">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-red-200 bg-red-50 p-10 text-center dark:border-red-900/40 dark:bg-red-900/10">
      <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
      <p className="max-w-md text-sm text-red-800 dark:text-red-300">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCcw className="mr-2 h-4 w-4" />
          Try again
        </Button>
      )}
    </div>
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Search box that reports after a pause rather than on every keystroke.
 * Keeps a filter-as-you-type list from firing a request per character.
 */
export function DebouncedSearch({
  value,
  onChange,
  placeholder = "Search…",
  delayMs = 300,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  delayMs?: number
}) {
  const [local, setLocal] = React.useState(value)

  React.useEffect(() => setLocal(value), [value])

  React.useEffect(() => {
    if (local === value) return
    const timer = setTimeout(() => onChange(local), delayMs)
    return () => clearTimeout(timer)
  }, [local, value, onChange, delayMs])

  return (
    <div className="relative w-full sm:w-64">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
      <Input
        type="search"
        value={local}
        onChange={(event) => setLocal(event.target.value)}
        placeholder={placeholder}
        className="pl-8"
        aria-label={placeholder}
      />
    </div>
  )
}

/**
 * Barcode-scanner-friendly input.
 *
 * Hardware scanners type the code and press Enter, so the component selects its
 * own contents on focus — an operator can scan the next item without touching
 * the field. `onScan` fires on Enter.
 */
export function ScanInput({
  onScan,
  label,
  placeholder = "Scan or type, then press Enter",
  autoFocus = false,
  disabled = false,
}: {
  onScan: (value: string) => void
  label: string
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
}) {
  const [value, setValue] = React.useState("")
  const ref = React.useRef<HTMLInputElement>(null)

  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed) return
    onScan(trimmed)
    setValue("")
    // Re-focus so the next scan lands here without a click.
    requestAnimationFrame(() => ref.current?.focus())
  }

  return (
    <div className="w-full">
      <label htmlFor={`scan-${label}`} className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-400">
        <ScanLine className="h-3.5 w-3.5" />
        {label}
      </label>
      <Input
        id={`scan-${label}`}
        ref={ref}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        // Select-on-focus is what makes back-to-back scanning work.
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            submit()
          }
        }}
        className="font-mono"
        autoComplete="off"
        inputMode="none"
      />
    </div>
  )
}

/** Formats a number with thousands separators; renders an em dash for nullish. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return new Intl.NumberFormat("en-US").format(value)
}

/** Currency in the deployment's locale; AED for the demo dataset. */
export function formatCurrency(value: number | null | undefined, currency = "AED"): string {
  if (value === null || value === undefined) return "—"
  return new Intl.NumberFormat("en-AE", { style: "currency", currency, maximumFractionDigits: 0 }).format(value)
}

/** Short relative timestamp for lists; full timestamp in the title attribute. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}
