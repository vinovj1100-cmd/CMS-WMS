import type { Permission } from "@/lib/security/rbac"

/**
 * The dashboard requires reports:read; operators should land on a screen they
 * can use rather than getting a 403 immediately after signing in.
 */
export function defaultWorkspacePath(permissions: readonly Permission[]): "/wms" | "/wms/inventory" {
  if (!permissions.includes("reports:read") && permissions.includes("inventory:read")) {
    return "/wms/inventory"
  }
  return "/wms"
}
