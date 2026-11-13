"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  Archive,
  BarChart3,
  Boxes,
  ClipboardCheck,
  LayoutDashboard,
  LogOut,
  Menu,
  PackageCheck,
  RefreshCcw,
  ScrollText,
  ShieldCheck,
  Truck,
  Undo2,
  Users,
  Warehouse,
  X,
} from "lucide-react"

import { ThemeToggle } from "@/components/theme-toggle"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { api, ApiRequestError } from "@/lib/api/client"
import { ROLE_LABELS } from "@/lib/security/rbac"
import type { Permission } from "@/lib/security/rbac"
import type { Role } from "@/lib/wms/types"
import { cn } from "@/lib/utils"

/**
 * Application shell for the warehouse screens.
 *
 * Navigation is filtered against the signed-in user's permissions, so an
 * operator never sees an Admin link they cannot use. This is convenience only —
 * the API enforces the same rules independently.
 */

interface SessionUser {
  id: string
  username: string
  name: string
  role: Role
  permissions: Permission[]
  mustChangePassword: boolean
  lastLoginAt: string | null
}

interface NavItem {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  permission: Permission
  /** Shown in the nav badge, e.g. open task counts. */
  badge?: number
}

const NAV: Array<{ group: string; items: NavItem[] }> = [
  {
    group: "Operations",
    items: [
      { href: "/wms", label: "Dashboard", icon: LayoutDashboard, permission: "reports:read" },
      { href: "/wms/inventory", label: "Inventory", icon: Boxes, permission: "inventory:read" },
      { href: "/wms/locations", label: "Locations", icon: Warehouse, permission: "location:read" },
    ],
  },
  {
    group: "Inbound",
    items: [
      { href: "/wms/inbound", label: "Receiving", icon: Truck, permission: "inbound:read" },
      { href: "/wms/putaway", label: "Putaway", icon: Archive, permission: "inbound:putaway" },
    ],
  },
  {
    group: "Outbound",
    items: [
      { href: "/wms/outbound", label: "Orders", icon: PackageCheck, permission: "outbound:read" },
      { href: "/wms/picking", label: "Picking", icon: ClipboardCheck, permission: "outbound:pick" },
    ],
  },
  {
    group: "Control",
    items: [
      { href: "/wms/cycle-count", label: "Cycle Counts", icon: RefreshCcw, permission: "cyclecount:read" },
      { href: "/wms/returns", label: "Returns", icon: Undo2, permission: "returns:read" },
      { href: "/wms/reports", label: "Reports", icon: BarChart3, permission: "reports:read" },
    ],
  },
  {
    group: "Administration",
    items: [
      { href: "/wms/audit", label: "Audit Log", icon: ScrollText, permission: "audit:read" },
      { href: "/wms/admin/users", label: "Users", icon: Users, permission: "user:read" },
    ],
  },
]

export function WmsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [user, setUser] = React.useState<SessionUser | null>(null)
  const [navOpen, setNavOpen] = React.useState(false)
  const [checking, setChecking] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false

    void api
      .get<{ authenticated: boolean; user: SessionUser | null }>("/api/auth/session")
      .then((result) => {
        if (cancelled) return
        if (!result.authenticated || !result.user) {
          router.replace("/auth/login")
          return
        }
        setUser(result.user)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiRequestError && error.isUnauthorized) {
          router.replace("/auth/login")
          return
        }
        // A network blip should not log anyone out.
        console.warn("[wms] session check failed:", error)
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })

    return () => {
      cancelled = true
    }
  }, [router])

  // Close the mobile drawer on navigation.
  React.useEffect(() => setNavOpen(false), [pathname])

  const logout = async () => {
    try {
      await api.post("/api/auth/logout", {})
    } finally {
      router.replace("/auth/login")
    }
  }

  const allowed = (item: NavItem) => Boolean(user?.permissions.includes(item.permission))

  return (
    <div className="flex min-h-screen bg-gray-50 dark:bg-[#0F0F12]">
      <a
        href="#wms-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-blue-600 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        Skip to main content
      </a>

      {/* Mobile scrim */}
      {navOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setNavOpen(false)} aria-hidden="true" />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-gray-200 bg-white transition-transform dark:border-[#1F1F23] dark:bg-[#131317] lg:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-gray-200 px-4 dark:border-[#1F1F23]">
          <Link href="/wms" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-600 text-white">
              <Warehouse className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold text-gray-900 dark:text-white">WMS</span>
          </Link>
          <Button variant="ghost" size="icon" className="h-8 w-8 lg:hidden" onClick={() => setNavOpen(false)}>
            <X className="h-4 w-4" />
            <span className="sr-only">Close navigation</span>
          </Button>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto p-3" aria-label="Warehouse navigation">
          {NAV.map((section) => {
            const visible = section.items.filter(allowed)
            if (visible.length === 0) return null

            return (
              <div key={section.group}>
                <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                  {section.group}
                </p>
                <ul className="space-y-0.5">
                  {visible.map((item) => {
                    const active = item.href === "/wms" ? pathname === "/wms" : pathname.startsWith(item.href)
                    const Icon = item.icon
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                            active
                              ? "bg-blue-50 font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                              : "text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-[#1F1F23] dark:hover:text-white",
                          )}
                        >
                          <Icon className="h-4 w-4 flex-shrink-0" />
                          <span className="flex-1">{item.label}</span>
                          {item.badge ? <Badge variant="secondary">{item.badge}</Badge> : null}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </nav>

        <div className="border-t border-gray-200 p-3 dark:border-[#1F1F23]">
          <ShieldCheck className="mb-2 h-4 w-4 text-green-600 dark:text-green-400" />
          <p className="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
            Every action is signed, rate-limited and written to the audit log.
          </p>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-gray-200 bg-white/95 px-4 backdrop-blur dark:border-[#1F1F23] dark:bg-[#131317]/95">
          <Button variant="ghost" size="icon" className="h-9 w-9 lg:hidden" onClick={() => setNavOpen(true)}>
            <Menu className="h-4 w-4" />
            <span className="sr-only">Open navigation</span>
          </Button>

          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-sm font-medium text-gray-900 dark:text-white">
              Warehouse Management System
            </span>
          </div>

          <div className="flex items-center gap-2">
            <ThemeToggle />
            {user && (
              <div className="flex items-center gap-2">
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="bg-blue-100 text-xs text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                    {user.name
                      .split(" ")
                      .map((part) => part[0])
                      .slice(0, 2)
                      .join("")
                      .toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="hidden text-right sm:block">
                  <p className="text-xs font-medium leading-tight text-gray-900 dark:text-white">{user.name}</p>
                  <p className="text-[11px] leading-tight text-gray-500 dark:text-gray-400">
                    {ROLE_LABELS[user.role]}
                  </p>
                </div>
                <Button variant="ghost" size="icon" className="h-9 w-9" onClick={logout} title="Sign out">
                  <LogOut className="h-4 w-4" />
                  <span className="sr-only">Sign out</span>
                </Button>
              </div>
            )}
          </div>
        </header>

        <main id="wms-main" className="flex-1 p-4 sm:p-6">
          {checking ? (
            <div className="flex h-64 items-center justify-center text-sm text-gray-500 dark:text-gray-400">
              Verifying session…
            </div>
          ) : (
            children
          )}
        </main>
      </div>
    </div>
  )
}
