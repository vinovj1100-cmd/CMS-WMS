import type { Role } from "@/lib/wms/types"

/**
 * Role-based access control.
 *
 * Permissions are capability strings (`resource:action`), checked at the API
 * boundary by `withAuth`. The UI reads the same table via `/api/auth/session`
 * so buttons hide themselves — but hiding is cosmetic, the API check is what
 * actually enforces anything.
 */

export const PERMISSIONS = [
  "inventory:read",
  "inventory:adjust",
  "inventory:transfer",
  "inbound:read",
  "inbound:create",
  "inbound:receive",
  "inbound:putaway",
  "outbound:read",
  "outbound:create",
  "outbound:allocate",
  "outbound:pick",
  "outbound:pack",
  "outbound:ship",
  "wave:read",
  "wave:release",
  "location:read",
  "location:manage",
  "cyclecount:read",
  "cyclecount:create",
  "cyclecount:count",
  "cyclecount:approve",
  "returns:read",
  "returns:approve",
  "returns:process",
  "replenishment:read",
  "replenishment:execute",
  "reports:read",
  "audit:read",
  "user:read",
  "user:manage",
  "settings:manage",
] as const

export type Permission = (typeof PERMISSIONS)[number]

const ALL = [...PERMISSIONS]

const readAll = PERMISSIONS.filter((p) => p.endsWith(":read"))

const OPERATOR_GRANTS: Permission[] = [
  "inventory:read",
  "inbound:read",
  "inbound:receive",
  "inbound:putaway",
  "outbound:read",
  "outbound:pick",
  "outbound:pack",
  "wave:read",
  "location:read",
  "cyclecount:read",
  "cyclecount:count",
  "replenishment:read",
  "replenishment:execute",
  "returns:read",
]

const SUPERVISOR_GRANTS: Permission[] = [
  ...OPERATOR_GRANTS,
  "inventory:transfer",
  "inbound:create",
  "outbound:create",
  "outbound:allocate",
  "outbound:ship",
  "wave:release",
  "cyclecount:create",
  "cyclecount:approve",
  "returns:approve",
  "returns:process",
  "reports:read",
  "audit:read",
  "user:read",
]

const MANAGER_GRANTS: Permission[] = [
  ...SUPERVISOR_GRANTS,
  "inventory:adjust",
  "location:manage",
  "settings:manage",
]

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ALL,
  warehouse_manager: MANAGER_GRANTS,
  supervisor: SUPERVISOR_GRANTS,
  operator: OPERATOR_GRANTS,
  viewer: readAll,
}

export const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[]

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrator",
  warehouse_manager: "Warehouse Manager",
  supervisor: "Supervisor",
  operator: "Operator",
  viewer: "Read-only Viewer",
}

const cache = new Map<Role, Set<Permission>>()

export function permissionsFor(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? []
}

export function hasPermission(role: Role, permission: Permission): boolean {
  let set = cache.get(role)
  if (!set) {
    set = new Set(ROLE_PERMISSIONS[role] ?? [])
    cache.set(role, set)
  }
  return set.has(permission)
}

export function hasAnyPermission(role: Role, permissions: Permission[]): boolean {
  return permissions.some((p) => hasPermission(role, p))
}

export function hasAllPermissions(role: Role, permissions: Permission[]): boolean {
  return permissions.every((p) => hasPermission(role, p))
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as string[]).includes(value)
}
