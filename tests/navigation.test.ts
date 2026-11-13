import { describe, expect, it } from "vitest"

import Home, { dynamic } from "@/app/page"
import { permissionsFor } from "@/lib/security/rbac"
import { defaultWorkspacePath } from "@/lib/wms/navigation"
import type { Role } from "@/lib/wms/types"

describe("WMS landing page", () => {
  it("redirects the site root to the WMS", () => {
    expect(dynamic).toBe("force-dynamic")
    try {
      Home()
      throw new Error("Home did not redirect")
    } catch (error) {
      expect((error as { digest?: string }).digest).toMatch(/^NEXT_REDIRECT;[^;]+;\/wms;/)
    }
  })

  it.each(["admin", "warehouse_manager", "supervisor", "viewer"] as Role[])(
    "sends %s to the reporting dashboard",
    (role) => expect(defaultWorkspacePath(permissionsFor(role))).toBe("/wms"),
  )

  it("sends an operator without reports permission to inventory", () => {
    expect(defaultWorkspacePath(permissionsFor("operator"))).toBe("/wms/inventory")
  })

  it("does not assume inventory access when neither permission is granted", () => {
    expect(defaultWorkspacePath([])).toBe("/wms")
  })
})
